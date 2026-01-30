import { Command } from 'commander';
import { getAuthenticatedClient, findDriveFolderId } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import { basename } from 'path';
import ora from 'ora';

// Helper to format bytes (could be moved to a util for strict DRY)
function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export const listCommand = new Command('list')
    .description('List backups and storage usage')
    .action(async () => {
        const spinner = ora('Fetching backups...').start();
        try {
            const config = await loadProjectConfig();
            if (!config) {
                spinner.fail('Project not initialized. Run `gpack init` first.');
                return;
            }

            const auth = await getAuthenticatedClient();
            const drive = google.drive({ version: 'v3', auth });

            const folderPath = config.backupFolder || `GPACK/${basename(process.cwd())}`;
            const folderId = await findDriveFolderId(drive, folderPath);

            if (!folderId) {
                spinner.warn('No backups found (Folder not created yet).');
                return;
            }

            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed=false`,
                fields: 'files(id, name, size, createdTime)',
                orderBy: 'createdTime desc',
            });

            const files = res.data.files || [];
            spinner.stop();

            if (files.length === 0) {
                console.log(picocolors.yellow('No backups found.'));
                return;
            }

            console.log(picocolors.bold(`Backups for ${folderPath}:`));
            let totalSize = 0;

            files.forEach(file => {
                const size = parseInt(file.size || '0');
                totalSize += size;
                console.log(`${picocolors.cyan(file.name || 'Unknown')} - ${formatBytes(size)} - ${file.createdTime}`);
            });

            console.log();
            console.log(picocolors.bold(`Total Storage Used: ${formatBytes(totalSize)}`));
            console.log(`Total Backups: ${files.length}`);

        } catch (error: any) {
            spinner.fail(`Failed to list backups: ${error.message}`);
        }
    });
