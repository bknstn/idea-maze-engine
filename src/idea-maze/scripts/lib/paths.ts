import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

export const IDEA_MAZE_HOME = process.env.IDEA_MAZE_HOME ?? PROJECT_ROOT;
export const DATA_DIR = resolve(IDEA_MAZE_HOME, 'data');
export const DB_PATH = resolve(DATA_DIR, 'lab.db');
