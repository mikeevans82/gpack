import fs from 'fs-extra';
import { OAuth2Client } from 'google-auth-library';
import {
    DriveFile,
    listAllFiles,
    ensureChildFolder,
    findChildFolder,
    findDriveFolderId,
    ensureDriveFolder,
    uploadLocalFile,
    uploadText,
    downloadToFile,
    downloadText,
} from './drive.js';
import { BackupManifest, MANIFEST_SCHEMA } from './manifest.js';

/** Holds one manifest per restore point, describing the whole tree at that point. */
export const META_FOLDER = '_gpack_meta';
/** Holds content-addressed objects for files above the large-file threshold. */
export const BLOBS_FOLDER = '_gpack_blobs';

export const BLOB_PREFIX = 'sha256-';

export function blobIdForHash(hash: string): string {
    return `${BLOB_PREFIX}${hash}`;
}

export function manifestNameFor(backupName: string): string {
    return `${backupName.replace(/\.zip$/i, '')}.json`;
}

export interface BackupStore {
    drive: any;
    auth: OAuth2Client;
    folderPath: string;
    rootId: string;
    /** Null when the folder predates incremental backups and nothing has been written yet. */
    metaId: string | null;
    blobsId: string | null;
}

/** Open the store for writing, creating the folder layout as needed. */
export async function openStoreForWrite(
    drive: any,
    auth: OAuth2Client,
    folderPath: string,
): Promise<BackupStore> {
    const rootId = await ensureDriveFolder(drive, folderPath);
    const metaId = await ensureChildFolder(drive, rootId, META_FOLDER);
    const blobsId = await ensureChildFolder(drive, rootId, BLOBS_FOLDER);
    return { drive, auth, folderPath, rootId, metaId, blobsId };
}

/** Open the store for reading. Returns null when the project folder is absent. */
export async function openStoreForRead(
    drive: any,
    auth: OAuth2Client,
    folderPath: string,
): Promise<BackupStore | null> {
    const rootId = await findDriveFolderId(drive, folderPath);
    if (!rootId) return null;
    const metaId = await findChildFolder(drive, rootId, META_FOLDER);
    const blobsId = await findChildFolder(drive, rootId, BLOBS_FOLDER);
    return { drive, auth, folderPath, rootId, metaId, blobsId };
}

export interface RestorePoint {
    zip: DriveFile;
    manifestFile: DriveFile | null;
    /** True for archives written before incremental backups existed. */
    legacy: boolean;
}

/**
 * List restore points newest first, pairing each archive with its manifest.
 * An archive with no manifest is a pre-upgrade full backup.
 */
export async function listRestorePoints(store: BackupStore): Promise<RestorePoint[]> {
    const zips = (await listAllFiles(store.drive, store.rootId))
        .filter(f => f.name.toLowerCase().endsWith('.zip'));

    const manifests = store.metaId ? await listAllFiles(store.drive, store.metaId) : [];
    const byName = new Map(manifests.map(m => [m.name, m]));

    return zips.map(zip => {
        const manifestFile = byName.get(manifestNameFor(zip.name)) ?? null;
        return { zip, manifestFile, legacy: manifestFile === null };
    });
}

export async function readManifest(store: BackupStore, file: DriveFile): Promise<BackupManifest | null> {
    try {
        const text = await downloadText(store.drive, file.id);
        const manifest = JSON.parse(text) as BackupManifest;
        if (manifest?.schema !== MANIFEST_SCHEMA) return null;
        return manifest;
    } catch {
        // A truncated or hand-edited manifest must not block a backup; the
        // caller falls back to a full.
        return null;
    }
}

/** Read the manifest of the newest restore point that has one. */
export async function readLatestManifest(store: BackupStore): Promise<BackupManifest | null> {
    const points = await listRestorePoints(store);
    for (const point of points) {
        if (!point.manifestFile) continue;
        const manifest = await readManifest(store, point.manifestFile);
        if (manifest) return manifest;
    }
    return null;
}

/** Blob ids already present on Drive, so unchanged large files are never re-sent. */
export async function listBlobs(store: BackupStore): Promise<Map<string, DriveFile>> {
    if (!store.blobsId) return new Map();
    const files = await listAllFiles(store.drive, store.blobsId);
    return new Map(files.map(f => [f.name, f]));
}

export async function uploadBlob(
    store: BackupStore,
    blobId: string,
    filePath: string,
    onProgress?: (uploaded: number, total: number) => void,
): Promise<DriveFile> {
    if (!store.blobsId) throw new Error('Blob folder is not available.');
    return uploadLocalFile(
        store.drive,
        store.auth,
        {
            name: blobId,
            parents: [store.blobsId],
            mimeType: 'application/octet-stream',
            filePath,
        },
        onProgress,
    );
}

export async function uploadArchive(
    store: BackupStore,
    name: string,
    filePath: string,
    onProgress?: (uploaded: number, total: number) => void,
): Promise<DriveFile> {
    return uploadLocalFile(
        store.drive,
        store.auth,
        { name, parents: [store.rootId], mimeType: 'application/zip', filePath },
        onProgress,
    );
}

export async function writeManifest(store: BackupStore, manifest: BackupManifest): Promise<DriveFile> {
    if (!store.metaId) throw new Error('Manifest folder is not available.');
    return uploadText(store.drive, {
        name: manifestNameFor(manifest.name),
        parents: [store.metaId],
        mimeType: 'application/json',
        content: JSON.stringify(manifest),
    });
}

export async function downloadFileTo(store: BackupStore, fileId: string, destPath: string): Promise<void> {
    await downloadToFile(store.drive, fileId, destPath);
}

export async function deleteDriveFile(store: BackupStore, fileId: string): Promise<void> {
    await store.drive.files.delete({ fileId });
}

/** Remove a local path, ignoring the case where it is already gone. */
export async function removeQuietly(path: string): Promise<void> {
    await fs.remove(path).catch(() => {});
}
