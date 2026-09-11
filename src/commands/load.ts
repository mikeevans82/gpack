import { Command } from 'commander';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import { join, dirname } from 'path';
import ora, { Ora } from 'ora';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import { getAuthenticatedClient } from '../lib/drive.js';
import { loadProjectConfig, getTempDir } from '../lib/config.js';
import { extractZip } from '../lib/zip.js';
import { loadIgnoreMatcher } from '../lib/ignore.js';
import { enumerateFiles } from '../lib/manifest.js';
import type { BackupManifest } from '../lib/manifest.js';
import {
    RestorePoint,
    downloadFileTo,
    listBlobs,
    listRestorePoints,
    openStoreForRead,
    readManifest,
    removeQuietly,
    BackupStore,
} from '../lib/backupStore.js';
import { resolveFolderPath } from '../lib/changes.js';
import { formatBytes } from '../lib/format.js';

/**
 * Rebuild the exact tree a manifest describes inside a staging directory.
 *
 * Each archive is extracted to its own directory and files are then copied by
 * the `from` recorded on the entry, so the result never depends on the order
 * archives are applied in and never picks up a stale copy of a path that
 * appears in more than one archive.
 */
async function stageManifest(
    store: BackupStore,
    manifest: BackupManifest,
    points: RestorePoint[],
    tempDir: string,
    spinner: Ora,
): Promise<{ stagingDir: string; missing: string[] }> {
    const stagingDir = join(tempDir, 'staging');
    await fs.ensureDir(stagingDir);

    const entries = Object.entries(manifest.entries);
    const neededArchives = new Set<string>();
    const neededBlobs = new Set<string>();
    for (const [, entry] of entries) {
        if (entry.blob) neededBlobs.add(entry.blob);
        else if (entry.from) neededArchives.add(entry.from);
    }

    const zipByName = new Map(points.map(p => [p.zip.name, p.zip]));
    const archiveDirs = new Map<string, string>();

    let index = 0;
    for (const archiveName of neededArchives) {
        index++;
        const zip = zipByName.get(archiveName);
        if (!zip) {
            throw new Error(
                `Archive ${archiveName} is missing from Drive, so this restore point is incomplete. ` +
                'It was most likely removed by a trim that predates dependency tracking.',
            );
        }

        spinner.text = `Downloading archive ${index}/${neededArchives.size}: ${archiveName}`;
        const zipPath = join(tempDir, 'archives', archiveName);
        await downloadFileTo(store, zip.id, zipPath);

        const outDir = join(tempDir, 'extracted', archiveName.replace(/\.zip$/i, ''));
        spinner.text = `Extracting ${archiveName}`;
        await extractZip(zipPath, outDir);
        archiveDirs.set(archiveName, outDir);
        await removeQuietly(zipPath);
    }

    const blobs = await listBlobs(store);
    const blobPaths = new Map<string, string>();
    index = 0;
    for (const blobId of neededBlobs) {
        index++;
        const blob = blobs.get(blobId);
        if (!blob) {
            throw new Error(`Stored file ${blobId} is missing from Drive, so this restore point is incomplete.`);
        }
        spinner.text = `Downloading large file ${index}/${neededBlobs.size}`;
        const blobPath = join(tempDir, 'blobs', blobId);
        await downloadFileTo(store, blob.id, blobPath);
        blobPaths.set(blobId, blobPath);
    }

    const missing: string[] = [];
    spinner.text = 'Assembling restore point...';
    for (const [rel, entry] of entries) {
        const source = entry.blob
            ? blobPaths.get(entry.blob)
            : entry.from
                ? join(archiveDirs.get(entry.from)!, rel)
                : undefined;

        if (!source || !(await fs.pathExists(source))) {
            missing.push(rel);
            continue;
        }

        const dest = join(stagingDir, rel);
        await fs.ensureDir(dirname(dest));
        await fs.copy(source, dest, { overwrite: true });
    }

    return { stagingDir, missing };
}

/** Delete working-directory files that the manifest does not contain. */
async function cleanExtraneous(manifest: BackupManifest): Promise<string[]> {
    const matcher = await loadIgnoreMatcher();
    const present = await enumerateFiles(process.cwd(), matcher);
    return present.filter(f => !(f.rel in manifest.entries)).map(f => f.rel);
}

