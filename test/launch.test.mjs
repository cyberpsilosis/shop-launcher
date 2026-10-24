// Acceptance test for piece 1, against fake APIs only:
//   1. plan sends zero writes;
//   2. apply twice: one create set, then everything skip;
//   3. a grep of every log line and summary for whsec_, re_, sb_secret, rk_ finds nothing.
// Plus the guards around them.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakes } from './fake-apis.mjs';
import { createHttp, apiBases, PlanWriteRefused } from '../src/http.mjs';
import { createLog } from '../src/log.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCH = path.join(ROOT, 'src', 'launch.mjs');
const SECRETS_SH = path.join(ROOT, 'scripts', 'secrets-file.sh');
const FAKE_WRANGLER = `node ${path.join(ROOT, 'test', 'fake-wrangler.mjs')}`;
export const LEAK_GREP = /whsec_|re_|sb_secret|rk_/;

const STRIPE_TEST_KEY = 'rk_test_' + 'FAKE0123456789abcdefFAKE';
let fakes;
let tmp;
let shopDir;
let runnerTemp;
const allLogs = []; // everything a launch printed, as the GitHub job log would show it

// What GitHub does to a step's output: `::add-mask::` lines are swallowed and
// each masked value becomes *** in every later line.
export function asGithubShowsIt(raw) {
  const masks = [];
  const shown = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^::add-mask::(.*)$/);
    if (m) masks.push(m[1]);
    else shown.push(line);
  }
  let text = shown.join('\n');
  for (const v of masks.sort((a, b) => b.length - a.length)) text = text.split(v).join('***');
  return text;
}

// The fakes live in this process, so the launcher must run beside it, not block it.
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function launch(mode, { env = {}, secretsFile } = {}) {
  const summaryJson = path.join(runnerTemp, `summary-${mode}-${Date.now()}.json`);
  const stepSummary = path.join(runnerTemp, 'step-summary.md');
  const report = path.join(tmp, `wrangler-${Date.now()}.json`);
  const args = [LAUNCH, '--shop', 'orb', '--mode', mode, '--shop-dir', shopDir, '--summary-json', summaryJson, '--deploy-cmd', FAKE_WRANGLER];
  if (secretsFile) args.push('--secrets-file', secretsFile);
  const r = await spawnAsync('node', args, {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: stepSummary,
      ...fakes.env,
      FAKE_WORKER: 'orb-shop',
      FAKE_REPORT: report,
      SUPABASE_ACCESS_TOKEN: 'sbp_' + 'f'.repeat(40),
      SUPABASE_ORG_ID: 'org-fake',
      RESEND_ADMIN_KEY: 're_' + 'ADMINfakeADMINfake',
      STRIPE_SECRET_KEY: STRIPE_TEST_KEY,
      CLOUDFLARE_API_TOKEN: 'cf-token-' + 'x'.repeat(30),
      CLOUDFLARE_ACCOUNT_ID: 'acc-fake',
      ...env,
    },
  });
  const raw = r.stdout + r.stderr;
  const files = [summaryJson, stepSummary].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
  allLogs.push({ mode, raw, files });
  return {
    code: r.status,
    raw,
    shown: asGithubShowsIt(raw),
    summary: fs.existsSync(summaryJson) ? JSON.parse(fs.readFileSync(summaryJson, 'utf8')) : null,
    wrangler: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null,
  };
}

