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
import { logoutCommand } from './commands/logout.js';
import { backupCommand, backupAction } from './commands/backup.js';
import { listCommand } from './commands/list.js';
import { trimCommandFixed } from './commands/trim.js';

program
    .name('gpack')
    .description('Backup your coding projects to Google Drive')
    .version(packageJson.version);

program.addCommand(initCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(backupCommand);
program.addCommand(listCommand);
program.addCommand(trimCommandFixed);

program.action(async () => {
    // If there are arguments but no command matched, it means unknown command 
    // because we are in the default action handler.
    // However, Commander's action handler on the root object is called when 
    // no other command matches.

    // We only want to trigger backup if there are NO arguments (just `gpack`).
    if (process.argv.length > 2) {
        // argv[0] is node, argv[1] is script, argv[2+] are args.
        // If args exist, user typed `gpack something`.
        console.error(`Unknown command: ${process.argv[2]}`);
        console.log('Run `gpack --help` for available commands.');
        process.exit(1);
    }

    await backupAction();
});

program.parse(process.argv);
