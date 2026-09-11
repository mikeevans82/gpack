import test from 'node:test';
import assert from 'node:assert/strict';
import { planTrim, collectReferences } from '../dist/commands/trim.js';

/** Build a loaded restore point whose files live in the named archives. */
function point(name, { from = {}, blobs = [], legacy = false } = {}) {
    const entries = {};
    for (const [rel, archive] of Object.entries(from)) {
        entries[rel] = { size: 1, mtimeMs: 1, hash: rel, from: archive };
    }
    blobs.forEach((blob, i) => {
        entries[`big${i}`] = { size: 1, mtimeMs: 1, hash: blob, blob };
    });

    return {
        point: {
            zip: { id: `id-${name}`, name, size: '100' },
            manifestFile: legacy ? null : { id: `mid-${name}`, name: `${name}.json` },
            legacy,
        },
        manifest: legacy ? null : { entries, name, type: 'incremental', chainIndex: 1 },
    };
}

test('a point pins its own archive even when it packed nothing', () => {
    const p = point('b2.zip', { from: { 'a.txt': 'b1.zip' } });
    const { archives } = collectReferences([p]);
    assert.ok(archives.has('b2.zip'));
    assert.ok(archives.has('b1.zip'));
});

test('an archive a survivor depends on is kept, manifest included', () => {
    const base = point('b1.zip', { from: { 'a.txt': 'b1.zip', 'b.txt': 'b1.zip' } });
    const incr = point('b2.zip', { from: { 'a.txt': 'b1.zip', 'b.txt': 'b2.zip' } });

    const plan = planTrim([incr, base], new Set(['b1.zip']));
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.pinned.map(p => p.point.zip.name), ['b1.zip']);
});

test('an archive nothing depends on is removed', () => {
    const old = point('b1.zip', { from: { 'a.txt': 'b1.zip' } });
    // A later full repacked everything, so nothing points back at b1.
    const full = point('b2.zip', { from: { 'a.txt': 'b2.zip' } });

    const plan = planTrim([full, old], new Set(['b1.zip']));
    assert.deepEqual(plan.removed.map(p => p.point.zip.name), ['b1.zip']);
    assert.deepEqual(plan.pinned, []);
});

test('pinning is transitive across a chain', () => {
    const b1 = point('b1.zip', { from: { 'a.txt': 'b1.zip' } });
    const b2 = point('b2.zip', { from: { 'a.txt': 'b1.zip', 'b.txt': 'b2.zip' } });
    const b3 = point('b3.zip', { from: { 'a.txt': 'b1.zip', 'b.txt': 'b2.zip', 'c.txt': 'b3.zip' } });

    // Selecting both older points must retain both, not just the direct one.
    const plan = planTrim([b3, b2, b1], new Set(['b1.zip', 'b2.zip']));
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.pinned.map(p => p.point.zip.name).sort(), ['b1.zip', 'b2.zip']);
});

test('blobs referenced by any survivor are retained', () => {
    const keep = point('b2.zip', { blobs: ['sha256-keep'] });
    const drop = point('b1.zip', { blobs: ['sha256-drop'] });

    const plan = planTrim([keep, drop], new Set(['b1.zip']));
    const { blobs } = collectReferences([...plan.kept, ...plan.pinned]);
    assert.ok(blobs.has('sha256-keep'));
    assert.ok(!blobs.has('sha256-drop'));
});

test('a legacy archive is self-contained and can always go', () => {
    const legacy = point('old.zip', { legacy: true });
    const current = point('b1.zip', { from: { 'a.txt': 'b1.zip' } });

    const plan = planTrim([current, legacy], new Set(['old.zip']));
    assert.deepEqual(plan.removed.map(p => p.point.zip.name), ['old.zip']);
});