export async function loadBackupAction(options: { clean?: boolean } = {}) {
    const spinner = ora('Preparing to load backup...').start();
    const tempDir = getTempDir();

    try {
        const config = await loadProjectConfig();
        if (!config) {
            spinner.fail('Project not initialized. Run `gpack init` first.');
            return;
        }

        const auth = await getAuthenticatedClient();
        const drive = google.drive({ version: 'v3', auth });

        const store = await openStoreForRead(drive, auth, resolveFolderPath(config));
        if (!store) {
            spinner.fail('No backups folder found on Google Drive.');
            return;
        }

        const points = await listRestorePoints(store);
        spinner.stop();

        if (points.length === 0) {
            console.log(picocolors.yellow('No backups found.'));
            return;
        }

        const choices = points.map(point => {
            const size = formatBytes(parseInt(point.zip.size || '0', 10));
            const tag = point.legacy ? picocolors.gray(' [legacy]') : '';
            return {
                name: `${point.zip.name} (${size}) - ${point.zip.createdTime}${tag}`,
                value: point,
            };
        });

        const { selected } = await inquirer.prompt([{
            type: 'list',
            name: 'selected',
            message: 'Select a backup to load/restore:',
            choices,
            pageSize: 15,
        }]);

        const point = selected as RestorePoint;
        const manifest = point.manifestFile ? await readManifest(store, point.manifestFile) : null;

        // Pre-upgrade archives are self-contained, so restore them the old way.
        if (!manifest) {
            const { confirmLegacy } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmLegacy',
                message: picocolors.red(
                    'This backup predates incremental support and has no manifest. ' +
                    'Its contents will be extracted over the current directory. Proceed?',
                ),
                default: false,
            }]);
            if (!confirmLegacy) {
                console.log('Restore cancelled.');
                return;
            }

            const legacySpinner = ora(`Downloading ${point.zip.name}...`).start();
            const zipPath = join(tempDir, point.zip.name);
            await downloadFileTo(store, point.zip.id, zipPath);
            legacySpinner.text = 'Extracting backup files...';
            await extractZip(zipPath, process.cwd());
            legacySpinner.succeed(picocolors.green('Backup restored successfully.'));
            return;
        }

        console.log();
        console.log(`${picocolors.bold('Restore point:')} ${manifest.name}`);
        console.log(
            `${picocolors.bold('Contents:')}      ${manifest.totals.files} files, ` +
            `${formatBytes(manifest.totals.bytes)}`,
        );
        console.log(`${picocolors.bold('Type:')}          ${manifest.type} (chain position ${manifest.chainIndex})`);

        let extraneous: string[] = [];
        if (options.clean) {
            extraneous = await cleanExtraneous(manifest);
            console.log(
                picocolors.red(
                    `${picocolors.bold('--clean:')}       ${extraneous.length} local file(s) not in this backup will be DELETED`,
                ),
            );
        }
        console.log();

        const { confirmRestore } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmRestore',
            message: picocolors.red('This will overwrite matching files in the current directory. Proceed?'),
            default: false,
        }]);

        if (!confirmRestore) {
            console.log('Restore cancelled.');
            return;
        }

        const restoreSpinner = ora('Restoring...').start();
        const { stagingDir, missing } = await stageManifest(store, manifest, points, tempDir, restoreSpinner);

        restoreSpinner.text = 'Copying files into the project...';
        await fs.copy(stagingDir, process.cwd(), { overwrite: true });

        if (options.clean) {
            // Recompute against the tree as it stands now, since the copy above
            // may have reinstated files the earlier pass listed as extraneous.
            const stillExtra = await cleanExtraneous(manifest);
            for (const rel of stillExtra) {
                await removeQuietly(join(process.cwd(), rel));
            }
            restoreSpinner.text = `Removed ${stillExtra.length} file(s) not in the backup.`;
        }

        if (missing.length > 0) {
            restoreSpinner.warn(
                picocolors.yellow(`Restored with ${missing.length} file(s) missing from storage:`),
            );
            missing.slice(0, 10).forEach(rel => console.log(picocolors.gray(`  ${rel}`)));
            if (missing.length > 10) console.log(picocolors.gray(`  ...and ${missing.length - 10} more`));
        } else {
            restoreSpinner.succeed(picocolors.green(`Restored ${manifest.totals.files} files from ${manifest.name}.`));
        }

    } catch (error: any) {
        spinner.fail(`Load backup failed: ${error.message}`);
    } finally {
        await removeQuietly(tempDir);
    }
}

export const loadCommand = new Command('load')
    .alias('restore')
    .description('Load/restore a backup from Google Drive')
    .option('--clean', 'Also delete local files that are not part of the selected backup')
    .action(async (options) => {
        await loadBackupAction({ clean: Boolean(options.clean) });
    });
