// Acceptance test for piece 2 (mode=smoke), against fake APIs and a fake shop:
//   1. a green run shows 7 passes, refunds the test payment and marks the row test;
//   2. a forced failure rolls back: /api/version is the previous commit again;
//   3. the rollback test: deploy v1 PROBE=a, v2 PROBE=b, roll back, /api/probe is the hash of a;
//   4. old provider keys are deleted only after a green smoke.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startFakes } from './fake-apis.mjs';
import { createHttp } from '../src/http.mjs';
import { cloudflare } from '../src/providers.mjs';
import { markdown } from '../src/launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCH = path.join(ROOT, 'src', 'launch.mjs');
const SECRETS_SH = path.join(ROOT, 'scripts', 'secrets-file.sh');
const WRANGLER = path.join(ROOT, 'test', 'fake-wrangler.mjs');
const LEAK = /whsec_|re_[A-Za-z0-9]{6}|sb_secret|rk_|cs_test_|pi_[a-f0-9]/;
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const C3 = 'c'.repeat(40);

let fakes, tmp, shopDir, runnerTemp;
const logs = [];

function run(args, env) {
  return new Promise((resolve) => {
    const c = spawn('node', args, { env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => c.kill(), 20000); // a hung launch fails the test instead of the suite
    c.on('close', (status) => {
      clearTimeout(t);
      resolve({ status, out });
    });
  });
}

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RUNNER_TEMP: runnerTemp,
    ...fakes.env,
    FAKE_WORKER: 'orb-shop',
    SUPABASE_ACCESS_TOKEN: 'sbp_' + 'f'.repeat(40),
    SUPABASE_ORG_ID: 'org-fake',
    RESEND_ADMIN_KEY: 're_' + 'ADMINfakeADMINfake',
    STRIPE_SECRET_KEY: 'rk_test_' + 'FAKE0123456789abcdefFAKE',
    CLOUDFLARE_API_TOKEN: 'cf-token-' + 'x'.repeat(30),
    CLOUDFLARE_ACCOUNT_ID: 'acc-fake',
    ...extra,
  };
}

