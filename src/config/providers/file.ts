import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigSchema, type Config } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// At runtime: dist/config/providers/file.js
// We need to go up to project root and then into src/config.json
// dist/config/providers -> dist/config -> dist -> project root -> src/config.json
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = resolve(PROJECT_ROOT, 'src', 'config.json');

export async function loadConfigFromFile(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return ConfigSchema.parse(parsed);
}


