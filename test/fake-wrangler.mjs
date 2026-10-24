#!/usr/bin/env node
// Stands in for wrangler in tests.
//   deploy [--secrets-file <file>]: makes a new version of the fake Worker,
//     carrying the earlier version's secrets plus the file's, and the commit
//     in FAKE_COMMIT. Writes a report of what it saw (file mode, secret names,
//     which environment names reached it). Values are never written to it.
//   rollback <version id>: makes that version active again.
//   d1 migrations apply DB --remote: reads the DB binding from wrangler.jsonc
//     in its directory, as wrangler does, and applies d1/migrations to it.

import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../src/launch.mjs';

const base = process.env.FAKE_CF_URL;
const worker = process.env.FAKE_WORKER;
const post = (path, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, body: JSON.stringify(body) });

const r = process.argv.indexOf('rollback');
if (r !== -1) {
  if (process.env.FAKE_ROLLBACK_FAIL === '1') {
    console.error('✘ [ERROR] rollback failed');
    process.exit(1);
  }
  const res = await post('/fake/rollback', { worker, version: process.argv[r + 1] });
  if (!res.ok) process.exit(1);
  console.log(`Rolled back ${worker}`);
  process.exit(0);
}

if (process.argv.includes('d1')) {
  const cfg = parseJsonc(fs.readFileSync('wrangler.jsonc', 'utf8'));
  const b = (cfg.d1_databases || []).find((x) => x.binding === process.argv[process.argv.indexOf('apply') + 1]);
  const files = fs.readdirSync(path.join('.', b.migrations_dir || 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const res = await post('/fake/d1-migrate', { name: b.database_name, files });
  if (!res.ok) {
    console.error(`✘ [ERROR] Couldn't find a D1 DB named '${b.database_name}'`);
    process.exit(1);
  }
  const { result } = await res.json();
  console.log(result.applied.length ? `Migrations to be applied:\n${result.applied.join('\n')}` : '✅ No migrations to apply!');
  process.exit(0);
}

const i = process.argv.indexOf('--secrets-file');
const file = i === -1 ? null : process.argv[i + 1];
const st = file ? fs.statSync(file) : null;
const values = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (process.env.FAKE_WRANGLER_FAIL === '1') {
  console.error('✘ [ERROR] A request to the Cloudflare API failed.');
  process.exit(1);
}
const res = await post('/fake/deploy', { worker, secrets: values, commit: process.env.WORKERS_CI_COMMIT_SHA || process.env.FAKE_COMMIT });
if (!res.ok) process.exit(1);
if (process.env.FAKE_REPORT) {
  fs.writeFileSync(
    process.env.FAKE_REPORT,
    JSON.stringify({ mode: st ? (st.mode & 0o777).toString(8) : null, names: Object.keys(values).sort(), envNames: Object.keys(process.env).sort() }),
  );
}
console.log(`Uploaded ${worker} with ${Object.keys(values).length} secrets`);
// A misbehaving tool that prints a value must still not leak it.
if (process.env.FAKE_WRANGLER_LEAK === '1') console.error(`debug: secrets ${JSON.stringify(values)}`);
