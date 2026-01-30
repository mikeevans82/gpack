import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// specific way to read package.json in ESM
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

import { initCommand } from './commands/init.js';
import { loginCommand } from './commands/login.js';
import { backupCommand, backupAction } from './commands/backup.js';
import { listCommand } from './commands/list.js';
import { trimCommandFixed } from './commands/trim.js';

program
    .name('gpack')
    .description('Backup your coding projects to Google Drive')
    .version(packageJson.version);

program.addCommand(initCommand);
program.addCommand(loginCommand);
program.addCommand(backupCommand);
program.addCommand(listCommand);
program.addCommand(trimCommandFixed);

program.action(async () => {
    // Check if user just ran `gpack` without arguments
    // If so, trigger backup
    // But we should check if they passed options that commander processed?
    // Commander default action is triggered if no sub-command matches.

    // We want `gpack` to just run backup.
    await backupAction();
});

program.parse(process.argv);
