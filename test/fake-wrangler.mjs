#!/usr/bin/env node
// Stands in for wrangler in tests.
//   deploy [--secrets-file <file>]: makes a new version of the fake Worker,
//     carrying the earlier version's secrets plus the file's, and the commit
//     in FAKE_COMMIT. Writes a report of what it saw (file mode, secret names,
//     which environment names reached it). Values are never written to it.
//   rollback <version id>: makes that version active again.

import fs from 'node:fs';

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
