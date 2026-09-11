import fs from 'fs-extra';
import { createHash } from 'crypto';
import { join, relative, sep } from 'path';
import type { IgnoreMatcher } from './ignore.js';

export const MANIFEST_SCHEMA = 1;

/** Where one file's bytes live, plus what we need to detect a change cheaply. */
export interface ManifestEntry {
    size: number;
    mtimeMs: number;
    /** sha256 hex of the file contents. */
    hash: string;
    /** Set when the bytes are a standalone object in the blob folder. */
    blob?: string;
    /** Set when the bytes are inside the named backup's zip. */
    from?: string;
}

export type BackupType = 'full' | 'incremental';

/**
 * A manifest describes the COMPLETE tree at one restore point, not the delta.
 * Each entry carries its own byte location, so restoring reads exactly one
 * manifest and immediately knows every archive and blob it needs.
 */
export interface BackupManifest {
    schema: number;
    /** The zip file name; the join key between the archive and this manifest. */
    name: string;
    createdAt: string;
    type: BackupType;
    parent: string | null;
    /** Name of the full backup at the root of this chain. */
    base: string | null;
    /** 0 for a full backup, incrementing along the chain. */
    chainIndex: number;
    entries: Record<string, ManifestEntry>;
    /** Relative paths whose bytes are inside THIS backup's zip. */
    packed: string[];
    /** Relative paths present in the parent but gone here. */
    deleted: string[];
    totals: { files: number; bytes: number; uploadedBytes: number };
}

export interface ScannedFile {
    /** Posix-separated path relative to the project root. */
    rel: string;
    abs: string;
    size: number;
    mtimeMs: number;
}

export function toPosix(p: string): string {
    return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Walk the project, pruning ignored directories rather than filtering their
 * contents afterwards. Symlinks are skipped so a cycle cannot hang the walk.
 */
export async function enumerateFiles(root: string, matcher: IgnoreMatcher): Promise<ScannedFile[]> {
    const found: ScannedFile[] = [];

    async function walk(dirAbs: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(dirAbs, { withFileTypes: true });
        } catch {
            return; // Unreadable directory: skip rather than abort the backup.
        }

        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const abs = join(dirAbs, entry.name);
            const rel = toPosix(relative(root, abs));

            if (entry.isDirectory()) {
                if (matcher.ignores(rel, true)) continue;
                await walk(abs);
                continue;
            }
            if (!entry.isFile()) continue;
            if (matcher.ignores(rel, false)) continue;

            try {
                const stat = await fs.stat(abs);
                found.push({ rel, abs, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
            } catch {
                // File vanished between readdir and stat; nothing to back up.
            }
        }
    }

    await walk(root);
    found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return found;
}

export async function hashFile(abs: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = fs.createReadStream(abs);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

export interface HashCacheEntry { size: number; mtimeMs: number; hash: string; }
export type HashCache = Record<string, HashCacheEntry>;

/**
 * Resolve a hash for every scanned file, reusing the local cache whenever size
 * and mtime are unchanged. The cache is an optimisation only: a miss costs a
 * re-read, never correctness.
 */
export async function resolveHashes(
    files: ScannedFile[],
    cache: HashCache,
    onProgress?: (done: number, total: number) => void,
): Promise<{ hashes: Map<string, string>; cache: HashCache; hashedCount: number }> {
    const hashes = new Map<string, string>();
    const nextCache: HashCache = {};
    let hashedCount = 0;
    let done = 0;

    for (const file of files) {
        const cached = cache[file.rel];
        let hash: string;
        if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
            hash = cached.hash;
        } else {
            hash = await hashFile(file.abs);
            hashedCount++;
        }
        hashes.set(file.rel, hash);
        nextCache[file.rel] = { size: file.size, mtimeMs: file.mtimeMs, hash };
        done++;
        onProgress?.(done, files.length);
    }

    return { hashes, cache: nextCache, hashedCount };
}

export interface ManifestDiff {
    added: string[];
    modified: string[];
    deleted: string[];
    unchanged: string[];
    changedBytes: number;
}

export function diffManifest(
    prev: BackupManifest | null,
    files: ScannedFile[],
    hashes: Map<string, string>,
): ManifestDiff {
    const diff: ManifestDiff = { added: [], modified: [], deleted: [], unchanged: [], changedBytes: 0 };
    const prevEntries = prev?.entries ?? {};
    const seen = new Set<string>();

    for (const file of files) {
        seen.add(file.rel);
        const before = prevEntries[file.rel];
        if (!before) {
            diff.added.push(file.rel);
            diff.changedBytes += file.size;
        } else if (before.hash !== hashes.get(file.rel)) {
            diff.modified.push(file.rel);
            diff.changedBytes += file.size;
        } else {
            diff.unchanged.push(file.rel);
        }
    }

    for (const rel of Object.keys(prevEntries)) {
        if (!seen.has(rel)) diff.deleted.push(rel);
    }

    return diff;
}

export interface BackupTypeDecision { type: BackupType; reason: string; }

/**
 * A "full" backup only means the zip carries every small file. Large files
 * always resolve to blobs that already exist, so fulls stay cheap.
 */
export function decideBackupType(opts: {
    prev: BackupManifest | null;
    force: boolean;
    fullEvery: number;
    /** Bytes of small files that changed this run. */
    changedPackBytes: number;
    /** Bytes of the entire small-file corpus. */
    totalPackBytes: number;
}): BackupTypeDecision {
    const { prev, force, fullEvery, changedPackBytes, totalPackBytes } = opts;

    if (force) return { type: 'full', reason: 'full backup requested' };
    if (!prev) return { type: 'full', reason: 'no previous manifest' };
    if (prev.schema !== MANIFEST_SCHEMA) return { type: 'full', reason: 'manifest schema changed' };
    if (prev.chainIndex + 1 >= fullEvery) {
        return { type: 'full', reason: `chain reached ${fullEvery} backups` };
    }
    if (totalPackBytes > 0 && changedPackBytes > totalPackBytes / 2) {
        return { type: 'full', reason: 'more than half the packed files changed' };
    }
    return { type: 'incremental', reason: 'changes since last backup' };
}