async function launch(mode, { commit, env = {} } = {}) {
  const summaryJson = path.join(runnerTemp, `summary-${mode}-${Date.now()}.json`);
  const stepSummary = path.join(runnerTemp, `step-${Date.now()}.md`);
  const args = [LAUNCH, '--shop', 'orb', '--mode', mode, '--shop-dir', shopDir, '--summary-json', summaryJson, '--deploy-cmd', `node ${WRANGLER}`];
  let file;
  if (mode === 'apply') {
    file = execFileSync(SECRETS_SH, ['create'], { env: { ...process.env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8' }).trim();
    args.push('--secrets-file', file);
  }
  if (mode === 'smoke' || env.BROWSER) args.push('--browser', 'fake');
  if (commit) args.push('--expect-commit', commit);
  const r = await run(args, baseEnv({ GITHUB_STEP_SUMMARY: stepSummary, ...env }));
  if (file) execFileSync(SECRETS_SH, ['delete', file], { env: { ...process.env, RUNNER_TEMP: runnerTemp } });
  const summary = fs.existsSync(summaryJson) ? JSON.parse(fs.readFileSync(summaryJson, 'utf8')) : null;
  const page = fs.existsSync(stepSummary) ? fs.readFileSync(stepSummary, 'utf8') : '';
  logs.push(r.out, page, JSON.stringify(summary));
  return { code: r.status, out: r.out, summary, page };
}

const version = () => fetch(`${fakes.base}/site/api/version`).then((r) => r.json()).then((j) => j.commit);

before(async () => {
  fakes = await startFakes();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'));
  runnerTemp = path.join(tmp, 'runner-temp');
  fs.mkdirSync(runnerTemp);
  shopDir = path.join(tmp, 'shop');
  fs.mkdirSync(path.join(shopDir, 'supabase', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(shopDir, 'supabase', 'migrations', '20261021120000_orders.sql'), 'create table if not exists orders (id bigint primary key);\n');
  const a = await launch('apply', { commit: C1 });
  assert.equal(a.code, 0, a.out);
  assert.equal(await version(), C1);
});

after(async () => {
  await fakes.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('acceptance 1: a green smoke shows 7 passes, refunds the payment and marks the row test', async () => {
  const r = await launch('smoke', { commit: C2 });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.summary.ok, true);
  assert.equal(r.summary.checks.length, 7);
  assert.deepEqual(r.summary.checks.map((c) => c.ok), [true, true, true, true, true, true, true]);
  assert.equal(r.summary.rollback, null, 'no rollback on green');
  assert.equal(await version(), C2, 'the new commit stays live');
  assert.match(r.page, /Smoke: 7 of 7 passed/);
  const row = fakes.state.rows.at(-1);
  assert.equal(row.status, 'refunded');
  assert.match(row.supplier_order_ref, /^test: shop-launcher smoke/);
  assert.equal(row.tracking_number, 'LP00123456789CN');
  assert.equal(row.email, 'delivered@resend.dev', 'buyer email is Resend\'s test inbox, nobody real');
  assert.equal(fakes.state.stripe.refunds.at(-1).payment_intent, row.stripe_payment_intent);
});

test('acceptance 2: a forced failure rolls back to the previous commit and still refunds', async () => {
  fakes.state.shop.sendAlert = false; // the shop "forgets" the alert email
  const before = fakes.state.stripe.refunds.length;
  const r = await launch('smoke', { commit: C3 });
  fakes.state.shop.sendAlert = true;
  assert.equal(r.code, 1);
  const states = r.summary.checks.map((c) => (c.ok ? 'pass' : c.skipped ? 'skip' : 'FAIL'));
  assert.deepEqual(states, ['pass', 'pass', 'pass', 'pass', 'FAIL', 'skip', 'skip']);
  assert.match(r.summary.checks[4].detail, /alert_email_at is still empty/);
  assert.equal(r.summary.rollback.ok, true, JSON.stringify(r.summary.rollback));
  assert.equal(await version(), C2, '/api/version is on the previous commit');
  assert.equal(fakes.state.stripe.refunds.length, before + 1, 'the test payment is refunded anyway');
  assert.equal(fakes.state.rows.at(-1).status, 'refunded');
  assert.match(r.page, /\| 5 \| Order alert email sent \| FAIL \| alert_email_at is still empty on the row \|/);
});

test('each check fails with its own one-line reason', async () => {
  const cases = [
    [{ pagesFail: ['/returns'] }, 0, /\/returns answered 500/],
    [{ webhookAnswers: 500 }, 2, /undelivered webhook/],
    [{ writeRow: false }, 2, /no row for the session/],
  ];
  for (const [flip, at, why] of cases) {
    const saved = { ...fakes.state.shop };
    Object.assign(fakes.state.shop, flip);
    const r = await launch('smoke', { commit: C2, env: {} });
    fakes.state.shop = saved;
    assert.equal(r.code, 1, r.out.split('\n').filter((l) => !l.startsWith('::add-mask')).slice(-12).join('\n'));
    assert.equal(r.summary.checks.findIndex((c) => !c.ok), at, JSON.stringify(r.summary.checks));
    assert.match(r.summary.checks[at].detail, why);
  }
});

test('acceptance 3: rollback restores code and secrets (PROBE a, PROBE b, roll back, hash of a)', async () => {
  const env = baseEnv();
  // The fakes live in this process, so wrangler runs beside it (never execFileSync).
  const deployWith = async (probe) => {
    const f = path.join(runnerTemp, 'probe.json');
    fs.writeFileSync(f, JSON.stringify({ PROBE: probe }), { mode: 0o600 });
    assert.equal((await run([WRANGLER, 'deploy', '--secrets-file', f], env)).status, 0);
    fs.rmSync(f);
  };
  const cf = cloudflare(createHttp({ mode: 'apply' }), fakes.env.CLOUDFLARE_API_URL, env);
  await deployWith('a');
  const v1 = await cf.activeVersion('orb-shop');
  await deployWith('b');
  const probe = () => fetch(`${fakes.base}/site/api/probe`).then((r) => r.json()).then((j) => j.probe);
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  assert.equal(await probe(), sha('b'));
  assert.equal((await run([WRANGLER, 'rollback', v1], env)).status, 0);
  assert.equal(await probe(), sha('a'));
});

test('acceptance 4: a rotated key is kept through apply and deleted only after a green smoke', async () => {
  delete fakes.state.cloudflare.secrets['orb-shop'].RESEND_API_KEY;
  const a = await launch('apply', { commit: C2 });
  assert.equal(a.code, 0, a.out);
  assert.equal(fakes.state.resend.keys.length, 2, 'old key kept after apply');
  fakes.state.shop.sendAlert = false;
  const red = await launch('smoke', { commit: C2 });
  fakes.state.shop.sendAlert = true;
  assert.equal(red.code, 1);
  assert.equal(fakes.state.resend.keys.length, 2, 'a red smoke deletes nothing');
  const green = await launch('smoke', { commit: C2 });
  assert.equal(green.code, 0, green.out);
  assert.equal(fakes.state.resend.keys.length, 1, 'the old key goes after the green smoke');
  assert.deepEqual(green.summary.retired, { resend_key: 1, stripe_webhook: 0 });
});

test('apply --browser runs the smoke itself after a rotation, and a red one undoes the new key', async () => {
  const keys = fakes.state.resend.keys.map((k) => k.id);
  delete fakes.state.cloudflare.secrets['orb-shop'].RESEND_API_KEY;
  fakes.state.shop.sendAlert = false;
  const r = await launch('apply', { commit: C2, env: { BROWSER: '1' } });
  fakes.state.shop.sendAlert = true;
  assert.equal(r.code, 1);
  assert.equal(r.summary.rollback.ok, true);
  assert.deepEqual(fakes.state.resend.keys.map((k) => k.id), keys, 'new key removed, old key still there');
});

test('smoke without a commit to compare fails check 1, and the summary page names it', async () => {
  const r = await launch('smoke', {});
  assert.equal(r.code, 1);
  assert.match(r.summary.checks[0].detail, /\/api\/version says/);
  const md = markdown(r.summary);
  assert.match(md, /\| 1 \| Pages answer 200 and \/api\/version is main \| FAIL \|/);
});

test('no secret, session, payment or order token in any smoke log or summary', () => {
  const all = logs.join('\n').split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
  assert.doesNotMatch(all, LEAK);
  for (const row of fakes.state.rows) assert.ok(!all.includes(row.id), 'order id masked');
  for (const t of fakes.state.issued) assert.ok(!all.includes(t), 'issued secret masked');
});
