import { Command } from 'commander';
import { loginFlow } from '../lib/drive.js';
import picocolors from 'picocolors';

export const loginCommand = new Command('login')
    .description('Connect to Google Drive')
    .action(async () => {
        try {
            await loginFlow();
        } catch (error: any) {
            console.error(picocolors.red('Login failed:'), error.message);
        }
    });
