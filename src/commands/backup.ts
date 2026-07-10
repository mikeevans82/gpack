import { Command } from 'commander';
import { createZipStream } from '../lib/zip.js';
import { getAuthenticatedClient, ensureDriveFolder } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import ora from 'ora';
import { basename, join } from 'path';
import { PassThrough } from 'stream';
import fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

async function runGitCommand(cmd: string, cwd: string): Promise<string> {
    try {
        const { stdout } = await execPromise(cmd, { cwd });
        return stdout.trim();
    } catch {
        return '';
    }
}

async function isGitActive(cwd: string): Promise<boolean> {
    try {
        const isWorkTree = await runGitCommand('git rev-parse --is-inside-work-tree', cwd);
        return isWorkTree === 'true';
    } catch {
        return false;
    }
}

async function getLatestFileModificationTime(dir: string): Promise<Date | null> {
    let latestTime: Date | null = null;
    const excludeDirs = ['.git', '.gpack', 'node_modules', 'dist', 'coverage', 'bin', 'obj', 'out', 'temp', 'tmp'];

    async function walk(currentDir: string) {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (!excludeDirs.includes(entry.name)) {
                    await walk(fullPath);
                }
            } else {
                const stat = await fs.stat(fullPath);
                if (!latestTime || stat.mtime > latestTime) {
                    latestTime = stat.mtime;
                }
            }
        }
    }

    try {
        await walk(dir);
    } catch {
        // Ignore read errors
    }
    return latestTime;
}

export async function backupAction(force = false) {
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

        // Fetch backups to see the last backup date
        spinner.text = 'Checking for changes...';
        const res = await drive.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            fields: 'files(id, name, size, createdTime)',
            orderBy: 'createdTime desc',
        });
        const files = res.data.files || [];
        let lastBackupDate: Date | null = null;
        if (files.length > 0) {
            lastBackupDate = new Date(files[0].createdTime!);
        }

        if (lastBackupDate && !force) {
            let changed = false;
            let changeReason = '';
            
            const gitIsActive = await isGitActive(process.cwd());
            if (gitIsActive) {
                const lastCommitStr = await runGitCommand('git log -1 --format=%cI', process.cwd());
                if (lastCommitStr) {
                    const lastCommitDate = new Date(lastCommitStr);
                    if (lastCommitDate > lastBackupDate) {
                        changed = true;
                        changeReason = `New git commit since last backup (${lastCommitStr})`;
                    }
                }
                const gitStatus = await runGitCommand('git status --porcelain', process.cwd());
                if (gitStatus) {
                    changed = true;
                    changeReason = 'Uncommitted changes present';
                }
            } else {
                const latestFileTime = await getLatestFileModificationTime(process.cwd());
                if (latestFileTime && latestFileTime > lastBackupDate) {
                    changed = true;
                    changeReason = `Files modified since last backup (Latest file modified at ${latestFileTime.toISOString()})`;
                }
            }
            
            if (!changed) {
                spinner.fail('No changes detected since the last backup. Backup aborted.');
                console.log(picocolors.yellow('To force a backup, run `gpack push --force` or make a change.'));
                return;
            } else {
                spinner.text = `Changes detected (${changeReason}). Zipping...`;
            }
        } else {
            spinner.text = 'Zipping files...';
        }

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
    .option('-f, --force', 'Force backup even if no changes are detected')
    .action(async (options) => {
        await backupAction(options.force);
    });
