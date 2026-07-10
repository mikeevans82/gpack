import { Command } from 'commander';
import { getAuthenticatedClient, findDriveFolderId } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import { basename, join } from 'path';
import ora from 'ora';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export async function loadBackupAction() {
    const spinner = ora('Preparing to load backup...').start();
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
            spinner.fail('No backups folder found on Google Drive.');
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

        const choices = files.map(file => ({
            name: `${file.name} (${(parseInt(file.size || '0') / (1024 * 1024)).toFixed(2)} MB) - ${file.createdTime}`,
            value: file
        }));

        const { selectedBackup } = await inquirer.prompt([{
            type: 'list',
            name: 'selectedBackup',
            message: 'Select a backup to load/restore:',
            choices
        }]);

        const { confirmRestore } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmRestore',
            message: picocolors.red('WARNING: Loading this backup will overwrite current files in this directory. Proceed?'),
            default: false
        }]);

        if (!confirmRestore) {
            console.log('Restore cancelled.');
            return;
        }

        const downloadSpinner = ora(`Downloading ${selectedBackup.name}...`).start();
        const tempDir = join(process.cwd(), '.gpack', 'temp');
        await fs.ensureDir(tempDir);
        const tempZipPath = join(tempDir, 'restore.zip');

        const dest = fs.createWriteStream(tempZipPath);
        const response = await drive.files.get(
            { fileId: selectedBackup.id, alt: 'media' },
            { responseType: 'stream' }
        );

        await new Promise((resolve, reject) => {
            response.data
                .on('end', () => resolve(true))
                .on('error', (err: any) => reject(err))
                .pipe(dest);
        });

        downloadSpinner.text = 'Extracting backup files...';
        
        try {
            await execPromise(`tar -xf "${tempZipPath}"`);
            downloadSpinner.succeed(picocolors.green('Backup restored successfully!'));
        } catch (extractError: any) {
            downloadSpinner.fail(`Extraction failed: ${extractError.message}`);
        } finally {
            await fs.remove(tempZipPath).catch(() => {});
        }

    } catch (error: any) {
        spinner.fail(`Load backup failed: ${error.message}`);
    }
}

export const loadCommand = new Command('load')
    .alias('restore')
    .description('Load/restore a backup from Google Drive')
    .action(loadBackupAction);
