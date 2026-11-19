// Nightly bulk files: every league-wide table the API serves, as JSON (the
// API's own { data, meta } response) and CSV (one row per team, player or
// game), plus manifest.json listing each file's licence. Read from the
// public API itself, so the files match what the routes serve.
//
//   node scripts/bulk-export.js [outDir]       (default: ./bulk)
//   API_BASE=https://... node scripts/bulk-export.js
//
// .github/workflows/bulk.yml uploads the folder to the `data` release.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.API_BASE || 'https://api.eyewallanalytics.com';
const OUT = process.argv[2] || 'bulk';
const PAUSE_MS = 1100; // stays under the API's 60 requests a minute

const HT = ['pwhl', 'ahl', 'echl'];
const ALL = ['nhl', ...HT];

// [file name, API path, the array in `data` that becomes CSV rows]
export const DATASETS = [
  ...ALL.flatMap(l => [
    [`${l}-teams`, `/v1/${l}/teams`, d => d],
    [`${l}-elo`, `/v1/${l}/elo`, d => d.ratings],
    [`${l}-playoff-odds`, `/v1/${l}/playoff-odds`, d => d.teams],
    // the latest season with scored games: one row per game
    [`${l}-game-xg`, `/v1/${l}/xg?season=latest`, d => d.games],
  ]),
  ...HT.map(l => [`${l}-power-rankings`, `/v1/${l}/power-rankings`, d => d.teams]),
  ['nhl-power-rankings', '/v1/nhl/power-rankings', d => d.teams],
  ['nhl-rapm', '/v1/nhl/rapm', d => d.players],
  ['nhl-war', '/v1/nhl/war', d => d.players],
  // CC0, from the nhl-contracts dataset (whose own release has every row and source claim)
  ['nhl-contracts', '/v1/nhl/contracts', d => d.players],
  ['nhl-contract-team-totals', '/v1/nhl/contracts/teams', d => d.teams],
  ['nhl-contract-team-totals-signing-team', '/v1/nhl/contracts/teams?basis=signing_team', d => d.teams],
];

// Nested objects become dotted columns (team.code); arrays stay JSON.
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

const cell = v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  const flat = rows.map(r => flatten(r));
  // A null nested object (e.g. a player with no current team) flattens to a
  // bare `team` column; drop it when `team.*` columns carry the values.
  const all = [...new Set(flat.flatMap(r => Object.keys(r)))];
  const cols = all.filter(c => !(all.some(o => o.startsWith(`${c}.`)) && flat.every(r => r[c] == null)));
  return [cols.join(','), ...flat.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files = [];
  const failures = [];
  for (const [name, path, rowsOf] of DATASETS) {
    const res = await fetch(API + path, { headers: { 'User-Agent': 'eyewall-api-bulk-export' } });
    if (!res.ok) {
      failures.push(`${path}: HTTP ${res.status}`);
      await sleep(PAUSE_MS);
      continue;
    }
    const body = await res.json();
    const rows = rowsOf(body.data) ?? [];
    writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
    writeFileSync(join(OUT, `${name}.csv`), toCsv(rows));
    files.push({
      name, path, rows: rows.length,
      license: body.meta.license, attribution: body.meta.attribution,
      generatedAt: body.meta.generatedAt,
    });
    console.log(`${name}: ${rows.length} rows (${body.meta.license})`);
    await sleep(PAUSE_MS);
  }
  const manifest = {
    exportedAt: new Date().toISOString(),
    api: API,
    docs: `${API}/docs`,
    note: 'Each file pair (.json, .csv) carries its own licence: CC-BY-4.0, CC-BY-NC-4.0 for NHL models built on MoneyPuck inputs, or CC0-1.0 for NHL contracts (from github.com/ehlersio/nhl-contracts). Credit the attribution line given for each.',
    files,
    failures,
  };
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (failures.length) {
    console.error(`failed: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
