import archiver from 'archiver';
import fs from 'fs-extra';
import { join } from 'path';
import unzipper from 'unzipper';

/**
 * Build a zip containing exactly the given project-relative paths.
 *
 * The archive is written to disk rather than streamed straight to Drive so the
 * uploader can report progress, retry, and run a resumable session, all of
 * which need a known size and the ability to re-read a byte range.
 */
export async function createZipFromFiles(
    sourceDir: string,
    relPaths: string[],
    destPath: string,
    onProgress?: (entries: number, total: number) => void,
): Promise<number> {
    await fs.ensureDir(join(destPath, '..'));
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const done = new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        // A vanished or unreadable file should not abort an entire backup.
        archive.on('warning', err => {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') reject(err);
        });
    });

    archive.pipe(output);

    let count = 0;
    for (const rel of relPaths) {
        archive.file(join(sourceDir, rel), { name: rel });
        onProgress?.(++count, relPaths.length);
    }

    await archive.finalize();
    await done;

    const stat = await fs.stat(destPath);
    return stat.size;
}

/**
 * Extract a zip into a directory.
 *
 * Replaces the previous `tar -xf` child process, which passed no working
 * directory and only worked where the system tar is bsdtar. GNU tar cannot
 * read zip archives at all, so restore was broken on most Linux systems.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
    await fs.ensureDir(destDir);
    // Extract exposes its own promise; it does not settle cleanly under
    // stream.pipeline, which reports a premature close instead.
    await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destDir }))
        .promise();
}
