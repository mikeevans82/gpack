import { Command } from 'commander';
import { google } from 'googleapis';
import picocolors from 'picocolors';
import ora from 'ora';
import { basename, join } from 'path';
import fs from 'fs-extra';
import { createZipFromFiles } from '../lib/zip.js';
import { getAuthenticatedClient } from '../lib/drive.js';
import {
    loadProjectConfig,
    getTempDir,
    resolveFullEvery,
    resolveLargeFileThreshold,
} from '../lib/config.js';
import {
    BackupManifest,
    ManifestEntry,
    MANIFEST_SCHEMA,
    decideBackupType,
    diffManifest,
} from '../lib/manifest.js';
import {
    blobIdForHash,
    listBlobs,
    openStoreForWrite,
    readLatestManifest,
    removeQuietly,
    uploadArchive,
    uploadBlob,
    writeManifest,
} from '../lib/backupStore.js';
import { persistScanCache, resolveFolderPath, scanProject } from '../lib/changes.js';
import { formatBytes } from '../lib/format.js';

export async function backupAction(force = false, full = false) {
    const spinner = ora('Preparing backup...').start();
    const tempDir = getTempDir();

    try {
        const config = await loadProjectConfig();
        if (!config) {
            spinner.fail('Project not initialized. Run `gpack init` first.');
            return;
        }

        spinner.text = 'Authenticating...';
        const auth = await getAuthenticatedClient();
        const drive = google.drive({ version: 'v3', auth });

        spinner.text = 'Resolving storage location...';
        const folderPath = resolveFolderPath(config);
        const store = await openStoreForWrite(drive, auth, folderPath);

        spinner.text = 'Scanning project...';
        const scan = await scanProject((done, total) => {
            if (done % 200 === 0 || done === total) {
                spinner.text = `Scanning project... ${done}/${total} files`;
            }
        });

        if (scan.files.length === 0) {
            spinner.fail('Nothing to back up: every file is excluded by .gpackignore.');
            return;
        }

        spinner.text = 'Reading last backup manifest...';
        const prev = await readLatestManifest(store);
        const diff = diffManifest(prev, scan.files, scan.hashes);
        const changedCount = diff.added.length + diff.modified.length + diff.deleted.length;

        if (prev && changedCount === 0 && !force && !full) {
            spinner.fail('No changes detected since the last backup. Backup aborted.');
            console.log(picocolors.yellow('To force a backup, run `gpack push --force` or make a change.'));
            return;
        }

        const threshold = resolveLargeFileThreshold(config);
        const large = scan.files.filter(f => f.size >= threshold);
        const small = scan.files.filter(f => f.size < threshold);

        // Only small files ever travel inside an archive, so the full-versus-
        // incremental decision is about the small-file corpus alone.
        const smallByRel = new Map(small.map(f => [f.rel, f]));
        const changedPackBytes = [...diff.added, ...diff.modified]
            .reduce((sum, rel) => sum + (smallByRel.get(rel)?.size ?? 0), 0);
        const totalPackBytes = small.reduce((sum, f) => sum + f.size, 0);

        const decision = decideBackupType({
            prev,
            force: full,
            fullEvery: resolveFullEvery(config),
            changedPackBytes,
            totalPackBytes,
        });

        const backupName = `${basename(process.cwd())}_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
        const entries: Record<string, ManifestEntry> = {};
        let uploadedBytes = 0;

        // Large files become content-addressed blobs. An unchanged large file
        // resolves to the blob that is already on Drive, so it is never sent
        // again, not even during a full backup. This is the whole point.
        spinner.text = 'Checking stored large files...';
        const existingBlobs = await listBlobs(store);
        const missing = large.filter(f => !existingBlobs.has(blobIdForHash(scan.hashes.get(f.rel)!)));

        let blobIndex = 0;
        for (const file of large) {
            const hash = scan.hashes.get(file.rel)!;
            const blobId = blobIdForHash(hash);

            if (!existingBlobs.has(blobId)) {
                blobIndex++;
                const label = `Uploading large file ${blobIndex}/${missing.length}: ${file.rel}`;
                await uploadBlob(store, blobId, file.abs, (sent, total) => {
                    const pct = total > 0 ? Math.floor((sent / total) * 100) : 100;
                    spinner.text = `${label} (${pct}%)`;
                });
                // Record it so a duplicate of the same content in this same run
                // is not uploaded twice.
                existingBlobs.set(blobId, { id: '', name: blobId });
                uploadedBytes += file.size;
            }

            entries[file.rel] = { size: file.size, mtimeMs: file.mtimeMs, hash, blob: blobId };
        }

        // Small files: pack the ones whose contents changed, or all of them on
        // a full. Anything else carries its previous entry forward untouched,
        // still pointing at the older archive that holds its bytes.
        const toPack: string[] = [];
        for (const file of small) {
            const hash = scan.hashes.get(file.rel)!;
            const before = prev?.entries[file.rel];
            const unchanged = before && before.hash === hash && before.from;

            if (decision.type === 'incremental' && unchanged) {
                entries[file.rel] = { ...before, size: file.size, mtimeMs: file.mtimeMs };
                continue;
            }

            toPack.push(file.rel);
            entries[file.rel] = { size: file.size, mtimeMs: file.mtimeMs, hash, from: backupName };
        }

        await fs.ensureDir(tempDir);
        const zipPath = join(tempDir, backupName);

        spinner.text = `Compressing ${toPack.length} file${toPack.length === 1 ? '' : 's'}...`;
        const zipSize = await createZipFromFiles(process.cwd(), toPack, zipPath);

        spinner.text = `Uploading ${backupName} (${formatBytes(zipSize)})...`;
        await uploadArchive(store, backupName, zipPath, (sent, total) => {
            const pct = total > 0 ? Math.floor((sent / total) * 100) : 100;
            spinner.text = `Uploading ${backupName} (${pct}%)`;
        });
        uploadedBytes += zipSize;

        const manifest: BackupManifest = {
            schema: MANIFEST_SCHEMA,
            name: backupName,
            createdAt: new Date().toISOString(),
            type: decision.type,
            parent: prev?.name ?? null,
            base: decision.type === 'full' ? backupName : (prev?.base ?? prev?.name ?? null),
            chainIndex: decision.type === 'full' ? 0 : (prev?.chainIndex ?? 0) + 1,
            entries,
            packed: toPack,
            deleted: diff.deleted,
            totals: {
                files: Object.keys(entries).length,
                bytes: scan.totalBytes,
                uploadedBytes,
            },
        };

        // The manifest goes last so an interrupted push leaves an orphan
        // archive rather than a manifest pointing at bytes that never landed.
        spinner.text = 'Writing manifest...';
        await writeManifest(store, manifest);

        await persistScanCache(scan, backupName);
        await removeQuietly(zipPath);

        spinner.succeed(picocolors.green(`Backup uploaded: ${backupName}`));

        const saved = scan.totalBytes - uploadedBytes;
        console.log(
            `${picocolors.bold('Type:')}     ${decision.type} (${decision.reason})`,
        );
        console.log(
            `${picocolors.bold('Contents:')} ${manifest.totals.files} files, ${formatBytes(scan.totalBytes)} tracked`,
        );
        console.log(
            `${picocolors.bold('Uploaded:')} ${formatBytes(uploadedBytes)}` +
            (saved > 0 ? picocolors.green(`  (${formatBytes(saved)} skipped, already stored)`) : ''),
        );
        if (diff.deleted.length > 0) {
            console.log(`${picocolors.bold('Removed:')}  ${diff.deleted.length} file(s) no longer present`);
        }

    } catch (error: any) {
        spinner.fail(`Backup failed: ${error.message}`);
        if (String(error.message).includes('Not logged in')) {
            console.log(picocolors.yellow('Try running `gpack login`'));
        }
    } finally {
        await removeQuietly(tempDir);
    }
}

export const backupCommand = new Command('push')
    .alias('backup')
    .description('Backup current project to Google Drive')
    .option('-f, --force', 'Force a backup even if no changes are detected')
    .option('--full', 'Force a full backup instead of an incremental one')
    .action(async (options) => {
        await backupAction(Boolean(options.force), Boolean(options.full));
    });
