// The orb on D1 (Elijah, "Move it to D1", 2026-10-24), against fake APIs only.
// shops/orb.json as it is on this branch: storage "d1", keepExisting on.
//   1. plan reads create d1_database orb-orders and its migrations, sets no
//      Supabase name, needs no Supabase token, reads no Supabase API and
//      sends zero writes;
//   2. apply makes orb-orders and its tables before the deploy, sends only
//      the names the Worker lacks, and overwrites none it has;
//   3. a wrangler.jsonc that binds DB to orb-shop-orders (the template's
//      "<Worker name>-orders" default) stops the run before any write.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakes } from './fake-apis.mjs';
import { run } from '../src/launch.mjs';
import { createLog } from '../src/log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'test', 'fake-wrangler.mjs');
const ORB = JSON.parse(fs.readFileSync(path.join(ROOT, 'shops', 'orb.json'), 'utf8'));
const LEAK_GREP = /whsec_|re_|sb_secret|rk_/; // as test/launch.test.mjs
const SUPABASE_NAME = /SUPABASE/;

// The binding line orb-shop's `npm run shop:sync` writes once config/shop.ts
// says storage "d1" and d1Database "orb-orders".
const wranglerJsonc = (dbName) =>
  `{\n  "name": "orb-shop",\n  "vars": {"NEXT_PUBLIC_SITE_URL": "https://orb-shop.elijahedington.workers.dev"},\n` +
  `  // Written by npm run shop:sync because SHOP.storage is "d1": orders and job_log.\n` +
  `  "d1_databases": [{"binding": "DB", "database_name": "${dbName}", "migrations_dir": "d1/migrations"}],\n  "keep_vars": true,\n}\n`;

let fakes, tmp, secretsFile;

function makeShop(dbName) {
  const dir = fs.mkdtempSync(path.join(tmp, 'shop-'));
  fs.mkdirSync(path.join(dir, 'd1', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'd1', 'migrations', '0001_orders.sql'), 'create table if not exists orders (id text primary key);\n');
  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), wranglerJsonc(dbName));
  return dir;
}

// The orb Worker as plan run 40114864337 read it: it runs, and holds none of
// the launcher's six names.
function seedOrb(s, secrets = {}) {
  s.cloudflare.versions['orb-shop'] = [{ id: 'ver-own', commit: 'c'.repeat(40), secrets: { ...secrets }, vars: {} }];
  s.cloudflare.active['orb-shop'] = 'ver-own';
  s.cloudflare.secrets['orb-shop'] = { ...secrets };
}

async function launch(mode, shopDir) {
  let out = '';
  const report = path.join(tmp, `wrangler-${Date.now()}-${Math.random()}.json`);
  const from = fakes.state.requests.length;
  const summary = await run({
    shop: 'orb',
    mode,
    shopConfig: ORB,
    shopDir,
    secretsFile,
    deployCmd: ['node', WRANGLER],
    log: createLog({ out: { write: (t) => (out += t) } }),
    pollMs: 0,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...fakes.env,
      FAKE_WORKER: 'orb-shop',
      FAKE_REPORT: report,
      // No SUPABASE_ACCESS_TOKEN and no SUPABASE_ORG_ID: a D1 shop needs neither.
      RESEND_ADMIN_KEY: 're_' + 'ADMINfakeADMINfake',
      STRIPE_SECRET_KEY: 'rk_test_' + 'FAKE0123456789abcdefFAKE',
      CLOUDFLARE_API_TOKEN: 'cf-token-' + 'x'.repeat(30),
      CLOUDFLARE_ACCOUNT_ID: 'acc-fake',
    },
  });
  const requests = fakes.state.requests.slice(from);
  const shown = out.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
  assert.doesNotMatch(shown, LEAK_GREP, 'no secret in the log');
  return { summary, out: shown, requests, writes: requests.filter((x) => x.method !== 'GET'), wrangler: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null };
}

const actions = (s) => Object.fromEntries(s.resources.map((r) => [r.kind, r.action]));
const states = (s) => Object.fromEntries(s.secrets.map((x) => [x.name, x.state]));

