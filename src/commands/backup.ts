import { Command } from 'commander';
import { createZipStream } from '../lib/zip.js';
import { getAuthenticatedClient, ensureDriveFolder } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import ora from 'ora';
import { basename } from 'path';
import { PassThrough } from 'stream';

export async function backupAction() {
    const spinner = ora('Preparing backup...').start();
    try {
        const config = await loadProjectConfig();
        if (!config) {
            spinner.fail('Project not initialized. Run `gpack init` first.');
            return;
        }

        spinner.text = 'Authenticating...';
        const auth = await getAuthenticatedClient();
        const drive = google.drive({ version: 'v3', auth });

        spinner.text = 'Resolving storage location...';
        const folderPath = config.backupFolder || `GPACK/${basename(process.cwd())}`;
        const folderId = await ensureDriveFolder(drive, folderPath);

        spinner.text = 'Zipping files...';
        const archive = await createZipStream(process.cwd());

        const fileName = `${basename(process.cwd())}_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

        spinner.text = `Uploading ${fileName}...`;

        const pass = new PassThrough();
        archive.pipe(pass);
        archive.finalize();

        await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId],
                mimeType: 'application/zip',
            },
            media: {
                mimeType: 'application/zip',
                body: pass,
            },
        });

        spinner.succeed(picocolors.green(`Backup uploaded successfully: ${fileName}`));

    } catch (error: any) {
        spinner.fail(`Backup failed: ${error.message}`);
        if (error.message.includes('Not logged in')) {
            console.log(picocolors.yellow('Try running `gpack login`'));
        }
    }
}

export const backupCommand = new Command('push')
    .alias('backup')
    .description('Backup current project to Google Drive')
    .action(backupAction);
