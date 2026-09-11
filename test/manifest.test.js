import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import {
    MANIFEST_SCHEMA,
    decideBackupType,
    diffManifest,
    enumerateFiles,
    hashFile,
    resolveHashes,
} from '../dist/lib/manifest.js';
import { createIgnoreMatcher } from '../dist/lib/ignore.js';

function file(rel, size, mtimeMs = 1) {
    return { rel, abs: rel, size, mtimeMs };
}

function manifest(entries) {
    return {
        schema: MANIFEST_SCHEMA,
        name: 'b.zip',
        createdAt: new Date().toISOString(),
        type: 'full',
        parent: null,
        base: 'b.zip',
        chainIndex: 0,
        entries,
        packed: [],
        deleted: [],
        totals: { files: 0, bytes: 0, uploadedBytes: 0 },
    };
}

test('diff reports added, modified, deleted and unchanged', () => {
    const prev = manifest({
        'keep.txt': { size: 1, mtimeMs: 1, hash: 'aaa', from: 'b.zip' },
        'edit.txt': { size: 1, mtimeMs: 1, hash: 'bbb', from: 'b.zip' },
        'gone.txt': { size: 1, mtimeMs: 1, hash: 'ccc', from: 'b.zip' },
    });

    const files = [file('keep.txt', 1), file('edit.txt', 7), file('new.txt', 3)];
    const hashes = new Map([
        ['keep.txt', 'aaa'],
        ['edit.txt', 'zzz'],
        ['new.txt', 'ddd'],
    ]);

    const diff = diffManifest(prev, files, hashes);
    assert.deepEqual(diff.added, ['new.txt']);
    assert.deepEqual(diff.modified, ['edit.txt']);
    assert.deepEqual(diff.deleted, ['gone.txt']);
    assert.deepEqual(diff.unchanged, ['keep.txt']);
    assert.equal(diff.changedBytes, 10);
});

test('a file whose contents revert counts as unchanged despite a new mtime', () => {
    const prev = manifest({ 'a.txt': { size: 4, mtimeMs: 1, hash: 'aaa', from: 'b.zip' } });
    const diff = diffManifest(prev, [file('a.txt', 4, 999)], new Map([['a.txt', 'aaa']]));
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.unchanged, ['a.txt']);
});

test('everything is added when there is no previous manifest', () => {
    const diff = diffManifest(null, [file('a.txt', 2)], new Map([['a.txt', 'h']]));
    assert.deepEqual(diff.added, ['a.txt']);
    assert.deepEqual(diff.deleted, []);
});

test('backup type is full without a previous manifest', () => {
    const d = decideBackupType({ prev: null, force: false, fullEvery: 10, changedPackBytes: 0, totalPackBytes: 0 });
    assert.equal(d.type, 'full');
});

test('backup type is full at the chain cadence boundary', () => {
    const prev = { ...manifest({}), chainIndex: 9 };
    const d = decideBackupType({ prev, force: false, fullEvery: 10, changedPackBytes: 1, totalPackBytes: 100 });
    assert.equal(d.type, 'full');

    const earlier = { ...manifest({}), chainIndex: 8 };
    const d2 = decideBackupType({ prev: earlier, force: false, fullEvery: 10, changedPackBytes: 1, totalPackBytes: 100 });
    assert.equal(d2.type, 'incremental');
});

test('backup type is full when more than half the corpus changed', () => {
    const prev = { ...manifest({}), chainIndex: 1 };
    const d = decideBackupType({ prev, force: false, fullEvery: 10, changedPackBytes: 51, totalPackBytes: 100 });
    assert.equal(d.type, 'full');

    const d2 = decideBackupType({ prev, force: false, fullEvery: 10, changedPackBytes: 50, totalPackBytes: 100 });
    assert.equal(d2.type, 'incremental');
});

test('a schema bump forces a full backup', () => {
    const prev = { ...manifest({}), schema: MANIFEST_SCHEMA + 1, chainIndex: 1 };
    const d = decideBackupType({ prev, force: false, fullEvery: 10, changedPackBytes: 0, totalPackBytes: 100 });
    assert.equal(d.type, 'full');
});

test('enumerate prunes ignored directories and hashes match content', async () => {
    const root = await fs.mkdtemp(join(os.tmpdir(), 'gpack-test-'));
    try {
        await fs.mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
        await fs.mkdir(join(root, 'src'), { recursive: true });
        await fs.writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'junk');
        await fs.writeFile(join(root, 'src', 'app.js'), 'hello');
        await fs.writeFile(join(root, 'readme.md'), 'hi');

        const found = await enumerateFiles(root, createIgnoreMatcher(['node_modules']));
        assert.deepEqual(found.map(f => f.rel), ['readme.md', 'src/app.js']);

        const hash = await hashFile(join(root, 'src', 'app.js'));
        // sha256 of "hello"
        assert.equal(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('the hash cache is reused only when size and mtime both match', async () => {
    const root = await fs.mkdtemp(join(os.tmpdir(), 'gpack-test-'));
    try {
        const abs = join(root, 'a.txt');
        await fs.writeFile(abs, 'hello');
        const stat = await fs.stat(abs);
        const scanned = [{ rel: 'a.txt', abs, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) }];

        const warm = await resolveHashes(scanned, {
            'a.txt': { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), hash: 'cached-value' },
        });
        assert.equal(warm.hashedCount, 0);
        assert.equal(warm.hashes.get('a.txt'), 'cached-value');

        const stale = await resolveHashes(scanned, {
            'a.txt': { size: stat.size, mtimeMs: 0, hash: 'cached-value' },
        });
        assert.equal(stale.hashedCount, 1);
        assert.equal(
            stale.hashes.get('a.txt'),
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
