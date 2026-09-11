import picocolors from 'picocolors';
import { basename, join, dirname } from 'path';
import ora from 'ora';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import { fileURLToPath } from 'url';
import { loadProjectConfig } from '../lib/config.js';
import { checkIfBackupNeeded, resolveFolderPath, BackupStatus } from '../lib/changes.js';
import { backupAction } from './backup.js';
import { trimAction } from './trim.js';
import { loadBackupAction } from './load.js';

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

        console.log(`${picocolors.bold('Backup Directory:')} ${picocolors.green(resolveFolderPath(config))}`);

        const accountEmail = config.accountEmail || 'Not locked to a specific account (will prompt or use default)';
        console.log(`${picocolors.bold('Linked Account:')}   ${picocolors.green(accountEmail)}`);

        const spinner = ora('Checking backup status on Google Drive...').start();
        let status: BackupStatus;
        try {
            status = await checkIfBackupNeeded();
            spinner.stop();
        } catch (err: any) {
            spinner.stop();
            console.log(picocolors.red(`\nError checking backup status: ${err.message}`));
            status = {
                needed: true,
                reason: err.message,
                lastBackupDate: null,
                lastBackupFile: null,
                diff: null,
                manifest: null,
            };
        }

        if (status.lastBackupDate) {
            console.log(
                `${picocolors.bold('Last Backup:')}       ${picocolors.green(status.lastBackupFile ?? 'unknown')}` +
                ` (${status.lastBackupDate.toLocaleString()})`,
            );
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
                { name: 'Make a Full Backup', value: 'backup-full' },
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
        } else if (choice === 'backup-full') {
            await backupAction(true, true);
            await inquirer.prompt([{ type: 'input', name: 'wait', message: '\nPress Enter to continue...' }]);
        } else if (choice === 'trim') {
            await trimAction();
            await inquirer.prompt([{ type: 'input', name: 'wait', message: '\nPress Enter to continue...' }]);
        } else if (choice === 'load') {
            const { clean } = await inquirer.prompt([{
                type: 'confirm',
                name: 'clean',
                message: 'Also delete local files that are not part of the selected backup?',
                default: false
            }]);
            await loadBackupAction({ clean });
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
