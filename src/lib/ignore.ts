import fs from 'fs-extra';
import { getIgnorePath } from './config.js';

/**
 * gitignore-style matching for .gpackignore.
 *
 * The previous implementation handed raw lines to archiver's glob `ignore`
 * option, where a bare directory name like `node_modules` matches only the
 * directory entry itself and never the files beneath it. Everything inside
 * therefore leaked into the archive. This module treats a bare name as a
 * prunable directory the way git does.
 */

interface Rule {
    /** Matches a path relative to the project root, posix separators. */
    regex: RegExp;
    /** Pattern ended with `/`, so it only matches directories. */
    dirOnly: boolean;
    /** Pattern began with `!`, re-including anything it matches. */
    negated: boolean;
    source: string;
}

/** Directories gpack must never archive: they hold its own state and scratch space. */
const FORCED = ['.gpack'];

function globToRegExpSource(glob: string): string {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                const atSegmentStart = i === 0 || glob[i - 1] === '/';
                if (atSegmentStart && glob[i + 2] === '/') {
                    // `**/` spans zero or more whole segments.
                    out += '(?:[^/]+/)*';
                    i += 2;
                    continue;
                }
                out += '.*';
                i += 1;
                continue;
            }
            out += '[^/]*';
            continue;
        }
        if (c === '?') {
            out += '[^/]';
            continue;
        }
        out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return out;
}

function compile(line: string): Rule | null {
    let pattern = line.trim();
    if (pattern.length === 0 || pattern.startsWith('#')) return null;

    const source = pattern;
    let negated = false;
    if (pattern.startsWith('!')) {
        negated = true;
        pattern = pattern.slice(1);
    }

    let dirOnly = false;
    if (pattern.endsWith('/')) {
        dirOnly = true;
        pattern = pattern.slice(0, -1);
    }

    // A leading slash anchors to the project root and is not part of the match.
    let anchored = false;
    if (pattern.startsWith('/')) {
        anchored = true;
        pattern = pattern.slice(1);
    }
    if (pattern.length === 0) return null;

    // Per gitignore, a slash anywhere inside the pattern also anchors it.
    if (pattern.includes('/')) anchored = true;

    const body = globToRegExpSource(pattern);
    // An unanchored pattern matches at any depth, so allow any leading segments.
    const full = anchored ? `^${body}$` : `^(?:[^/]+/)*${body}$`;

    return { regex: new RegExp(full), dirOnly, negated, source };
}

export interface IgnoreMatcher {
    /**
     * True when the path should be excluded. `relPath` uses posix separators
     * and is relative to the project root.
     */
    ignores(relPath: string, isDir: boolean): boolean;
    /** The rules actually in force, for diagnostics. */
    rules: string[];
}

export function createIgnoreMatcher(lines: string[]): IgnoreMatcher {
    const rules: Rule[] = [];
    for (const name of FORCED) {
        const rule = compile(`/${name}/`);
        if (rule) rules.push(rule);
    }
    for (const line of lines) {
        const rule = compile(line);
        if (rule) rules.push(rule);
    }

    return {
        rules: rules.map(r => r.source),
        ignores(relPath: string, isDir: boolean): boolean {
            let ignored = false;
            // Last matching rule wins, so negations placed later re-include.
            for (const rule of rules) {
                if (rule.dirOnly && !isDir) continue;
                if (rule.regex.test(relPath)) ignored = !rule.negated;
            }
            return ignored;
        },
    };
}

export async function loadIgnoreMatcher(ignorePath = getIgnorePath()): Promise<IgnoreMatcher> {
    let lines: string[] = [];
    if (await fs.pathExists(ignorePath)) {
        const content = await fs.readFile(ignorePath, 'utf-8');
        lines = content.split(/\r?\n/);
    }
    return createIgnoreMatcher(lines);
}
