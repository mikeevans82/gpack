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
import { backupCommand } from './commands/backup.js';
import { listCommand } from './commands/list.js';
import { trimCommandFixed } from './commands/trim.js';
import { loadCommand } from './commands/load.js';

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
program.addCommand(loadCommand);

program.action(async () => {
    // If there are arguments but no command matched, it means unknown command 
    if (process.argv.length > 2) {
        console.error(`Unknown command: ${process.argv[2]}`);
        console.log('Run `gpack --help` for available commands.');
        process.exit(1);
    }

    const { runInteractiveMenu } = await import('./commands/menu.js');
    await runInteractiveMenu();
});

program.parse(process.argv);
