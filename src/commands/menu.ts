import { Command } from 'commander';
import { getAuthenticatedClient, findDriveFolderId } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import { basename, join, dirname } from 'path';
import ora from 'ora';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { backupAction } from './backup.js';
import { trimAction } from './trim.js';
import { loadBackupAction } from './load.js';

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

async function checkIfBackupNeeded(): Promise<{
    needed: boolean;
    reason: string;
    lastBackupDate: Date | null;
    lastBackupFile: string | null;
}> {
    const config = await loadProjectConfig();
    if (!config) {
        return { needed: true, reason: 'Project not initialized', lastBackupDate: null, lastBackupFile: null };
    }
    
    let auth;
    try {
        auth = await getAuthenticatedClient();
    } catch {
        return { needed: true, reason: 'Not logged in', lastBackupDate: null, lastBackupFile: null };
    }
    
    const drive = google.drive({ version: 'v3', auth });
    const folderPath = config.backupFolder || `GPACK/${basename(process.cwd())}`;
    const folderId = await findDriveFolderId(drive, folderPath);
    if (!folderId) {
        return { needed: true, reason: 'No backups folder found on Google Drive', lastBackupDate: null, lastBackupFile: null };
    }
    
    const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime desc',
    });
    
    const files = res.data.files || [];
    if (files.length === 0) {
        return { needed: true, reason: 'No backups found on Google Drive', lastBackupDate: null, lastBackupFile: null };
    }
    
    const lastBackupDate = new Date(files[0].createdTime!);
    const lastBackupFile = files[0].name || null;
    
    const gitIsActive = await isGitActive(process.cwd());
    if (gitIsActive) {
        const lastCommitStr = await runGitCommand('git log -1 --format=%cI', process.cwd());
        if (lastCommitStr) {
            const lastCommitDate = new Date(lastCommitStr);
            if (lastCommitDate > lastBackupDate) {
                return { needed: true, reason: `New commits since last backup (${lastCommitStr})`, lastBackupDate, lastBackupFile };
            }
        }
        const gitStatus = await runGitCommand('git status --porcelain', process.cwd());
        if (gitStatus) {
            return { needed: true, reason: 'Uncommitted changes present', lastBackupDate, lastBackupFile };
        }
    } else {
        const latestFileTime = await getLatestFileModificationTime(process.cwd());
        if (latestFileTime && latestFileTime > lastBackupDate) {
            return { needed: true, reason: `Files modified since last backup (${latestFileTime.toISOString()})`, lastBackupDate, lastBackupFile };
        }
    }
    
    return { needed: false, reason: 'No changes since last backup', lastBackupDate, lastBackupFile };
}

export async function runInteractiveMenu() {
    let exitMenu = false;
    
    while (!exitMenu) {
        console.clear();
        console.log(picocolors.cyan(picocolors.bold('=== gpack CLI Interactive Menu ===\n')));
        
        const config = await loadProjectConfig();
        if (!config) {
            console.log(picocolors.yellow('Project is not initialized.'));
            const { initNow } = await inquirer.prompt([{
                type: 'confirm',
                name: 'initNow',
                message: 'Would you like to run `gpack init` to initialize this project?',
                default: true
            }]);
            
            if (initNow) {
                const { initAction } = await import('./init.js');
                await initAction();
                await inquirer.prompt([{ type: 'input', name: 'wait', message: 'Press Enter to continue...' }]);
            } else {
                break;
            }
            continue;
        }
        
        console.log(`${picocolors.bold('Backup Directory:')} ${picocolors.green(config.backupFolder || `GPACK/${basename(process.cwd())}`)}`);
        
        let accountEmail = config.accountEmail || 'Not locked to a specific account (will prompt or use default)';
        console.log(`${picocolors.bold('Linked Account:')}   ${picocolors.green(accountEmail)}`);
        
        const spinner = ora('Checking backup status on Google Drive...').start();
        let status;
        try {
            status = await checkIfBackupNeeded();
            spinner.stop();
        } catch (err: any) {
            spinner.stop();
            console.log(picocolors.red(`\nError checking backup status: ${err.message}`));
            status = { needed: true, reason: err.message, lastBackupDate: null, lastBackupFile: null };
        }
        
        if (status.lastBackupDate) {
            console.log(`${picocolors.bold('Last Backup:')}       ${picocolors.green(status.lastBackupFile)} (${status.lastBackupDate.toLocaleString()})`);
        } else {
            console.log(`${picocolors.bold('Last Backup:')}       ${picocolors.red('None found')}`);
        }
        
        if (status.needed) {
            console.log(`${picocolors.bold('Backup Status:')}     ${picocolors.yellow('Backup Needed')} (${status.reason})`);
        } else {
            console.log(`${picocolors.bold('Backup Status:')}     ${picocolors.green('Up to Date')} (${status.reason})`);
        }
        console.log();
        
        const { choice } = await inquirer.prompt([{
            type: 'list',
            name: 'choice',
            message: 'Select an option:',
            choices: [
                { name: 'Make a Backup', value: 'backup' },
                { name: 'Trim Old Backups', value: 'trim' },
                { name: 'Load / Restore a Backup', value: 'load' },
                { name: 'View README', value: 'readme' },
                { name: 'Exit', value: 'exit' }
            ]
        }]);
        
        if (choice === 'exit') {
            exitMenu = true;
        } else if (choice === 'backup') {
            if (!status.needed) {
                const { forceBackup } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'forceBackup',
                    message: picocolors.yellow('No changes detected since last backup. Do you want to force a backup anyway?'),
                    default: false
                }]);
                if (forceBackup) {
                    await backupAction(true);
                }
            } else {
                await backupAction(false);
            }
            await inquirer.prompt([{ type: 'input', name: 'wait', message: '\nPress Enter to continue...' }]);
        } else if (choice === 'trim') {
            await trimAction();
            await inquirer.prompt([{ type: 'input', name: 'wait', message: '\nPress Enter to continue...' }]);
        } else if (choice === 'load') {
            await loadBackupAction();
            await inquirer.prompt([{ type: 'input', name: 'wait', message: '\nPress Enter to continue...' }]);
        } else if (choice === 'readme') {
            try {
                const readmePath = join(dirname(fileURLToPath(import.meta.url)), '../../../README.md');
                if (await fs.pathExists(readmePath)) {
                    const content = await fs.readFile(readmePath, 'utf-8');
                    console.clear();
                    console.log(content);
                } else {
                    console.log(picocolors.red('README.md not found.'));
                }
            } catch (err: any) {
                console.log(picocolors.red(`Failed to load README: ${err.message}`));
            }
            await inquirer.prompt([{ type: 'input', name: 'wait', message: '\nPress Enter to continue...' }]);
        }
    }
}
