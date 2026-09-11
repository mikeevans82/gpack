import { Command } from 'commander';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import ora from 'ora';
import inquirer from 'inquirer';
import { getAuthenticatedClient } from '../lib/drive.js';
import { loadProjectConfig } from '../lib/config.js';
import type { BackupManifest } from '../lib/manifest.js';
import {
    BackupStore,
    RestorePoint,
    deleteDriveFile,
    listBlobs,
    listRestorePoints,
    openStoreForRead,
    readManifest,
} from '../lib/backupStore.js';
import { resolveFolderPath } from '../lib/changes.js';
import { formatBytes } from '../lib/format.js';

export interface LoadedPoint {
    point: RestorePoint;
    manifest: BackupManifest | null;
}

/**
 * Archives and blobs that must survive if these restore points are kept.
 *
 * An incremental backup carries entries whose bytes live in older archives, so
 * deleting an old archive can silently break a newer restore point. Keeping a
 * point therefore pins everything it references.
 */
export function collectReferences(kept: LoadedPoint[]): { archives: Set<string>; blobs: Set<string> } {
    const archives = new Set<string>();
    const blobs = new Set<string>();

    for (const { point, manifest } of kept) {
        // A point always pins its own archive, including an incremental that
        // happened to pack nothing.
        archives.add(point.zip.name);
        if (!manifest) continue;

        for (const entry of Object.values(manifest.entries)) {
            if (entry.blob) blobs.add(entry.blob);
            else if (entry.from) archives.add(entry.from);
        }
    }

    return { archives, blobs };
}

async function loadPoints(store: BackupStore, points: RestorePoint[]): Promise<LoadedPoint[]> {
    const loaded: LoadedPoint[] = [];
    for (const point of points) {
        const manifest = point.manifestFile ? await readManifest(store, point.manifestFile) : null;
        loaded.push({ point, manifest });
    }
    return loaded;
}

export interface TrimPlan {
    kept: LoadedPoint[];
    removed: LoadedPoint[];
    /** Selected for removal but retained because a survivor depends on them. */
    pinned: LoadedPoint[];
}

/**
 * Work out what can actually go.
 *
 * A surviving incremental holds bytes in older archives, so those archives are
 * retained together with their manifests. Keeping the manifest matters: an
 * archive without one would still be listed as a restore point but would only
 * ever restore the fragment of the tree it happened to pack. Retaining a point
 * can in turn pin its own dependencies, so the set is expanded to a fixpoint.
 */
export function planTrim(all: LoadedPoint[], selectedNames: Set<string>): TrimPlan {
    const kept = all.filter(p => !selectedNames.has(p.point.zip.name));
    const pinned: LoadedPoint[] = [];

    for (;;) {
        const { archives } = collectReferences([...kept, ...pinned]);
        const newlyPinned = all.filter(p =>
            selectedNames.has(p.point.zip.name) &&
            !pinned.includes(p) &&
            archives.has(p.point.zip.name),
        );
        if (newlyPinned.length === 0) break;
        pinned.push(...newlyPinned);
    }

    const survivors = new Set([...kept, ...pinned].map(p => p.point.zip.name));
    const removed = all.filter(p => !survivors.has(p.point.zip.name));
    return { kept, removed, pinned };
}