beforeEach(async () => {
  fakes = await startFakes();
  seedOrb(fakes.state);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-orb-d1-'));
  secretsFile = path.join(tmp, 'secrets.json');
  fs.writeFileSync(secretsFile, '', { mode: 0o600 });
  fs.chmodSync(secretsFile, 0o600);
});

afterEach(async () => {
  await fakes.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('shops/orb.json puts the orb on D1 and keeps keepExisting on', () => {
  assert.equal(ORB.storage, 'd1');
  assert.equal(ORB.keepExisting, true);
  assert.equal(ORB.slug, 'orb');
});

test('orb plan reads create d1_database orb-orders, sets no Supabase name, reads no Supabase, writes nothing', async () => {
  const r = await launch('plan', makeShop('orb-orders'));
  assert.equal(r.summary.exitCode, 0, r.out + r.summary.errors.join('\n'));
  assert.deepEqual(r.writes, [], 'plan sent no write');
  assert.equal(r.requests.filter((x) => x.path.startsWith('/supabase') || x.path.startsWith('/rest/')).length, 0, 'no Supabase call');
  assert.deepEqual(actions(r.summary), { d1_database: 'create', d1_migrations: 'create', resend_key: 'create', stripe_webhook: 'create', worker_secrets: 'update' });
  assert.equal(r.summary.resources.find((x) => x.kind === 'd1_database').name, 'orb-orders');
  assert.match(r.out, /^create +d1_database +orb-orders$/m);
  assert.deepEqual(states(r.summary), { RESEND_API_KEY: 'set', STRIPE_SECRET_KEY: 'set', STRIPE_WEBHOOK_SECRET: 'set', CRON_SECRET: 'set' });
  assert.equal(r.summary.resources.find((x) => x.kind === 'worker_secrets').count, 4);
  assert.ok(!r.summary.secrets.some((x) => SUPABASE_NAME.test(x.name)), 'no Supabase name in the summary');
  assert.ok(!r.summary.resources.some((x) => x.kind.startsWith('supabase')), 'no Supabase resource');
  assert.doesNotMatch(r.out, SUPABASE_NAME, 'no Supabase name in the log');
});

test('orb apply: makes orb-orders and its tables before the deploy, sends only the missing names, keeps the rest', async () => {
  seedOrb(fakes.state, { RESEND_API_KEY: 'hash-own-resend' });
  const r = await launch('apply', makeShop('orb-orders'));
  assert.equal(r.summary.exitCode, 0, r.out + r.summary.errors.join('\n'));
  const db = fakes.state.cloudflare.d1.find((d) => d.name === 'orb-orders');
  assert.ok(db, 'orb-orders exists');
  assert.deepEqual(db.migrations, ['0001_orders.sql']);
  const paths = r.requests.map((x) => `${x.method} ${x.path}`);
  assert.ok(paths.indexOf('POST /cloudflare/fake/d1-migrate') < paths.indexOf('POST /cloudflare/fake/deploy'), 'tables before the deploy');
  assert.deepEqual(r.wrangler.names, ['CRON_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], 'only the missing names reached the deploy');
  assert.equal(fakes.state.cloudflare.secrets['orb-shop'].RESEND_API_KEY, 'hash-own-resend', 'the existing key kept its value');
  assert.equal(fakes.state.resend.keys.length, 0, 'no new Resend key while the Worker has one');
  assert.equal(r.requests.filter((x) => x.path.startsWith('/supabase')).length, 0, 'no Supabase call');
  assert.ok(!Object.keys(fakes.state.cloudflare.secrets['orb-shop']).some((k) => SUPABASE_NAME.test(k)), 'no Supabase name on the Worker');
});

test('a binding to orb-shop-orders (the template default) stops plan and apply before any write', async () => {
  const dir = makeShop('orb-shop-orders');
  const plan = await launch('plan', dir);
  assert.equal(plan.summary.exitCode, 1);
  assert.ok(plan.summary.errors.some((e) => /binds DB to "orb-shop-orders", not "orb-orders"/.test(e)), plan.summary.errors.join('\n'));
  const apply = await launch('apply', dir);
  assert.equal(apply.summary.exitCode, 1);
  assert.deepEqual(apply.writes, [], 'apply stopped before its first write');
  assert.equal(fakes.state.cloudflare.d1.length, 0, 'no database made');
});
