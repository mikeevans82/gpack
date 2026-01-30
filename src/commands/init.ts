import { Command } from 'commander';
import inquirer from 'inquirer';
import { basename, join } from 'path';
import picocolors from 'picocolors';
import { createDefaultIgnore, loadProjectConfig, saveProjectConfig } from '../lib/config.js';

export const initCommand = new Command('init')
    .description('Initialize gpack in the current project')
    .action(async () => {
        const existingConfig = await loadProjectConfig();
        if (existingConfig) {
            console.log(picocolors.yellow('gpack is already initialized in this project.'));
            // Optional: ask to re-configure
            const { reconfigure } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'reconfigure',
                    message: 'Do you want to re-configure?',
                    default: false,
                },
            ]);
            if (!reconfigure) return;
        }

        const currentDirName = basename(process.cwd());
        const defaultBackupFolder = `GPACK/${currentDirName}`;

        console.log(picocolors.cyan('Initializing gpack...'));

        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'backupFolder',
                message: 'Where should backups be stored in Google Drive?',
                default: defaultBackupFolder,
            },
        ]);

        await saveProjectConfig({
            backupFolder: answers.backupFolder,
        });

        await createDefaultIgnore();

        console.log(picocolors.green('✔ Configuration saved to .gpack/config.json'));
        console.log(picocolors.green('✔ .gpackignore created (if it didn\'t exist)'));
        console.log(picocolors.bold('Project is ready for backup! Run `gpack login` next if you haven\'t authenticated.'));
    });
