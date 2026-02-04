import { Command } from 'commander';
import { logout } from '../lib/drive.js';

export const logoutCommand = new Command('logout')
    .description('Log out and remove stored credentials')
    .action(() => {
        logout();
    });