/** Delete the chosen restore points, then everything they alone were holding. */
async function applyTrim(
    store: BackupStore,
    all: LoadedPoint[],
    selectedNames: Set<string>,
): Promise<void> {
    const plan = planTrim(all, selectedNames);
    const { blobs } = collectReferences([...plan.kept, ...plan.pinned]);

    const spinner = ora('Deleting backups...').start();
    let freed = 0;

    for (const { point } of plan.removed) {
        if (point.manifestFile) {
            await deleteDriveFile(store, point.manifestFile.id);
        }
        freed += parseInt(point.zip.size || '0', 10);
        await deleteDriveFile(store, point.zip.id);
    }

    spinner.text = 'Collecting unreferenced large files...';
    const storedBlobs = await listBlobs(store);
    let blobsDeleted = 0;
    for (const [blobId, file] of storedBlobs) {
        if (blobs.has(blobId)) continue;
        freed += parseInt(file.size || '0', 10);
        await deleteDriveFile(store, file.id);
        blobsDeleted++;
    }

    spinner.succeed(
        picocolors.green(
            `Trim complete. Removed ${plan.removed.length} restore point(s), freeing ${formatBytes(freed)}.`,
        ),
    );
    if (blobsDeleted > 0) {
        console.log(picocolors.gray(`Collected ${blobsDeleted} unreferenced large file(s).`));
    }
    if (plan.pinned.length > 0) {
        console.log(
            picocolors.yellow(
                `${plan.pinned.length} older backup(s) were kept because newer ones still depend on their contents.`,
            ),
        );
        plan.pinned.forEach(p => console.log(picocolors.gray(`  ${p.point.zip.name}`)));
    }
}

export async function trimAction(options: { auto?: string | boolean } = {}) {
    const spinner = ora('Fetching backups...').start();
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
            spinner.warn('No backups found.');
            return;
        }

        const points = await listRestorePoints(store);
        if (points.length === 0) {
            spinner.stop();
            console.log(picocolors.yellow('No backups to trim.'));
            return;
        }

        spinner.text = 'Reading manifests...';
        const all = await loadPoints(store, points);
        spinner.stop();

        if (options.auto !== undefined) {
            const keepCount = typeof options.auto === 'string' ? parseInt(options.auto, 10) : 5;
            if (!Number.isFinite(keepCount) || keepCount < 1) {
                console.log(picocolors.red('--auto needs a positive number of backups to keep.'));
                return;
            }
            if (all.length <= keepCount) {
                console.log(
                    picocolors.green(
                        `Total backups (${all.length}) is within the limit (${keepCount}). No action taken.`,
                    ),
                );
                return;
            }
            const selected = new Set(all.slice(keepCount).map(p => p.point.zip.name));
            console.log(
                picocolors.cyan(
                    `Auto-trimming: keeping the latest ${keepCount}, removing up to ${selected.size} older restore point(s).`,
                ),
            );
            await applyTrim(store, all, selected);
            return;
        }

        console.log(`Found ${all.length} backups.`);
        const choices = all.map(({ point, manifest }) => {
            const size = formatBytes(parseInt(point.zip.size || '0', 10));
            const kind = manifest ? manifest.type : 'legacy';
            return {
                name: `${point.zip.name} (${size}, ${kind}) - ${point.zip.createdTime}`,
                value: point.zip.name,
                checked: false,
            };
        });

        const answers = await inquirer.prompt([{
            type: 'checkbox',
            name: 'namesToDelete',
            message: 'Select backups to DELETE (Space to select, Enter to confirm):',
            choices,
            pageSize: 15,
        }]);

        if (answers.namesToDelete.length === 0) {
            console.log('No backups selected.');
            return;
        }

        const selected = new Set<string>(answers.namesToDelete);
        const plan = planTrim(all, selected);

        if (plan.pinned.length > 0) {
            console.log(
                picocolors.yellow(
                    `\n${plan.pinned.length} of the selected backups hold data that newer ones still need, ` +
                    'so they will be kept:',
                ),
            );
            plan.pinned.forEach(p => console.log(picocolors.gray(`  ${p.point.zip.name}`)));
        }

        if (plan.removed.length === 0) {
            console.log(picocolors.yellow('Nothing can be deleted: every selected backup is still depended on.'));
            return;
        }

        const confirm = await inquirer.prompt([{
            type: 'confirm',
            name: 'sure',
            message: `Delete ${plan.removed.length} restore point(s)?`,
            default: false,
        }]);

        if (!confirm.sure) {
            console.log('Trim cancelled.');
            return;
        }

        await applyTrim(store, all, selected);

    } catch (error: any) {
        spinner.fail(`Failed: ${error.message}`);
    }
}

export const trimCommandFixed = new Command('trim')
    .description('Trim old backups')
    .option('--auto [keep]', 'Automatically keep the last N backups (default 5 if value omitted)')
    .action(trimAction);
