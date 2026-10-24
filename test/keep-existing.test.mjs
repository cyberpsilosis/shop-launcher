// keepExisting (a shop that already runs, the orb), against fake APIs only:
//   1. no Supabase project is ever created: with none named, the project the
//      Worker already points at is kept unread; a named one is looked up; a
//      named one the token cannot see stops the run before any write;
//   2. no existing Worker secret is overwritten, and an existing Resend key
//      or webhook (even one made by hand) is left alone;
//   3. apply sets only the missing names, and plan shows each name keep or set;
//   4. the same Worker without the switch plans exactly as before.

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
const MIGRATION = '20261021120000_orders.sql';
const LEAK_GREP = /whsec_|re_|sb_secret|rk_/; // as test/launch.test.mjs

// What the orb had at plan run 40069123059, as far as names go: its own
// Supabase project (not called shop-orb), its URL as a dashboard variable,
// a hand-made webhook and Resend key the launcher cannot list, and no
// STRIPE_SECRET_KEY or CRON_SECRET on the Worker.
const OWN = { SUPABASE_SERVICE_ROLE_KEY: 'hash-own-service', RESEND_API_KEY: 'hash-own-resend', STRIPE_WEBHOOK_SECRET: 'hash-own-whsec' };

let fakes, tmp, shopDir, secretsFile;

function seedOrb(s, { secrets = OWN, vars = { NEXT_PUBLIC_SUPABASE_URL: 'https://own.example' } } = {}) {
  s.supabase.projects.push({ id: 'ownref01', ref: 'ownref01', name: 'orb-own', organization_id: 'org-fake', status: 'ACTIVE_HEALTHY' });
  s.supabase.migrations.ownref01 = [{ version: '20261021120000', name: 'orders' }];
  s.supabase.keys.ownref01 = [{ name: 'default', type: 'secret', api_key: 'sb_secret_' + 'own'.repeat(6) }];
  s.cloudflare.versions['orb-shop'] = [{ id: 'ver-own', commit: 'c'.repeat(40), secrets: { ...secrets }, vars }];
  s.cloudflare.active['orb-shop'] = 'ver-own';
  s.cloudflare.secrets['orb-shop'] = { ...secrets };
}

