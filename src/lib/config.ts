import { join } from 'path';
import fs from 'fs-extra';

const CONFIG_DIR = '.gpack';
const CONFIG_FILE = 'config.json';
const STATE_FILE = 'state.json';
const IGNORE_FILE = '.gpackignore';

/** Force a full backup once a chain reaches this many restore points. */
export const DEFAULT_FULL_EVERY = 10;
/** At or above this size a file is stored as its own content-addressed blob. */
export const DEFAULT_LARGE_FILE_THRESHOLD = 25 * 1024 * 1024;

export interface ProjectConfig {
    backupFolder: string;
    projectId?: string; // Future proofing
    accountEmail?: string; // The associated Google account email
    /** Overrides DEFAULT_FULL_EVERY for this project. */
    fullEvery?: number;
    /** Overrides DEFAULT_LARGE_FILE_THRESHOLD, in bytes. */
    largeFileThreshold?: number;
}

/**
 * Local cache only. Losing it costs one re-hash pass; the manifests on Drive
 * are always the source of truth.
 */
export interface ProjectState {
    schema: number;
    lastBackupName: string | null;
    hashCache: Record<string, { size: number; mtimeMs: number; hash: string }>;
}

export const STATE_SCHEMA = 1;

export function getProjectConfigPath(): string {
    return join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
}

export function getIgnorePath(): string {
    return join(process.cwd(), IGNORE_FILE);
}

export function getStatePath(): string {
    return join(process.cwd(), CONFIG_DIR, STATE_FILE);
}

export function getTempDir(): string {
    return join(process.cwd(), CONFIG_DIR, 'temp');
}

export async function loadProjectState(): Promise<ProjectState> {
    const empty: ProjectState = { schema: STATE_SCHEMA, lastBackupName: null, hashCache: {} };
    try {
        const state = await fs.readJSON(getStatePath());
        if (state?.schema !== STATE_SCHEMA) return empty;
        return { ...empty, ...state };
    } catch {
        return empty;
    }
}

export async function saveProjectState(state: ProjectState): Promise<void> {
    await fs.ensureDir(join(process.cwd(), CONFIG_DIR));
    await fs.writeJSON(getStatePath(), state);
}

export function resolveFullEvery(config: ProjectConfig | null): number {
    const value = config?.fullEvery;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_FULL_EVERY;
}

export function resolveLargeFileThreshold(config: ProjectConfig | null): number {
    const value = config?.largeFileThreshold;
    return typeof value === 'number' && value > 0 ? value : DEFAULT_LARGE_FILE_THRESHOLD;
}

export async function loadProjectConfig(): Promise<ProjectConfig | null> {
    const configPath = getProjectConfigPath();
    if (await fs.pathExists(configPath)) {
        return fs.readJSON(configPath);
    }
    return null;
}

export async function saveProjectConfig(config: ProjectConfig): Promise<void> {
    const configPath = getProjectConfigPath();
    await fs.ensureDir(join(process.cwd(), CONFIG_DIR));
    await fs.writeJSON(configPath, config, { spaces: 2 });
}

/**
 * Seeded into .gpackignore by `gpack init`.
 *
 * `.claude` is excluded because Claude Code keeps git worktrees under it, each
 * a full second copy of the project that appears and disappears as worktrees
 * come and go.
 */
export const DEFAULT_IGNORE_LINES = [
    'node_modules',
    '.git',
    '.gpack',
    '.claude',
    'dist',
    'coverage',
    '.env',
];

export async function createDefaultIgnore(): Promise<void> {
    const ignorePath = getIgnorePath();
    if (!await fs.pathExists(ignorePath)) {
        await fs.writeFile(ignorePath, DEFAULT_IGNORE_LINES.map(line => `${line}\n`).join(''));
    }
}
