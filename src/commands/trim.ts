import { Command } from 'commander';
import { getAuthenticatedClient, findDriveFolderId } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import { basename } from 'path';
import ora from 'ora';
import inquirer from 'inquirer';

export const trimCommand = new Command('trim')
    .description('Trim old backups')
    .option('--auto [keep]', 'Automatically keep only the last N backups', '5')
    .action(async (options) => {
        const spinner = ora('Fetching backups...').start();
        try {
            const config = await loadProjectConfig();
            if (!config) {
                spinner.fail('Project not initialized. Run `gpack init` first.');
                return;
            }

            const auth = await getAuthenticatedClient();
            const drive = google.drive({ version: 'v3', auth });

            const folderPath = config.backupFolder || `GPACK/${basename(process.cwd())}`;
            const folderId = await findDriveFolderId(drive, folderPath);

            if (!folderId) {
                spinner.warn('No backups found.');
                return;
            }

            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed=false`,
                fields: 'files(id, name, createdTime)',
                orderBy: 'createdTime desc', // Newest first
            });

            const files = res.data.files || [];
            spinner.stop();

            if (files.length === 0) {
                console.log(picocolors.yellow('No backups to trim.'));
                return;
            }

            // If auto flag is provided (note: options.auto might be boolean true if flag present with no value, or string value)
            // Commander handles optional values: if user says `--auto 10`, it is '10'. If `--auto`, it is true (but default '5' might apply if defined?)
            // Wait, .option('--auto [keep]', ..., '5') means if user types --auto, it uses '5'? No.
            // If user types --auto, it gets the value if provided, or logic depends on flag definition.
            // '[keep]' means optional value.
            // If user types `gpack trim --auto`, value is true? Actually if optional arg is missing, it might be true.
            // Let's coerce.

            // Checking how commander handles this:
            // If flag is `--auto [keep]`, and default is '5'.
            // `gpack trim` -> auto is undefined (or default '5' ONLY if it was <keep> mandatory arg? No.)
            // Actually, if I run `gpack trim`, `options.auto` will be the default '5'?
            // No, default is used if the option is NOT specified?
            // Wait, usually default value in .option() applies if the flag is NOT provided at all? Or if provided without value?

            // Let's simplify: `gpack trim` (interactive). `gpack trim --auto 5` (keep 5).
            // .option('--auto <keep>') would make it mandatory if flag is present.

            // Let's handle arguments manually or assume:
            // If user provided `--auto`, we do auto.
            // If they provided `--auto 10`, we keep 10.

            const isAuto = options.auto !== undefined && options.auto !== true; // Logic: if --auto is flag, it might be string '5' (default) or value user provided.
            // Commander 7+ behavior:
            // .option('--auto [keep]', 'desc', '5')
            // If I run `gpack trim`, options.auto is '5'.
            // This is not what I want. I want interactive default.

            // Let's remove default from option definition to distinguish.
            // .option('--auto <keep>', 'Auto trim keeping N backups')

            // But I want `gpack trim --auto` to default to 5.
            // .option('--auto [keep]', 'Auto keep N', '5') -> if user runs `gpack trim`, options.auto is '5'. This forces auto always?
            // Ah, default value applies if option is NOT parsed?
            // Yes. So current definition makes `options.auto` always '5'.

            // Fix:
            // .option('--auto [keep]', 'Auto trim')
            // no default.

        } catch (error: any) {
            spinner.fail(`Failed: ${error.message}`);
        }
    });


// Redefining the command with correct logic
export const trimCommandFixed = new Command('trim')
    .description('Trim old backups')
    .option('--auto [keep]', 'Automatically keep the last N backups (default 5 if value omitted)')
    .action(async (options) => {
        const spinner = ora('Fetching backups...').start();
        try {
            const config = await loadProjectConfig();
            if (!config) {
                spinner.fail('Project not initialized. Run `gpack init` first.');
                return;
            }

            const auth = await getAuthenticatedClient();
            const drive = google.drive({ version: 'v3', auth });
            const folderPath = config.backupFolder || `GPACK/${basename(process.cwd())}`;
            const folderId = await findDriveFolderId(drive, folderPath);

            if (!folderId) {
                spinner.warn('No backups found.');
                return;
            }

            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed=false`,
                fields: 'files(id, name, createdTime)',
                orderBy: 'createdTime desc', // Newest first
            });

            const files = res.data.files || [];
            spinner.stop();

            if (files.length === 0) {
                console.log(picocolors.yellow('No backups to trim.'));
                return;
            }

            // Determine mode
            let keepCount = 5;
            let runAuto = false;

            // if options.auto is present (true or string)
            if (options.auto !== undefined) {
                runAuto = true;
                if (typeof options.auto === 'string') {
                    keepCount = parseInt(options.auto, 10);
                } else if (options.auto === true) {
                    keepCount = 5; // default for flag
                }
            }

            if (runAuto) {
                if (files.length <= keepCount) {
                    console.log(picocolors.green(`Total backups (${files.length}) is within the limit (${keepCount}). No action taken.`));
                    return;
                }
                const toDelete = files.slice(keepCount);
                console.log(picocolors.cyan(`Auto-trimming: Keeping latest ${keepCount}, deleting ${toDelete.length} old backups...`));

                for (const file of toDelete) {
                    if (file.id) {
                        await drive.files.delete({ fileId: file.id });
                        console.log(picocolors.gray(`Deleted ${file.name}`));
                    }
                }
                console.log(picocolors.green('Trim complete.'));
            } else {
                // Interactive mode
                // Show list with checkboxes?
                // Or ask "Keep how many?"

                console.log(`Found ${files.length} backups.`);
                const choices = files.map(f => ({
                    name: `${f.name} (${f.createdTime})`,
                    value: f.id,
                    checked: false
                }));

                const answers = await inquirer.prompt([
                    {
                        type: 'checkbox',
                        name: 'filesToDelete',
                        message: 'Select backups to DELETE (Space to select, Enter to confirm):',
                        choices: choices,
                        pageSize: 10
                    }
                ]);

                if (answers.filesToDelete.length === 0) {
                    console.log('No files deletion selected.');
                    return;
                }

                const confirm = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'sure',
                    message: `Are you sure you want to delete ${answers.filesToDelete.length} backups?`,
                    default: false
                }]);

                if (confirm.sure) {
                    const spinnerDel = ora('Deleting...').start();
                    for (const id of answers.filesToDelete) {
                        await drive.files.delete({ fileId: id });
                    }
                    spinnerDel.succeed(`Deleted ${answers.filesToDelete.length} backups.`);
                }
            }

        } catch (error: any) {
            spinner.fail(`Failed: ${error.message}`);
        }
    });
