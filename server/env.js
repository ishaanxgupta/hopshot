// Loads <project>/.env into process.env at server start, if the file exists (Node's built-in
// process.loadEnvFile, Node >= 20.12; silently skipped on older Node). Variables already set in the
// environment win (loadEnvFile never overrides them). HOPSHOT_DOTENV=0 skips the file (the test
// harnesses set it so a developer's .env never switches memory on under them).
// Imported first by server/index.js so every module sees the values. Nothing is ever printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
export let envFileLoaded = false;
if (process.env.HOPSHOT_DOTENV !== '0' && typeof process.loadEnvFile === 'function') {
  try {
    if (fs.existsSync(file)) { process.loadEnvFile(file); envFileLoaded = true; }
  } catch {
    console.error('could not read .env (ignored)');
  }
}
