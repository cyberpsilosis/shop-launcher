// Acceptance test for piece 3 (mode=live and mode=rollback), against fake APIs:
//   1. a live dispatch without Elijah's approval stays waiting and reads no live
//      secret (dry run of launch.yml as GitHub schedules it, plus the launcher
//      itself refusing to start without the key);
//   2. live makes its own Worker version on the live key and a live webhook;
//   3. rollback returns the test-key version, then disables the live webhook.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startFakes } from './fake-apis.mjs';
import { dryRun, readLaunch } from '../scripts/dispatch-dry-run.mjs';
import { LIVE_MARK } from '../src/launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCH = path.join(ROOT, 'src', 'launch.mjs');
const SECRETS_SH = path.join(ROOT, 'scripts', 'secrets-file.sh');
const WRANGLER = path.join(ROOT, 'test', 'fake-wrangler.mjs');
const TEST_KEY = 'rk_test_' + 'FAKE0123456789abcdefFAKE';
const LIVE_KEY = 'rk_live_' + 'FAKElive0123456789abcdef';
const LEAK = /whsec_|re_[A-Za-z0-9]{6}|sb_secret|rk_|cs_test_|pi_[a-f0-9]/;
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const sha = (v) => createHash('sha256').update(v).digest('hex');

let fakes, tmp, shopDir, runnerTemp;
const logs = [];

