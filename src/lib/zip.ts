import archiver from 'archiver';
import fs from 'fs-extra';
import { join } from 'path';
import { getIgnorePath } from './config.js';

export async function createZipStream(sourceDir: string): Promise<archiver.Archiver> {
    const archive = archiver('zip', {
        zlib: { level: 9 }, // Sets the compression level.
    });

    const ignorePath = getIgnorePath();
    let ignoreList: string[] = [];

    if (await fs.pathExists(ignorePath)) {
        const content = await fs.readFile(ignorePath, 'utf-8');
        ignoreList = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));
    }

    // Always ignore .gpack folder by default if not already ignored, 
    // but usually users put it in defaults.
    // We should also ignore the output zip if we were writing it locally (but we stream).

    // Add files to metadata
    archive.glob('**/*', {
        cwd: sourceDir,
        ignore: ignoreList,
        dot: true, // Include dotfiles
        skip: ['.gpack/**'] // Hard exclude .gpack config directory just in case
    });

    return archive;
}
