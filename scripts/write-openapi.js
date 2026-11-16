// Writes the generated OpenAPI document to openapi.json (committed, so CI
// can diff a PR's spec against main's). `--check` fails instead of writing
// when the committed file is out of date.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, OPENAPI_CONFIG } from '../src/app.js';

const path = fileURLToPath(new URL('../openapi.json', import.meta.url));
const doc = `${JSON.stringify(app.getOpenAPI31Document(OPENAPI_CONFIG), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { /* missing file is out of date */ }
  if (current !== doc) {
    console.error('openapi.json is out of date: run `npm run spec` and commit it.');
    process.exit(1);
  }
  console.log('openapi.json is up to date.');
} else {
  writeFileSync(path, doc);
  console.log(`wrote ${path}`);
}