function spawnLaunch(args, env) {
  return new Promise((resolve) => {
    const c = spawn('node', args, { env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => c.kill(), 20000);
    c.on('close', (status) => {
      clearTimeout(t);
      resolve({ status, out });
    });
  });
}

// The environment each job of launch.yml would give the launcher.
function jobEnv(job) {
  const common = { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, ...fakes.env, FAKE_WORKER: 'orb-shop', CLOUDFLARE_ACCOUNT_ID: 'acc-fake' };
  if (job === 'provision') {
    return { ...common, SUPABASE_ACCESS_TOKEN: 'sbp_' + 'f'.repeat(40), SUPABASE_ORG_ID: 'org-fake', RESEND_ADMIN_KEY: 're_' + 'ADMINfakeADMINfake', STRIPE_SECRET_KEY: TEST_KEY, CLOUDFLARE_API_TOKEN: 'cf-token-' + 'x'.repeat(30) };
  }
  return { ...common, STRIPE_LIVE_KEY: LIVE_KEY, CLOUDFLARE_API_TOKEN: 'cf-token-' + 'x'.repeat(30) };
}

async function launch(mode, { commit = C1, step, job = mode === 'live' || step === 'endpoint' ? 'live' : 'provision', env = {} } = {}) {
  const summaryJson = path.join(runnerTemp, `summary-${mode}-${Date.now()}.json`);
  const args = [LAUNCH, '--shop', 'orb', '--mode', mode, '--shop-dir', shopDir, '--summary-json', summaryJson, '--deploy-cmd', `node ${WRANGLER}`, '--expect-commit', commit];
  if (step) args.push('--step', step);
  if (mode === 'smoke') args.push('--browser', 'fake');
  let file;
  if (mode === 'apply' || mode === 'live') {
    file = execFileSync(SECRETS_SH, ['create'], { env: { ...process.env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8' }).trim();
    args.push('--secrets-file', file);
  }
  const r = await spawnLaunch(args, { ...jobEnv(job), ...env });
  if (file) execFileSync(SECRETS_SH, ['delete', file], { env: { ...process.env, RUNNER_TEMP: runnerTemp } });
  const summary = fs.existsSync(summaryJson) ? JSON.parse(fs.readFileSync(summaryJson, 'utf8')) : null;
  logs.push(r.out, JSON.stringify(summary));
  return { code: r.status, out: r.out, summary };
}

const cf = () => fakes.state.cloudflare;
const active = () => cf().versions['orb-shop'].find((v) => v.id === cf().active['orb-shop']);
const liveEndpoints = () => fakes.state.stripe.endpoints.filter((e) => e.livemode);
const testEndpoints = () => fakes.state.stripe.endpoints.filter((e) => !e.livemode);

before(async () => {
  fakes = await startFakes();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
  runnerTemp = path.join(tmp, 'runner-temp');
  fs.mkdirSync(runnerTemp);
  shopDir = path.join(tmp, 'shop');
  fs.mkdirSync(path.join(shopDir, 'supabase', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(shopDir, 'supabase', 'migrations', '20261021120000_orders.sql'), 'create table if not exists orders (id bigint primary key);\n');
  const a = await launch('apply');
  assert.equal(a.code, 0, a.out);
  const s = await launch('smoke');
  assert.equal(s.code, 0, s.out);
});

after(async () => {
  await fakes.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 1. The gate -----------------------------------------------------------

test('acceptance: a live dispatch without approval stays waiting and reads no live secret', () => {
  const jobs = dryRun(readLaunch(ROOT), { mode: 'live', shop: 'orb' });
  assert.deepEqual(jobs.map((j) => [j.job, j.status]), [['check', 'ran'], ['launch', 'skipped'], ['live', 'waiting']]);
  const read = jobs.flatMap((j) => j.secrets);
  assert.deepEqual(read, [], 'no job that started names any secret');
  // Once approved, the live job is the one, and the only one, that reads the live key.
  const ok = dryRun(readLaunch(ROOT), { mode: 'live', shop: 'orb', approved: true });
  assert.equal(ok.find((j) => j.job === 'live').status, 'ran');
  assert.deepEqual(ok.filter((j) => j.secrets.includes('STRIPE_RK_LIVE__ORB')).map((j) => j.job), ['live']);
});

test('plan, apply and smoke never ask for the live environment; rollback asks only after the Worker is back', () => {
  for (const mode of ['plan', 'apply', 'smoke']) {
    const jobs = dryRun(readLaunch(ROOT), { mode, shop: 'orb' });
    assert.equal(jobs.find((j) => j.job === 'live').status, 'skipped', mode);
    assert.ok(!jobs.some((j) => j.secrets.some((s) => s.startsWith('STRIPE_RK_LIVE'))), mode);
  }
  const rb = dryRun(readLaunch(ROOT), { mode: 'rollback', shop: 'orb' });
  assert.deepEqual(rb.map((j) => [j.job, j.status]), [['check', 'ran'], ['launch', 'ran'], ['live', 'waiting']]);
  assert.ok(!rb.find((j) => j.job === 'launch').secrets.some((s) => s.startsWith('STRIPE_RK_LIVE')));
  // A failed Worker rollback does not go on to touch the live webhook.
  const red = dryRun(readLaunch(ROOT), { mode: 'rollback', shop: 'orb', approved: true, outcomes: { launch: 'failure' } });
  assert.equal(red.find((j) => j.job === 'live').status, 'skipped');
  // A refused request (bad slug, other branch) never reaches the live job.
  const bad = dryRun(readLaunch(ROOT), { mode: 'live', shop: 'orb', approved: true, outcomes: { check: 'failure' } });
  assert.equal(bad.find((j) => j.job === 'live').status, 'skipped');
});

test('the launcher keeps the live key to live and rollback/endpoint', async () => {
  const before = fakes.state.requests.length;
  const noKey = await launch('live', { job: 'provision' });
  assert.equal(noKey.code, 2);
  assert.match(noKey.out, /missing environment values: STRIPE_LIVE_KEY/);
  for (const [mode, step] of [['smoke'], ['plan'], ['rollback', 'worker']]) {
    const r = await launch(mode, { step, env: { STRIPE_LIVE_KEY: LIVE_KEY } });
    assert.equal(r.code, 2, `${mode} ${step || ''}`);
    assert.match(r.out, /STRIPE_LIVE_KEY reached mode/);
  }
  const secretKey = await launch('live', { env: { STRIPE_LIVE_KEY: 'sk_live_' + 'Z'.repeat(24) } });
  assert.equal(secretKey.code, 2);
  assert.match(secretKey.out, /restricted live-mode key/);
  assert.equal(fakes.state.requests.length, before, 'every refusal came before any call');
});

// ---- 2 and 3. Live, rollback, live again -------------------------------------

test('live refuses a commit the smoke did not prove', async () => {
  const r = await launch('live', { commit: C2 });
  assert.equal(r.code, 1);
  assert.match(r.out, /run a green smoke on main before going live/);
  assert.equal(liveEndpoints().length, 0);
  assert.ok(!(LIVE_MARK in active().secrets));
});

test('live: its own Worker version on the live key and a live webhook; the test webhook stays', async () => {
  const testVersion = active().id;
  const r = await launch('live');
  assert.equal(r.code, 0, r.out);
  assert.notEqual(active().id, testVersion, 'a new version');
  assert.equal(active().secrets.STRIPE_SECRET_KEY, sha(LIVE_KEY));
  assert.ok(LIVE_MARK in active().secrets);
  assert.equal(liveEndpoints().length, 1);
  assert.equal(active().secrets.STRIPE_WEBHOOK_SECRET.length, 64);
  assert.equal(liveEndpoints()[0].status, 'enabled');
  assert.equal(testEndpoints().length, 1);
  assert.deepEqual(r.summary.checks.map((c) => [c.id, c.ok]), [['pages', true]]);
  assert.equal(active().commit, C1);

  const again = await launch('live');
  assert.equal(again.code, 0);
  assert.match(again.out, /is on its live key already/);
  assert.equal(liveEndpoints().length, 1, 'no second live webhook');

  const smoke = await launch('smoke');
  assert.equal(smoke.code, 1);
  assert.match(smoke.out, /run mode=rollback before apply or smoke/);
});

test('rollback: the Worker returns to the test-key version, then the live webhook is disabled', async () => {
  const w = await launch('rollback', { step: 'worker' });
  assert.equal(w.code, 0, w.out);
  assert.equal(active().secrets.STRIPE_SECRET_KEY, sha(TEST_KEY));
  assert.ok(!(LIVE_MARK in active().secrets));
  assert.equal(active().commit, C1);
  assert.equal(liveEndpoints()[0].status, 'enabled', 'job 2 has not run yet');

  const e = await launch('rollback', { step: 'endpoint' });
  assert.equal(e.code, 0, e.out);
  assert.equal(liveEndpoints().length, 1);
  assert.equal(liveEndpoints()[0].status, 'disabled');
  assert.equal(testEndpoints()[0].status, 'enabled');

  // Both steps again: nothing to do.
  assert.match((await launch('rollback', { step: 'worker' })).out, /test-key version already/);
  assert.match((await launch('rollback', { step: 'endpoint' })).out, /0 live endpoint\(s\) disabled, 1 already off/);
  // Back on test keys, the smoke runs again.
  assert.equal((await launch('smoke')).code, 0);
});

test('live again after a rollback replaces the disabled webhook', async () => {
  const old = liveEndpoints()[0].id;
  const r = await launch('live');
  assert.equal(r.code, 0, r.out);
  assert.equal(liveEndpoints().length, 1);
  assert.notEqual(liveEndpoints()[0].id, old);
  assert.equal(liveEndpoints()[0].status, 'enabled');
  assert.equal((await launch('rollback', { step: 'worker' })).code, 0);
  assert.equal((await launch('rollback', { step: 'endpoint' })).code, 0);
});

test('a live version whose pages fail rolls itself back and removes its new webhook', async () => {
  const testVersion = active().id;
  const kept = liveEndpoints().map((e) => e.id);
  fakes.state.shop.pagesFail = ['/'];
  const r = await launch('live');
  fakes.state.shop.pagesFail = [];
  assert.equal(r.code, 1);
  assert.equal(active().id, testVersion);
  assert.equal(active().secrets.STRIPE_SECRET_KEY, sha(TEST_KEY));
  assert.ok(r.summary.rollback.ok, JSON.stringify(r.summary.rollback));
  assert.deepEqual(liveEndpoints().map((e) => e.id), kept, 'the new live webhook is gone');
});

test('no key, webhook secret or id in any live or rollback log or summary', () => {
  // As GitHub shows the log: the runner swallows its own ::add-mask:: commands.
  const all = logs.join('\n').split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
  assert.ok(all.length > 0);
  assert.doesNotMatch(all, LEAK);
  assert.ok(!all.includes(LIVE_KEY.slice(8)));
  for (const v of fakes.state.issued) assert.ok(!all.includes(v));
  for (const v of cf().versions['orb-shop']) assert.ok(!all.includes(v.id), 'version ids are masked');
});
