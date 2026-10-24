// A shop whose storage is "d1" (shop three onward), against fake APIs only:
//   1. plan reads no Supabase, needs no Supabase token, and sends zero writes;
//   2. apply makes the D1 database and applies d1/migrations before the first
//      deploy; a second apply is all skip; a new migration file is applied;
//   3. the smoke reads and marks the order row through D1, not Supabase;
//   4. a wrangler.jsonc that binds DB to another database stops it first;
//   5. a Cloudflare token without D1 is named as a missing permission.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakes } from './fake-apis.mjs';
import { run, parseJsonc } from '../src/launch.mjs';
import { createLog } from '../src/log.mjs';
import { TEST_MARK } from '../src/smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'test', 'fake-wrangler.mjs');
const COMMIT = 'd'.repeat(40);
const SHOP = { slug: 'lamp', name: 'Lamp shop', repo: 'cyberpsilosis/lamp-shop', worker: 'orb-shop', siteUrl: 'https://lamp-shop.example.workers.dev', storage: 'd1', smoke: { product: 'orb' } };

let fakes, tmp, shopDir, secretsFile;

// The binding `npm run shop:sync` writes for a "d1" shop, with wrangler.jsonc's comments.
const wranglerJsonc = (name) =>
  `{\n  // the Worker\n  "name": "orb-shop",\n  "vars": {"NEXT_PUBLIC_SITE_URL": "https://lamp-shop.example.workers.dev"},\n  "d1_databases": [{"binding": "DB", "database_name": "${name}", "migrations_dir": "d1/migrations"}],\n}\n`;

function makeShop(dir, dbName) {
  fs.mkdirSync(path.join(dir, 'd1', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'd1', 'migrations', '0001_orders.sql'), 'create table orders (id text primary key);\n');
  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), wranglerJsonc(dbName));
}

async function launch(mode, { dir = shopDir, shopConfig = SHOP, env = {}, browser } = {}) {
  let out = '';
  const report = path.join(tmp, `wrangler-${Date.now()}-${Math.random()}.json`);
  const summary = await run({
    shop: shopConfig.slug,
    mode,
    shopConfig,
    shopDir: dir,
    secretsFile,
    deployCmd: ['node', WRANGLER],
    log: createLog({ out: { write: (t) => (out += t) } }),
    pollMs: 0,
    expectCommit: COMMIT,
    browser,
    smokeSleep: async () => {},
    smokeTries: 3,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...fakes.env,
      FAKE_WORKER: 'orb-shop',
      FAKE_REPORT: report,
      RESEND_ADMIN_KEY: 're_' + 'ADMINfakeADMINfake',
      STRIPE_SECRET_KEY: 'rk_test_' + 'FAKE0123456789abcdefFAKE',
      CLOUDFLARE_API_TOKEN: 'cf-token-' + 'x'.repeat(30),
      CLOUDFLARE_ACCOUNT_ID: 'acc-fake',
      ...env,
    },
  });
  return { summary, out, wrangler: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null };
}

const sent = (fn) => async () => {
  const from = fakes.state.requests.length;
  const r = await fn();
  return { ...r, requests: fakes.state.requests.slice(from) };
};
const actions = (s) => Object.fromEntries(s.resources.map((r) => [r.kind, r.action]));
const fakeBrowser = {
  async pay({ productUrl, email }) {
    const site = productUrl.replace(/\/shop\/.*$/, '');
    return (await fetch(`${site}/__fake_pay`, { method: 'POST', body: JSON.stringify({ email }) })).json();
  },
};

before(async () => {
  fakes = await startFakes();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-d1-'));
  shopDir = path.join(tmp, 'shop');
  makeShop(shopDir, 'lamp-orders');
  secretsFile = path.join(tmp, 'secrets.json');
  fs.writeFileSync(secretsFile, '', { mode: 0o600 });
  fs.chmodSync(secretsFile, 0o600);
});

after(async () => {
  await fakes.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wrangler.jsonc parses with comments and trailing commas, and a URL keeps its //', () => {
  const cfg = parseJsonc(wranglerJsonc('lamp-orders'));
  assert.equal(cfg.vars.NEXT_PUBLIC_SITE_URL, 'https://lamp-shop.example.workers.dev');
  assert.equal(cfg.d1_databases[0].database_name, 'lamp-orders');
  assert.deepEqual(parseJsonc('{"a": "x, }", /* c */ "b": [1, // d\n],}'), { a: 'x, }', b: [1] });
});

test('plan: no Supabase token needed or read, zero writes, D1 database and its migrations as create', async () => {
  const r = await sent(() => launch('plan'))();
  assert.equal(r.summary.exitCode, 0, r.out);
  assert.deepEqual(r.requests.filter((x) => x.method !== 'GET'), [], 'plan sent no write');
  assert.equal(r.requests.filter((x) => x.path.startsWith('/supabase')).length, 0, 'no Supabase call');
  assert.equal(r.summary.writes, 0);
  assert.deepEqual(actions(r.summary), { d1_database: 'create', d1_migrations: 'create', resend_key: 'create', stripe_webhook: 'create', worker_secrets: 'create' });
  assert.equal(r.summary.resources.find((x) => x.kind === 'd1_migrations').count, 1);
  assert.deepEqual(r.summary.secrets.map((s) => s.name), ['RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CRON_SECRET']);
});

