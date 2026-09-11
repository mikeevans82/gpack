import { google } from 'googleapis';
import { basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadProjectConfig, loadProjectState, saveProjectState } from './config.js';
import { getAuthenticatedClient } from './drive.js';
import { loadIgnoreMatcher } from './ignore.js';
import {
    BackupManifest,
    ManifestDiff,
    ScannedFile,
    diffManifest,
    enumerateFiles,
    resolveHashes,
} from './manifest.js';
import { openStoreForRead, listRestorePoints, readManifest } from './backupStore.js';

const execPromise = promisify(exec);

export function resolveFolderPath(config: { backupFolder?: string } | null): string {
    return config?.backupFolder || `GPACK/${basename(process.cwd())}`;
}

export interface ProjectScan {
    files: ScannedFile[];
    hashes: Map<string, string>;
    cache: Record<string, { size: number; mtimeMs: number; hash: string }>;
    hashedCount: number;
    totalBytes: number;
}

/**
 * Enumerate and hash the working tree. Hashes come from the local cache
 * whenever size and mtime are unchanged, so repeat scans cost little more
 * than a directory walk.
 */
export async function scanProject(onProgress?: (done: number, total: number) => void): Promise<ProjectScan> {
    const matcher = await loadIgnoreMatcher();
    const files = await enumerateFiles(process.cwd(), matcher);
    const state = await loadProjectState();
    const { hashes, cache, hashedCount } = await resolveHashes(files, state.hashCache, onProgress);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    return { files, hashes, cache, hashedCount, totalBytes };
}

/** Persist the hash cache so the next scan can skip unchanged files. */
export async function persistScanCache(scan: ProjectScan, lastBackupName: string | null): Promise<void> {
    const state = await loadProjectState();
    await saveProjectState({
        ...state,
        lastBackupName: lastBackupName ?? state.lastBackupName,
        hashCache: scan.cache,
    });
}

async function runGitCommand(cmd: string, cwd: string): Promise<string> {
    try {
        const { stdout } = await execPromise(cmd, { cwd });
        return stdout.trim();
    } catch {
        return '';
    }
}

async function isGitActive(cwd: string): Promise<boolean> {
    const isWorkTree = await runGitCommand('git rev-parse --is-inside-work-tree', cwd);
    return isWorkTree === 'true';
}

async function getLatestFileModificationTime(dir: string): Promise<Date | null> {
    const matcher = await loadIgnoreMatcher();
    const files = await enumerateFiles(dir, matcher);
    let latest: Date | null = null;
    for (const file of files) {
        const time = new Date(file.mtimeMs);
        if (!latest || time > latest) latest = time;
    }
    return latest;
}

/**
 * Timestamp-based detection, used only when there is no manifest to diff
 * against, which means the newest backup predates incremental support.
 */
async function legacyChangeCheck(lastBackupDate: Date): Promise<{ changed: boolean; reason: string }> {
    if (await isGitActive(process.cwd())) {
        const lastCommitStr = await runGitCommand('git log -1 --format=%cI', process.cwd());
        if (lastCommitStr && new Date(lastCommitStr) > lastBackupDate) {
            return { changed: true, reason: `new git commit since last backup (${lastCommitStr})` };
        }
        if (await runGitCommand('git status --porcelain', process.cwd())) {
            return { changed: true, reason: 'uncommitted changes present' };
        }
        return { changed: false, reason: 'no changes since last backup' };
    }

    const latest = await getLatestFileModificationTime(process.cwd());
    if (latest && latest > lastBackupDate) {
        return { changed: true, reason: `files modified since last backup (${latest.toISOString()})` };
    }
    return { changed: false, reason: 'no changes since last backup' };
}

export interface BackupStatus {
    needed: boolean;
    reason: string;
    lastBackupDate: Date | null;
    lastBackupFile: string | null;
    /** Present when a manifest was available, giving an exact file-level diff. */
    diff: ManifestDiff | null;
    manifest: BackupManifest | null;
}

/**
 * Decide whether a backup is worth running. With a manifest this is an exact
 * content diff rather than a timestamp guess, so an edit that reverts a file
 * to its previous contents correctly reports no change.
 */
export async function checkIfBackupNeeded(): Promise<BackupStatus> {
    const empty = { lastBackupDate: null, lastBackupFile: null, diff: null, manifest: null };

    const config = await loadProjectConfig();
    if (!config) return { needed: true, reason: 'project not initialized', ...empty };

    let auth;
    try {
        auth = await getAuthenticatedClient();
    } catch {
        return { needed: true, reason: 'not logged in', ...empty };
    }

    const drive = google.drive({ version: 'v3', auth });
    const store = await openStoreForRead(drive, auth, resolveFolderPath(config));
    if (!store) return { needed: true, reason: 'no backups folder found on Google Drive', ...empty };

    const points = await listRestorePoints(store);
    if (points.length === 0) {
        return { needed: true, reason: 'no backups found on Google Drive', ...empty };
    }

    const newest = points[0];
    const lastBackupDate = newest.zip.createdTime ? new Date(newest.zip.createdTime) : null;
    const lastBackupFile = newest.zip.name;
    const manifest = newest.manifestFile ? await readManifest(store, newest.manifestFile) : null;

    if (!manifest) {
        if (!lastBackupDate) {
            return { needed: true, reason: 'last backup has no timestamp', ...empty };
        }
        const { changed, reason } = await legacyChangeCheck(lastBackupDate);
        return { needed: changed, reason, lastBackupDate, lastBackupFile, diff: null, manifest: null };
    }

    const scan = await scanProject();
    const diff = diffManifest(manifest, scan.files, scan.hashes);
    await persistScanCache(scan, null);

    const changedCount = diff.added.length + diff.modified.length + diff.deleted.length;
    if (changedCount === 0) {
        return {
            needed: false,
            reason: 'no changes since last backup',
            lastBackupDate,
            lastBackupFile,
            diff,
            manifest,
        };
    }

    const parts: string[] = [];
    if (diff.added.length) parts.push(`${diff.added.length} added`);
    if (diff.modified.length) parts.push(`${diff.modified.length} modified`);
    if (diff.deleted.length) parts.push(`${diff.deleted.length} deleted`);

    return {
        needed: true,
        reason: parts.join(', '),
        lastBackupDate,
        lastBackupFile,
        diff,
        manifest,
    };
}
