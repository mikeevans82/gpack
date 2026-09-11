import { Command } from 'commander';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import { listBlobs, listRestorePoints, openStoreForRead, readManifest } from '../lib/backupStore.js';
import { resolveFolderPath } from '../lib/changes.js';
import { formatBytes } from '../lib/format.js';

export const listCommand = new Command('list')
    .description('List backups and storage usage')
    .action(async () => {
        const spinner = ora('Fetching backups...').start();
        try {
            const config = await loadProjectConfig();
            if (!config) {
                spinner.fail('Project not initialized. Run `gpack init` first.');
                return;
            }

            const auth = await getAuthenticatedClient();
            const drive = google.drive({ version: 'v3', auth });

            const folderPath = resolveFolderPath(config);
            const store = await openStoreForRead(drive, auth, folderPath);
            if (!store) {
                spinner.warn('No backups found (folder not created yet).');
                return;
            }

            const points = await listRestorePoints(store);
            if (points.length === 0) {
                spinner.stop();
                console.log(picocolors.yellow('No backups found.'));
                return;
            }

            spinner.text = 'Reading manifests...';
            const rows = [];
            for (const point of points) {
                const manifest = point.manifestFile ? await readManifest(store, point.manifestFile) : null;
                rows.push({ point, manifest });
            }

            const blobs = await listBlobs(store);
            spinner.stop();

            console.log(picocolors.bold(`Backups for ${folderPath}:`));
            console.log();

            let archiveBytes = 0;
            for (const { point, manifest } of rows) {
                const size = parseInt(point.zip.size || '0', 10);
                archiveBytes += size;

                const label = manifest
                    ? manifest.type === 'full'
                        ? picocolors.green('full')
                        : picocolors.cyan(`incr +${manifest.chainIndex}`)
                    : picocolors.gray('legacy');

                const contents = manifest
                    ? `${manifest.totals.files} files, ${formatBytes(manifest.totals.bytes)} tracked`
                    : 'contents unknown';

                console.log(`${picocolors.bold(point.zip.name)}  ${label}`);
                console.log(
                    picocolors.gray(`  ${point.zip.createdTime}  archive ${formatBytes(size)}  ${contents}`),
                );
            }

            let blobBytes = 0;
            for (const blob of blobs.values()) {
                blobBytes += parseInt(blob.size || '0', 10);
            }

            const newest = rows[0]?.manifest;
            console.log();
            console.log(`${picocolors.bold('Restore points:')}   ${rows.length}`);
            console.log(`${picocolors.bold('Archives:')}         ${formatBytes(archiveBytes)}`);
            console.log(
                `${picocolors.bold('Large files:')}      ${formatBytes(blobBytes)} across ${blobs.size} object(s)`,
            );
            console.log(`${picocolors.bold('Total on Drive:')}   ${formatBytes(archiveBytes + blobBytes)}`);
            if (newest) {
                console.log(
                    `${picocolors.bold('Latest snapshot:')}  ${formatBytes(newest.totals.bytes)} of project data`,
                );
            }

        } catch (error: any) {
            spinner.fail(`Failed to list backups: ${error.message}`);
        }
    });
