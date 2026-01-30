import { join } from 'path';
import fs from 'fs-extra';

const CONFIG_DIR = '.gpack';
const CONFIG_FILE = 'config.json';
const IGNORE_FILE = '.gpackignore';

export interface ProjectConfig {
    backupFolder: string;
    projectId?: string; // Future proofing
}

export function getProjectConfigPath(): string {
    return join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
}

export function getIgnorePath(): string {
    return join(process.cwd(), IGNORE_FILE);
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

export async function createDefaultIgnore(): Promise<void> {
    const ignorePath = getIgnorePath();
    if (!await fs.pathExists(ignorePath)) {
        const defaultIgnore = `node_modules
.git
.gpack
dist
coverage
.env
`;
        await fs.writeFile(ignorePath, defaultIgnore);
    }
}
