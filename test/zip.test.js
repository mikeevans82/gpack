import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createZipFromFiles, extractZip } from '../dist/lib/zip.js';

test('a zip round-trips exactly the listed paths', async () => {
    const root = await fs.mkdtemp(join(os.tmpdir(), 'gpack-zip-'));
    try {
        await fs.mkdir(join(root, 'src', 'deep'), { recursive: true });
        await fs.writeFile(join(root, 'src', 'deep', 'a.txt'), 'alpha');
        await fs.writeFile(join(root, 'b.txt'), 'bravo');
        await fs.writeFile(join(root, 'skipped.txt'), 'nope');

        const zipPath = join(root, 'out', 'archive.zip');
        const size = await createZipFromFiles(root, ['src/deep/a.txt', 'b.txt'], zipPath);
        assert.ok(size > 0);

        const dest = join(root, 'extracted');
        await extractZip(zipPath, dest);

        assert.equal(await fs.readFile(join(dest, 'src', 'deep', 'a.txt'), 'utf-8'), 'alpha');
        assert.equal(await fs.readFile(join(dest, 'b.txt'), 'utf-8'), 'bravo');
        await assert.rejects(() => fs.stat(join(dest, 'skipped.txt')));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('an empty file list still produces a readable archive', async () => {
    // An incremental where only large files or deletions changed packs nothing.
    const root = await fs.mkdtemp(join(os.tmpdir(), 'gpack-zip-'));
    try {
        const zipPath = join(root, 'empty.zip');
        const size = await createZipFromFiles(root, [], zipPath);
        assert.ok(size > 0);

        const dest = join(root, 'extracted');
        await extractZip(zipPath, dest);
        assert.deepEqual(await fs.readdir(dest), []);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
