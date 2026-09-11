import test from 'node:test';
import assert from 'node:assert/strict';
import { createIgnoreMatcher } from '../dist/lib/ignore.js';
import { DEFAULT_IGNORE_LINES } from '../dist/lib/config.js';

test('a bare directory name prunes everything beneath it', () => {
    // The regression this whole feature uncovered: archiver's glob ignore
    // matched only the top-level entry, so node_modules shipped in every zip.
    const m = createIgnoreMatcher(['node_modules']);
    assert.equal(m.ignores('node_modules', true), true);
    assert.equal(m.ignores('src', true), false);
});

test('nested directories of the same name are matched at any depth', () => {
    const m = createIgnoreMatcher(['node_modules']);
    assert.equal(m.ignores('packages/app/node_modules', true), true);
});

test('a trailing slash restricts the rule to directories', () => {
    const m = createIgnoreMatcher(['build/']);
    assert.equal(m.ignores('build', true), true);
    assert.equal(m.ignores('build', false), false);
});

test('a leading slash anchors to the project root', () => {
    const m = createIgnoreMatcher(['/dist']);
    assert.equal(m.ignores('dist', true), true);
    assert.equal(m.ignores('packages/app/dist', true), false);
});

test('a slash inside the pattern anchors it too', () => {
    const m = createIgnoreMatcher(['src/generated']);
    assert.equal(m.ignores('src/generated', true), true);
    assert.equal(m.ignores('lib/src/generated', true), false);
});

test('wildcards stay within one path segment', () => {
    const m = createIgnoreMatcher(['*.log']);
    assert.equal(m.ignores('debug.log', false), true);
    assert.equal(m.ignores('logs/debug.log', false), true);
    assert.equal(m.ignores('debug.log.txt', false), false);
});

test('a double star spans whole segments', () => {
    const m = createIgnoreMatcher(['coverage/**/*.json']);
    assert.equal(m.ignores('coverage/a.json', false), true);
    assert.equal(m.ignores('coverage/unit/deep/a.json', false), true);
    assert.equal(m.ignores('coverage/a.txt', false), false);
});

test('a later negation re-includes a file', () => {
    const m = createIgnoreMatcher(['*.env', '!.env.example']);
    assert.equal(m.ignores('.env', false), true);
    assert.equal(m.ignores('.env.example', false), false);
});

test('the gpack state directory is always excluded', () => {
    const m = createIgnoreMatcher([]);
    assert.equal(m.ignores('.gpack', true), true);
});

test('comments and blank lines are skipped', () => {
    const m = createIgnoreMatcher(['# a comment', '', '   ', 'dist']);
    assert.equal(m.ignores('dist', true), true);
    assert.equal(m.ignores('# a comment', false), false);
});

test('regex metacharacters in a pattern are literal', () => {
    const m = createIgnoreMatcher(['file+name.txt']);
    assert.equal(m.ignores('file+name.txt', false), true);
    assert.equal(m.ignores('fileename.txt', false), false);
});

test('the default rules prune Claude Code worktrees', () => {
    // Claude Code checks out a full copy of the project under .claude/worktrees,
    // which would otherwise be backed up as a duplicate and churn on every
    // worktree created or removed.
    const m = createIgnoreMatcher(DEFAULT_IGNORE_LINES);
    assert.equal(m.ignores('.claude', true), true);
});

test('the default rules cover the usual build and dependency output', () => {
    const m = createIgnoreMatcher(DEFAULT_IGNORE_LINES);
    for (const dir of ['node_modules', '.git', '.gpack', 'dist', 'coverage']) {
        assert.equal(m.ignores(dir, true), true, `${dir} should be ignored`);
    }
    assert.equal(m.ignores('.env', false), true);
    assert.equal(m.ignores('src', true), false);
});
