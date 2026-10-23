#!/usr/bin/env node
// Stands in for `wrangler deploy --secrets-file <file>` in tests: puts each
// secret on the fake Cloudflare Worker and writes a report of what it saw
// (file mode, secret names, which environment names reached it). Values are
// never written to the report.

import fs from 'node:fs';

const i = process.argv.indexOf('--secrets-file');
const file = process.argv[i + 1];
const st = fs.statSync(file);
const values = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.env.FAKE_WRANGLER_FAIL === '1') {
  console.error('✘ [ERROR] A request to the Cloudflare API failed.');
  process.exit(1);
}
const base = process.env.FAKE_CF_URL;
const worker = process.env.FAKE_WORKER;
for (const [name, text] of Object.entries(values)) {
  const r = await fetch(`${base}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/secrets`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    body: JSON.stringify({ name, text, type: 'secret_text' }),
  });
  if (!r.ok) process.exit(1);
}
if (process.env.FAKE_REPORT) {
  fs.writeFileSync(
    process.env.FAKE_REPORT,
    JSON.stringify({ mode: (st.mode & 0o777).toString(8), names: Object.keys(values).sort(), envNames: Object.keys(process.env).sort() }),
  );
}
console.log(`Uploaded ${worker} with ${Object.keys(values).length} secrets`);
// A misbehaving tool that prints a value must still not leak it.
if (process.env.FAKE_WRANGLER_LEAK === '1') console.error(`debug: secrets ${JSON.stringify(values)}`);