test('apply makes the database and its tables before the first deploy; a second apply is all skip', async () => {
  const first = await sent(() => launch('apply'))();
  assert.equal(first.summary.exitCode, 0, first.out);
  const db = fakes.state.cloudflare.d1.find((d) => d.name === 'lamp-orders');
  assert.ok(db, 'the D1 database exists');
  assert.deepEqual(db.migrations, ['0001_orders.sql']);
  const paths = first.requests.map((x) => `${x.method} ${x.path}`);
  assert.ok(paths.indexOf('POST /cloudflare/fake/d1-migrate') < paths.indexOf('POST /cloudflare/fake/deploy'), 'tables before the deploy');
  assert.equal(first.requests.filter((x) => x.path.startsWith('/supabase')).length, 0, 'no Supabase call');
  assert.deepEqual(first.wrangler.names, ['CRON_SECRET', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], 'no Supabase secret on the Worker');
  const shown = first.out.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
  assert.ok(first.out.includes(`::add-mask::${db.uuid}`) && !shown.includes(db.uuid), 'the database id is masked');

  const second = await sent(() => launch('apply'))();
  assert.equal(second.summary.exitCode, 0, second.out);
  assert.deepEqual(actions(second.summary), { d1_database: 'skip', d1_migrations: 'skip', resend_key: 'skip', stripe_webhook: 'skip', worker_secrets: 'skip' });
  assert.equal(second.summary.writes, 0);
  assert.equal(fakes.state.cloudflare.d1.length, 1, 'still one database');

  fs.writeFileSync(path.join(shopDir, 'd1', 'migrations', '0002_index.sql'), 'create index orders_email on orders (email);\n');
  const third = await launch('apply');
  assert.equal(third.summary.exitCode, 0, third.out);
  assert.equal(actions(third.summary).d1_migrations, 'update');
  assert.deepEqual(db.migrations, ['0001_orders.sql', '0002_index.sql']);
});

test('the smoke reads and marks the order row through D1, not Supabase', async () => {
  const r = await sent(() => launch('smoke', { browser: fakeBrowser }))();
  assert.equal(r.summary.exitCode, 0, r.summary.checks.map((c) => `${c.ok ? 'pass' : 'FAIL'} ${c.title}: ${c.detail}`).join('\n') + r.out);
  assert.equal(r.summary.checks.filter((c) => c.ok).length, 7);
  assert.equal(r.requests.filter((x) => x.path.startsWith('/rest/') || x.path.startsWith('/supabase')).length, 0, 'no Supabase call');
  assert.ok(r.requests.some((x) => /\/d1\/database\/[^/]+\/query$/.test(x.path)), 'read through the D1 query API');
  const row = fakes.state.rows.at(-1);
  assert.equal(row.status, 'refunded');
  assert.ok(row.supplier_order_ref.startsWith(TEST_MARK));
});

test('a wrangler.jsonc binding DB to another database stops plan and apply before any write', async () => {
  const dir = path.join(tmp, 'wrong');
  makeShop(dir, 'someone-elses-db');
  const plan = await launch('plan', { dir });
  assert.equal(plan.summary.exitCode, 1);
  assert.ok(plan.summary.errors.some((e) => /binds DB to "someone-elses-db", not "lamp-orders"/.test(e)), plan.summary.errors.join('\n'));
  assert.equal(actions(plan.summary).d1_migrations, 'blocked');
  const apply = await sent(() => launch('apply', { dir }))();
  assert.equal(apply.summary.exitCode, 1);
  assert.deepEqual(apply.requests.filter((x) => x.method !== 'GET'), [], 'apply stopped before its first write');
});

test('a shop with no d1/migrations is refused: its orders table would never exist', async () => {
  const dir = path.join(tmp, 'empty');
  makeShop(dir, 'lamp-orders');
  fs.rmSync(path.join(dir, 'd1', 'migrations', '0001_orders.sql'));
  const r = await launch('plan', { dir });
  assert.equal(r.summary.exitCode, 1);
  assert.ok(r.summary.errors.some((e) => /no d1\/migrations/.test(e)), r.summary.errors.join('\n'));
});

test('a Cloudflare token without D1 is named as a missing permission', async () => {
  fakes.state.cloudflare.d1Forbidden = true;
  try {
    const r = await launch('plan');
    assert.equal(r.summary.exitCode, 1);
    assert.deepEqual(r.summary.missingPermissions, [{ provider: 'cloudflare', permission: 'Account > D1 > Edit' }]);
    assert.equal(actions(r.summary).d1_database, 'blocked');
  } finally {
    fakes.state.cloudflare.d1Forbidden = false;
  }
});

test('storage other than supabase or d1 is a usage error', async () => {
  const r = await launch('plan', { shopConfig: { ...SHOP, storage: 'mysql' } });
  assert.equal(r.summary.exitCode, 2);
  assert.match(r.summary.errors[0], /storage must be supabase or d1/);
});