const makeSecretsFile = () => execFileSync(SECRETS_SH, ['create'], { env: { ...process.env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8' }).trim();
const deleteSecretsFile = (f) => execFileSync(SECRETS_SH, ['delete', f], { env: { ...process.env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8' });

before(async () => {
  fakes = await startFakes();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  runnerTemp = path.join(tmp, 'runner-temp');
  fs.mkdirSync(runnerTemp);
  shopDir = path.join(tmp, 'shop');
  fs.mkdirSync(path.join(shopDir, 'supabase', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(shopDir, 'supabase', 'migrations', '20261021120000_orders.sql'), 'create table if not exists orders (id bigint primary key);\n');
});

after(async () => {
  await fakes.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('acceptance 1: plan sends zero writes and plans every resource as create', async () => {
  const before = fakes.state.requests.length;
  const r = await launch('plan');
  assert.equal(r.code, 0, r.shown);
  const sent = fakes.state.requests.slice(before);
  assert.ok(sent.length >= 5, 'plan read every provider');
  assert.deepEqual(sent.filter((x) => x.method !== 'GET'), [], 'plan sent no write');
  assert.equal(r.summary.writes, 0);
  const actions = Object.fromEntries(r.summary.resources.map((x) => [x.kind, x.action]));
  assert.deepEqual(actions, { supabase_project: 'create', supabase_migration: 'create', resend_key: 'create', stripe_webhook: 'create', worker_secrets: 'create' });
  assert.ok(r.summary.secrets.every((s) => s.state === 'set'));
  assert.match(r.shown, /would be set/);
});

test('acceptance 2: first apply creates one of each, second apply skips everything', async () => {
  const f1 = makeSecretsFile();
  const first = await launch('apply', { secretsFile: f1 });
  deleteSecretsFile(f1);
  assert.equal(first.code, 0, first.shown);
  assert.ok(!fs.existsSync(f1), 'secrets file deleted');
  assert.ok(first.summary.resources.every((x) => x.action === 'create'), JSON.stringify(first.summary.resources));
  assert.ok(first.summary.secrets.every((s) => s.state === 'set'));
  assert.equal(fakes.state.supabase.projects.length, 1);
  assert.equal(fakes.state.supabase.migrations[fakes.state.supabase.projects[0].ref].length, 1);
  assert.equal(fakes.state.resend.keys.length, 1);
  assert.equal(fakes.state.resend.keys[0].permission, 'sending_access');
  assert.equal(fakes.state.stripe.endpoints.length, 1);
  const ep = fakes.state.stripe.endpoints[0];
  assert.equal(ep.url, 'https://orb-shop.elijahedington.workers.dev/api/stripe/webhook');
  assert.deepEqual(ep.enabled_events, ['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
  assert.equal(ep.metadata.shop, 'orb');
  assert.deepEqual(Object.keys(fakes.state.cloudflare.secrets['orb-shop']).sort(), [
    'CRON_SECRET', 'NEXT_PUBLIC_SUPABASE_URL', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  // The deploy step saw a mode-600 file and no provider token but Cloudflare's.
  assert.equal(first.wrangler.mode, '600');
  for (const k of ['SUPABASE_ACCESS_TOKEN', 'RESEND_ADMIN_KEY', 'STRIPE_SECRET_KEY']) assert.ok(!first.wrangler.envNames.includes(k), `${k} reached the deploy`);

  const writesBefore = fakes.writes().length;
  const f2 = makeSecretsFile();
  const second = await launch('apply', { secretsFile: f2 });
  deleteSecretsFile(f2);
  assert.equal(second.code, 0, second.shown);
  assert.ok(second.summary.resources.every((x) => x.action === 'skip'), JSON.stringify(second.summary.resources));
  assert.ok(second.summary.secrets.every((s) => s.state === 'unchanged'));
  assert.equal(second.summary.writes, 0);
  assert.equal(fakes.writes().length, writesBefore, 'second apply wrote nothing');
  assert.equal(second.wrangler, null, 'no deploy when nothing changed');
  assert.equal(fakes.state.supabase.projects.length, 1);
  assert.equal(fakes.state.resend.keys.length, 1);
  assert.equal(fakes.state.stripe.endpoints.length, 1);
});

test('a lost webhook secret is rotated: new endpoint first, old one kept until a green smoke', async () => {
  const oldId = fakes.state.stripe.endpoints[0].id;
  delete fakes.state.cloudflare.secrets['orb-shop'].STRIPE_WEBHOOK_SECRET;
  const f = makeSecretsFile();
  const r = await launch('apply', { secretsFile: f });
  deleteSecretsFile(f);
  assert.equal(r.code, 0, r.shown);
  assert.equal(r.summary.resources.find((x) => x.kind === 'stripe_webhook').action, 'rotate');
  assert.deepEqual(r.wrangler.names, ['STRIPE_WEBHOOK_SECRET']);
  assert.equal(fakes.state.stripe.endpoints.length, 2, 'old webhook kept: no smoke ran');
  assert.equal(fakes.state.stripe.endpoints[0].id, oldId);
  assert.deepEqual(r.summary.oldKept, { resend_key: 0, stripe_webhook: 1 });
});

test('a deploy tool that prints values still leaks nothing', async () => {
  delete fakes.state.cloudflare.secrets['orb-shop'].CRON_SECRET;
  delete fakes.state.cloudflare.secrets['orb-shop'].SUPABASE_SERVICE_ROLE_KEY;
  const f = makeSecretsFile();
  const r = await launch('apply', { secretsFile: f, env: { FAKE_WRANGLER_LEAK: '1' } });
  deleteSecretsFile(f);
  assert.equal(r.code, 0, r.shown);
  assert.match(r.raw, /debug: secrets/);
  assert.doesNotMatch(r.raw.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n'), LEAK_GREP);
});

test('a failed deploy removes the key and webhook it made; the next run rotates cleanly', async () => {
  const oldKeys = fakes.state.resend.keys.map((k) => k.id);
  const oldEps = fakes.state.stripe.endpoints.map((e) => e.id);
  delete fakes.state.cloudflare.secrets['orb-shop'].RESEND_API_KEY;
  delete fakes.state.cloudflare.secrets['orb-shop'].STRIPE_WEBHOOK_SECRET;
  const f1 = makeSecretsFile();
  const failed = await launch('apply', { secretsFile: f1, env: { FAKE_WRANGLER_FAIL: '1' } });
  deleteSecretsFile(f1);
  assert.equal(failed.code, 1);
  assert.equal(failed.summary.ok, false);
  assert.deepEqual(fakes.state.resend.keys.map((k) => k.id), oldKeys, 'new key removed, old key kept');
  assert.deepEqual(fakes.state.stripe.endpoints.map((e) => e.id), oldEps, 'new webhook removed, old one kept');
  const f2 = makeSecretsFile();
  const ok = await launch('apply', { secretsFile: f2 });
  deleteSecretsFile(f2);
  assert.equal(ok.code, 0, ok.shown);
  assert.equal(fakes.state.resend.keys.length, oldKeys.length + 1, 'one new key; the old one waits for a green smoke');
  assert.ok(!oldKeys.includes(fakes.state.resend.keys.at(-1).id));
  assert.equal(fakes.state.stripe.endpoints.length, oldEps.length + 1);
  assert.ok(!oldEps.includes(fakes.state.stripe.endpoints.at(-1).id));
});

test('plan names a missing Supabase permission and still writes nothing', async () => {
  fakes.state.supabase.missingPermissions = ['organization_projects_read'];
  const before = fakes.state.requests.length;
  const r = await launch('plan');
  fakes.state.supabase.missingPermissions = null;
  assert.equal(r.code, 1);
  assert.deepEqual(r.summary.missingPermissions, [{ provider: 'supabase', permission: 'organization_projects_read' }]);
  assert.match(r.shown, /missing permission: organization_projects_read/);
  assert.equal(fakes.state.requests.slice(before).filter((x) => x.method !== 'GET').length, 0);
});

test('apply stops before its first write when a read fails', async () => {
  fakes.state.supabase.missingPermissions = ['projects_read'];
  const before = fakes.state.requests.length;
  const f = makeSecretsFile();
  const r = await launch('apply', { secretsFile: f });
  deleteSecretsFile(f);
  fakes.state.supabase.missingPermissions = null;
  assert.equal(r.code, 1);
  assert.match(r.shown, /apply stopped before its first write/);
  assert.equal(fakes.state.requests.slice(before).filter((x) => x.method !== 'GET').length, 0);
});

test('token expiry inside 14 days is a warning', async () => {
  fakes.state.cloudflare.tokenExpiresOn = new Date(Date.now() + 5 * 86400000).toISOString();
  const r = await launch('plan', { env: { RESEND_ADMIN_KEY_EXPIRES_ON: new Date(Date.now() + 2 * 86400000).toISOString() } });
  fakes.state.cloudflare.tokenExpiresOn = null;
  assert.equal(r.code, 0, r.shown);
  assert.deepEqual(r.summary.warnings.map((w) => w.token).sort(), ['CLOUDFLARE_API_TOKEN', 'RESEND_ADMIN_KEY']);
  assert.match(r.shown, /::warning::token CLOUDFLARE_API_TOKEN: expires/);
});

test('live and rollback are refused with the piece they belong to', async () => {
  for (const [mode, piece] of [['live', 'piece 3'], ['rollback', 'piece 3']]) {
    const before = fakes.state.requests.length;
    const r = await launch(mode);
    assert.equal(r.code, 2);
    assert.match(r.shown, new RegExp(`mode "${mode}" is not built yet: it arrives with ${piece}`));
    assert.equal(fakes.state.requests.length, before, `${mode} made no call at all`);
  }
});

test('a live Stripe key is refused before any call', async () => {
  const before = fakes.state.requests.length;
  const r = await launch('plan', { env: { STRIPE_SECRET_KEY: 'rk_live_' + 'Z'.repeat(24) } });
  assert.equal(r.code, 2);
  assert.match(r.shown, /live-mode key/);
  assert.equal(fakes.state.requests.length, before);
});

test('apply refuses a secrets file that is not mode 600', async () => {
  const f = makeSecretsFile();
  fs.chmodSync(f, 0o644);
  delete fakes.state.cloudflare.secrets['orb-shop'].CRON_SECRET;
  const r = await launch('apply', { secretsFile: f });
  assert.equal(r.code, 1);
  assert.match(r.shown, /secrets file must be mode 600/);
  assert.equal(fs.readFileSync(f, 'utf8'), '', 'nothing written to it');
  deleteSecretsFile(f);
});

test('plan mode refuses a write inside the HTTP client, before fetch', async () => {
  let fetched = 0;
  const h = createHttp({ mode: 'plan', fetchImpl: async () => (fetched++, new Response('{}')) });
  await assert.rejects(h.request('stripe', 'http://127.0.0.1:1', '/v1/webhook_endpoints', { method: 'POST', form: [] }), PlanWriteRefused);
  assert.equal(fetched, 0);
});

test('API overrides work only for localhost and only with the fake switch on', () => {
  assert.equal(apiBases({ STRIPE_API_URL: 'http://127.0.0.1:9/stripe' }).stripe, 'https://api.stripe.com');
  assert.throws(() => apiBases({ LAUNCHER_FAKE_APIS: '1', STRIPE_API_URL: 'https://evil.example/stripe' }));
});

test('redact catches every secret shape even when unmasked', () => {
  const log = createLog({ out: { write() {} } });
  const line = log.redact('a whsec_abc123 b re_ABCdef123 c sb_secret_x1y2 d rk_test_123abc e sk_live_9z f sbp_' + 'a'.repeat(40));
  assert.doesNotMatch(line, LEAK_GREP);
  assert.doesNotMatch(line, /sk_live_|sbp_a/);
});

test('acceptance 3: the grep finds no secret in any log line, summary or artifact', () => {
  assert.ok(allLogs.length >= 8);
  let lines = 0;
  for (const l of allLogs) {
    const shown = asGithubShowsIt(l.raw);
    // Raw output minus the mask commands (which GitHub never shows) must be clean too.
    const rawShown = l.raw.split('\n').filter((x) => !x.startsWith('::add-mask::')).join('\n');
    for (const text of [shown, rawShown, ...l.files]) {
      for (const line of text.split('\n')) {
        lines++;
        assert.doesNotMatch(line, LEAK_GREP, `leak in ${l.mode}: ${line}`);
      }
    }
    // And no value any fake handed out appears anywhere outside a mask command.
    for (const v of fakes.state.issued) {
      assert.ok(!rawShown.includes(v) && !l.files.some((f) => f.includes(v)), `issued value printed in ${l.mode}`);
    }
  }
  assert.ok(fakes.state.issued.length >= 4);
  console.log(`# leak grep: ${lines} lines from ${allLogs.length} runs, 0 hits for ${LEAK_GREP}`);
});