async function launch(mode, shopConfig = ORB) {
  let out = '';
  const report = path.join(tmp, `wrangler-${Date.now()}-${Math.random()}.json`);
  const from = fakes.state.requests.length;
  const summary = await run({
    shop: 'orb',
    mode,
    shopConfig,
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
      SUPABASE_ACCESS_TOKEN: 'sbp_' + 'f'.repeat(40),
      SUPABASE_ORG_ID: 'org-fake',
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
const withConfig = (extra) => ({ ...ORB, ...extra, supabase: { ...ORB.supabase, ...(extra.supabase || {}) } });

beforeEach(async () => {
  fakes = await startFakes();
  seedOrb(fakes.state);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-keep-'));
  shopDir = path.join(tmp, 'shop');
  fs.mkdirSync(path.join(shopDir, 'supabase', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(shopDir, 'supabase', 'migrations', MIGRATION), 'create table if not exists orders (id bigint primary key);\n');
  secretsFile = path.join(tmp, 'secrets.json');
  fs.writeFileSync(secretsFile, '', { mode: 0o600 });
  fs.chmodSync(secretsFile, 0o600);
});

afterEach(async () => {
  await fakes.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('shops/orb.json turns keepExisting on and guesses no Supabase project name', () => {
  assert.equal(ORB.keepExisting, true);
  assert.equal(ORB.supabase?.project, undefined);
});

test('orb plan: no project create, every existing name keep, only the two missing names set, zero writes', async () => {
  const r = await launch('plan');
  assert.equal(r.summary.exitCode, 0, r.out);
  assert.deepEqual(r.writes, [], 'plan sent no write');
  assert.equal(r.requests.filter((x) => x.path.startsWith('/supabase')).length, 0, 'the kept project is not read');
  assert.deepEqual(actions(r.summary), { supabase_project: 'keep', supabase_migration: 'keep', resend_key: 'skip', stripe_webhook: 'skip', worker_secrets: 'update' });
  assert.equal(r.summary.resources.find((x) => x.kind === 'worker_secrets').count, 2);
  assert.deepEqual(states(r.summary), {
    NEXT_PUBLIC_SUPABASE_URL: 'keep',
    SUPABASE_SERVICE_ROLE_KEY: 'keep',
    RESEND_API_KEY: 'keep',
    STRIPE_SECRET_KEY: 'set',
    STRIPE_WEBHOOK_SECRET: 'keep',
    CRON_SECRET: 'set',
  });
  assert.equal(r.summary.keepExisting, true);
  assert.equal(r.summary.resources[0].name, "the Worker's own", 'no shop-orb name for a project it never looked up');
  assert.match(r.out, /^secret {3}STRIPE_SECRET_KEY +set$/m);
  assert.match(r.out, /^secret {3}STRIPE_WEBHOOK_SECRET +keep$/m);
  assert.doesNotMatch(r.out, /would be set|create /);
});

test('orb apply: sets only STRIPE_SECRET_KEY and CRON_SECRET, overwrites nothing, makes no project, key or webhook', async () => {
  const r = await launch('apply');
  assert.equal(r.summary.exitCode, 0, r.out);
  assert.deepEqual(r.wrangler.names, ['CRON_SECRET', 'STRIPE_SECRET_KEY'], 'only the missing names reached the deploy');
  assert.deepEqual(r.writes.filter((x) => !x.path.startsWith('/cloudflare/fake/')), [], 'no provider write: no project, key, webhook or migration');
  assert.equal(fakes.state.supabase.projects.length, 1);
  assert.equal(fakes.state.resend.keys.length, 0);
  assert.equal(fakes.state.stripe.endpoints.length, 0);
  const now = fakes.state.cloudflare.secrets['orb-shop'];
  for (const [k, v] of Object.entries(OWN)) assert.equal(now[k], v, `${k} kept its value`);
  assert.deepEqual(Object.keys(now).sort(), ['CRON_SECRET', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']);
  const v = fakes.state.cloudflare.versions['orb-shop'].at(-1);
  assert.deepEqual(Object.keys(v.vars), ['NEXT_PUBLIC_SUPABASE_URL'], 'the dashboard variable stays');

  const again = await launch('apply');
  assert.equal(again.summary.exitCode, 0, again.out);
  assert.equal(again.wrangler, null, 'nothing missing: no deploy');
  assert.equal(again.summary.writes, 0);
  assert.ok(again.summary.secrets.every((s) => s.state === 'keep'));
});

test('a named project is looked up: found is skip, applied migration skip, and only a missing Supabase name is set', async () => {
  const { SUPABASE_SERVICE_ROLE_KEY, ...rest } = OWN;
  fakes.state.cloudflare.secrets['orb-shop'] = { ...rest };
  fakes.state.cloudflare.versions['orb-shop'][0].secrets = { ...rest };
  const cfg = withConfig({ supabase: { project: 'orb-own' } });
  const plan = await launch('plan', cfg);
  assert.equal(plan.summary.exitCode, 0, plan.out);
  assert.equal(actions(plan.summary).supabase_project, 'skip');
  assert.equal(actions(plan.summary).supabase_migration, 'skip');
  assert.deepEqual(states(plan.summary), {
    NEXT_PUBLIC_SUPABASE_URL: 'keep',
    SUPABASE_SERVICE_ROLE_KEY: 'set',
    RESEND_API_KEY: 'keep',
    STRIPE_SECRET_KEY: 'set',
    STRIPE_WEBHOOK_SECRET: 'keep',
    CRON_SECRET: 'set',
  });
  const r = await launch('apply', cfg);
  assert.equal(r.summary.exitCode, 0, r.out);
  assert.deepEqual(r.wrangler.names, ['CRON_SECRET', 'STRIPE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  assert.equal(r.writes.filter((x) => x.path.startsWith('/supabase')).length, 0, 'no project create, no migration');
  assert.equal(fakes.state.supabase.projects.length, 1);
});

test('a named project the token cannot see stops plan and apply before any write; nothing is created', async () => {
  const cfg = withConfig({ supabase: { project: 'not-visible' } });
  const plan = await launch('plan', cfg);
  assert.equal(plan.summary.exitCode, 1);
  assert.equal(actions(plan.summary).supabase_project, 'blocked');
  assert.match(plan.summary.errors.join('\n'), /cannot see a project named "not-visible"; keepExisting never creates one/);
  const r = await launch('apply', cfg);
  assert.equal(r.summary.exitCode, 1);
  assert.deepEqual(r.writes, []);
  assert.equal(r.wrangler, null);
  assert.equal(fakes.state.supabase.projects.length, 1);
});

test('with no project named and a Supabase name missing on the Worker, it stops: never a new project', async () => {
  fakes.state.cloudflare.versions['orb-shop'][0].vars = {};
  const r = await launch('apply');
  assert.equal(r.summary.exitCode, 1);
  assert.equal(actions(r.summary).supabase_project, 'blocked');
  assert.match(r.summary.errors.join('\n'), /names no supabase\.project; keepExisting never creates one/);
  assert.deepEqual(r.writes, []);
  assert.equal(fakes.state.supabase.projects.length, 1);
});

test('the same Worker without the switch plans exactly as before: a new shop-orb project and all six names set', async () => {
  const { keepExisting, ...old } = ORB;
  const r = await launch('plan', old);
  assert.equal(r.summary.exitCode, 0, r.out);
  assert.equal(r.summary.keepExisting, undefined);
  assert.deepEqual(actions(r.summary), { supabase_project: 'create', supabase_migration: 'create', resend_key: 'create', stripe_webhook: 'create', worker_secrets: 'update' });
  assert.equal(r.summary.resources[0].name, 'shop-orb');
  assert.ok(r.summary.secrets.every((s) => s.state === 'set'));
  assert.match(r.out, /would be set/);
  assert.equal(r.requests.filter((x) => /\/deployments$|\/versions\//.test(x.path)).length, 0, 'no extra Cloudflare read');
});

test('keepExisting must be true or false', async () => {
  const r = await launch('plan', withConfig({ keepExisting: 'yes' }));
  assert.equal(r.summary.exitCode, 2);
  assert.match(r.summary.errors.join('\n'), /keepExisting must be true or false/);
  assert.deepEqual(r.requests, []);
});
