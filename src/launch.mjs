#!/usr/bin/env node
// The launcher: `plan` reads every provider and says what `apply` would do;
// `apply` does it. Both write a names-only summary (Markdown for the job page,
// JSON for the store). See README.md, "Summary JSON".

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLog } from './log.mjs';
import { createHttp, apiBases, HttpError, PlanWriteRefused } from './http.mjs';
import { supabase, resend, stripe, cloudflare, WEBHOOK_EVENTS } from './providers.mjs';
import { runSmoke, CHECKS } from './smoke.mjs';

export const MODES = ['plan', 'apply', 'smoke', 'live', 'rollback'];
export const LATER_MODES = {};
// rollback runs in two jobs: `worker` (environment provision, no approval)
// returns the Worker to its test-key version; `endpoint` (environment live,
// after Elijah's approval) disables the live webhook endpoint.
export const ROLLBACK_STEPS = ['worker', 'endpoint'];
// A secret whose name marks a Worker version as running on the live key.
// Cloudflare lists binding names per version, so the launcher can tell a
// live version from a test-key one without reading any value.
export const LIVE_MARK = 'SHOP_LAUNCHER_LIVE';
// What each mode needs from the environment. Only live and rollback/endpoint
// see the live key, and those run only in the `live` environment.
const NEEDS = {
  live: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'STRIPE_LIVE_KEY'],
  'rollback/worker': ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
  'rollback/endpoint': ['STRIPE_LIVE_KEY'],
};
export const SLUG = /^[a-z][a-z0-9]{1,30}$/;
export const TOKENS = ['SUPABASE_ACCESS_TOKEN', 'RESEND_ADMIN_KEY', 'STRIPE_SECRET_KEY', 'CLOUDFLARE_API_TOKEN'];
export const VARIABLES = ['SUPABASE_ORG_ID', 'CLOUDFLARE_ACCOUNT_ID'];
// The Worker secrets a shop needs, and which resource each one comes from.
export const SECRETS = [
  { name: 'NEXT_PUBLIC_SUPABASE_URL', from: 'supabase_project' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', from: 'supabase_project' },
  { name: 'RESEND_API_KEY', from: 'resend_key' },
  { name: 'STRIPE_SECRET_KEY', from: 'env' },
  { name: 'STRIPE_WEBHOOK_SECRET', from: 'stripe_webhook' },
  { name: 'CRON_SECRET', from: 'generated' },
];
const WARN_DAYS = 14;
const DAY = 86400000;

class UsageError extends Error {}

function readMigrations(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const base = f.replace(/\.sql$/, '');
      const [version, ...rest] = base.split('_');
      return { file: f, base, version, name: rest.join('_'), path: path.join(dir, f) };
    });
}

export function writeSecretsFile(file, values) {
  if (!file) throw new Error('apply needs --secrets-file (made by scripts/secrets-file.sh create)');
  const check = () => {
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new Error('secrets file is not a regular file');
    if ((st.mode & 0o777) !== 0o600) throw new Error(`secrets file must be mode 600, is ${(st.mode & 0o777).toString(8)}`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('secrets file belongs to another user');
  };
  check();
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  check();
}

function runCommand(cmd, { cwd, env, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) log.info(`  | ${l}`);
      });
      stream.on('end', () => buf && log.info(`  | ${buf}`));
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.slice(0, 3).join(' ')} exited ${code}`))));
  });
}

// Children get a clean environment: no provider token reaches the shop's
// install or build, and wrangler gets only the two Cloudflare values.
function childEnv(env, extra = {}) {
  const keep = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'RUNNER_TEMP']) if (env[k]) keep[k] = env[k];
  if (env.LAUNCHER_FAKE_APIS === '1') for (const [k, v] of Object.entries(env)) if (k.startsWith('FAKE_')) keep[k] = v;
  return { ...keep, CI: '1', ...extra };
}

function daysLeft(iso, now) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / DAY);
}

export async function run(opts) {
  const {
    shop,
    mode,
    env = process.env,
    shopConfig,
    shopDir,
    secretsFile,
    summaryJson,
    stepSummary,
    deployCmd,
    log = createLog(),
    fetchImpl,
    pollMs = 5000,
    pollTries = 120,
    now = () => new Date(),
    browser,
    expectCommit,
    runId,
    smokeSleep,
    smokeTries,
    step = 'worker',
  } = opts;

  const summary = {
    schema: 'shop-launcher/summary@1',
    shop: SLUG.test(shop || '') ? shop : null,
    mode: MODES.includes(mode) || mode in LATER_MODES ? mode : null,
    ok: false,
    startedAt: now().toISOString(),
    finishedAt: null,
    writes: 0,
    resources: [],
    secrets: [],
    warnings: [],
    missingPermissions: [],
    checks: [],
    rollback: null,
    errors: [],
  };
  let http;
  let exitCode = 1;

  try {
    if (mode in LATER_MODES) {
      throw new UsageError(`mode "${mode}" is not built yet: it arrives with ${LATER_MODES[mode]} of the launcher. Use plan, apply or smoke.`);
    }
    if (!MODES.includes(mode)) throw new UsageError(`mode must be ${MODES.join(', ')}`);
    if (mode === 'rollback' && !ROLLBACK_STEPS.includes(step)) throw new UsageError(`rollback --step must be ${ROLLBACK_STEPS.join(' or ')}`);
    if (!SLUG.test(shop || '')) throw new UsageError('shop must be 2 to 31 lowercase letters or digits, starting with a letter');
    if (!shopConfig || shopConfig.slug !== shop) throw new UsageError(`shops/${shop}.json is missing or names another slug`);

    for (const k of [...TOKENS, ...VARIABLES, 'STRIPE_LIVE_KEY']) log.mask(env[k]);
    const needed = NEEDS[mode === 'rollback' ? `rollback/${step}` : mode] || [...TOKENS, ...VARIABLES];
    const missing = needed.filter((k) => !env[k]);
    if (missing.length) throw new UsageError(`missing environment values: ${missing.join(', ')}`);
    if (/^[rs]k_live_/.test(env.STRIPE_SECRET_KEY || '')) {
      throw new UsageError('STRIPE_SECRET_KEY is a live-mode key; plan, apply and smoke use test keys only (the live key arrives as STRIPE_LIVE_KEY in mode=live)');
    }
    const liveKeyMode = mode === 'live' || (mode === 'rollback' && step === 'endpoint');
    if (env.STRIPE_LIVE_KEY && !liveKeyMode) throw new UsageError(`STRIPE_LIVE_KEY reached mode ${mode}${mode === 'rollback' ? `/${step}` : ''}; only live and rollback/endpoint may see it`);
    if (liveKeyMode && !/^rk_live_/.test(env.STRIPE_LIVE_KEY)) throw new UsageError('STRIPE_LIVE_KEY must be a restricted live-mode key, not a secret key');

    const bases = apiBases(env);
    http = createHttp({ mode, fetchImpl });
    const sb = supabase(http, bases.supabase, env);
    const rs = resend(http, bases.resend, env);
    const st = stripe(http, bases.stripe, env);
    const cf = cloudflare(http, bases.cloudflare, env);
    const n = now();
    let ref = null;
    const siteUrl = () => {
      const o = env.LAUNCHER_FAKE_APIS === '1' && env.SHOP_SITE_URL;
      if (o && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(o)) throw new UsageError('SHOP_SITE_URL may only point at localhost');
      return (o || shopConfig.siteUrl).replace(/\/$/, '');
    };
    const webhookUrl = `${shopConfig.siteUrl.replace(/\/$/, '')}/api/stripe/webhook`;
    const isLive = async (versionId) => (await cf.bindingNames(shopConfig.worker, versionId)).has(LIVE_MARK);

    if (mode === 'live') return await goLive();
    if (mode === 'rollback') return step === 'worker' ? await rollbackWorker() : await disableLiveEndpoints();

    // Token expiry. Cloudflare says it itself; the others come from optional
    // repository variables <TOKEN>_EXPIRES_ON (an ISO date, not a secret).
    try {
      const t = await cf.tokenExpiry();
      if (t.status && t.status !== 'active') summary.warnings.push({ token: 'CLOUDFLARE_API_TOKEN', status: t.status });
      if (t.expiresOn) {
        const d = daysLeft(t.expiresOn, n);
        if (d !== null && d <= WARN_DAYS) summary.warnings.push({ token: 'CLOUDFLARE_API_TOKEN', expiresOn: t.expiresOn, daysLeft: d });
      }
    } catch (e) {
      summary.warnings.push({ token: 'CLOUDFLARE_API_TOKEN', status: `verify failed: ${e.message}` });
    }
    for (const k of TOKENS) {
      const iso = env[`${k}_EXPIRES_ON`];
      if (!iso) continue;
      const d = daysLeft(iso, n);
      if (d !== null && d <= WARN_DAYS) summary.warnings.push({ token: k, expiresOn: iso, daysLeft: d });
    }

    // ---- Read everything (GET only) -------------------------------------
    const blocked = [];
    const read = async (kind, fn) => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof HttpError && e.missingPermissions.length) {
          for (const p of e.missingPermissions) {
            if (!summary.missingPermissions.some((m) => m.provider === e.provider && m.permission === p)) {
              summary.missingPermissions.push({ provider: e.provider, permission: p });
            }
          }
        }
        blocked.push({ kind, message: e.message });
        return undefined;
      }
    };

    const projectName = `shop-${shop}`;
    const keyName = `shop-${shop}`;

    const project = await read('supabase_project', () => sb.findProject(projectName, env.SUPABASE_ORG_ID));
    ref = project ? project.ref || project.id : null;
    log.mask(ref);
    const migrations = readMigrations(shopDir ? path.join(shopDir, 'supabase', 'migrations') : null);
    const applied = ref ? (await read('supabase_migration', () => sb.listMigrations(ref))) || [] : [];
    const isApplied = (m) => applied.some((a) => a.version === m.version || a.name === m.name || a.name === m.base);
    const cfState = (await read('worker_secrets', () => cf.secretNames(shopConfig.worker))) || { exists: false, names: new Set() };
    const keys = (await read('resend_key', () => rs.findKeys(keyName))) || [];
    const endpoints = (await read('stripe_webhook', () => st.findEndpoints(webhookUrl, shop))) || [];
    for (const k of keys) log.mask(k.id);
    for (const e of endpoints) log.mask(e.id);

    const has = (name) => cfState.names.has(name);
    const decide = {
      supabase_project: project === undefined ? 'blocked' : project ? 'skip' : 'create',
      resend_key: keys.length === 0 ? 'create' : has('RESEND_API_KEY') ? 'skip' : 'rotate',
      stripe_webhook:
        endpoints.length === 0
          ? 'create'
          : !has('STRIPE_WEBHOOK_SECRET')
            ? 'rotate'
            : WEBHOOK_EVENTS.every((e) => endpoints[0].enabled_events?.includes(e)) && endpoints[0].enabled_events?.length === WEBHOOK_EVENTS.length
              ? 'skip'
              : 'update',
    };
    for (const b of blocked) decide[b.kind] = 'blocked';

    summary.resources.push({ kind: 'supabase_project', name: projectName, action: decide.supabase_project, id: ref ? '***' : null });
    for (const m of migrations) {
      summary.resources.push({ kind: 'supabase_migration', name: m.file, action: decide.supabase_project === 'blocked' ? 'blocked' : isApplied(m) ? 'skip' : 'create' });
    }
    summary.resources.push({ kind: 'resend_key', name: keyName, action: decide.resend_key, permission: 'sending_access' });
    summary.resources.push({ kind: 'stripe_webhook', name: webhookUrl, action: decide.stripe_webhook, events: WEBHOOK_EVENTS, id: endpoints.length ? '***' : null });

    const toSet = SECRETS.filter((s) => !has(s.name) || ['create', 'rotate'].includes(decide[s.from]));
    for (const s of SECRETS) summary.secrets.push({ name: s.name, state: toSet.includes(s) ? 'set' : 'unchanged' });
    summary.resources.push({
      kind: 'worker_secrets',
      name: shopConfig.worker,
      action: toSet.length === 0 ? 'skip' : cfState.exists ? 'update' : 'create',
      count: toSet.length,
    });

    for (const r of summary.resources) log.info(`${r.action.padEnd(8)} ${r.kind.padEnd(20)} ${r.name}`);
    for (const s of summary.secrets) log.info(`secret   ${s.name.padEnd(26)} ${mode === 'plan' && s.state === 'set' ? 'would be set' : s.state}`);
    for (const w of summary.warnings) log.warn(`token ${w.token}: ${w.daysLeft !== undefined ? `expires ${w.expiresOn} (${w.daysLeft} days)` : w.status}`);
    for (const m of summary.missingPermissions) log.error(`${m.provider} token is missing permission: ${m.permission}`);

    if (blocked.length) {
      for (const b of blocked) summary.errors.push(`${b.kind}: ${b.message}`);
      throw new Error(`could not read ${blocked.map((b) => b.kind).join(', ')}; ${mode === 'apply' ? 'apply stopped before its first write' : 'plan is incomplete'}`);
    }

    if (mode === 'smoke') {
      // Smoke: deploy the shop's main as it is (no secret changes), then the seven checks.
      const prev = await recordActive();
      await deploy(null);
      const green = await smokeOrRollback(prev);
      if (green) await retireOldKeys();
      summary.ok = green;
      exitCode = green ? 0 : 1;
      return summary;
    }

    if (mode === 'plan') {
      summary.ok = true;
      exitCode = 0;
      return summary;
    }

    // ---- Apply ------------------------------------------------------------
    const values = {};
    const need = (name) => toSet.some((s) => s.name === name);

    if (decide.supabase_project === 'create') {
      const dbPass = randomBytes(24).toString('hex'); // not kept: reset it in Supabase if ever needed
      log.mask(dbPass);
      const created = await sb.createProject({ name: projectName, orgId: env.SUPABASE_ORG_ID, region: shopConfig.supabase?.region || 'us-west-1', dbPass });
      ref = created.ref || created.id;
      log.mask(ref);
      summary.resources[0].id = '***';
      log.info('created  supabase_project; waiting for it to be healthy');
      let status = created.status;
      for (let i = 0; status !== 'ACTIVE_HEALTHY'; i++) {
        if (i >= pollTries) throw new Error('supabase project did not become healthy in time');
        if (pollMs) await new Promise((r) => setTimeout(r, pollMs));
        status = (await sb.getProject(ref))?.status;
      }
    }
    for (const m of migrations) {
      if (decide.supabase_project === 'skip' && isApplied(m)) continue;
      await sb.applyMigration(ref, { name: m.base, query: fs.readFileSync(m.path, 'utf8') });
      log.info(`applied  supabase_migration   ${m.file}`);
    }
    if (need('NEXT_PUBLIC_SUPABASE_URL')) values.NEXT_PUBLIC_SUPABASE_URL = `https://${ref}.supabase.co`;
    if (need('SUPABASE_SERVICE_ROLE_KEY')) {
      const k = await sb.serviceKey(ref);
      log.mask(k);
      values.SUPABASE_SERVICE_ROLE_KEY = k;
    }

    const oldKeys = [];
    const madeNow = { key: null, endpoint: null }; // undone if the deploy fails
    if (['create', 'rotate'].includes(decide.resend_key)) {
      const k = await rs.createKey({ name: keyName, domainId: shopConfig.resend?.domainId });
      log.mask(k.id);
      log.mask(k.token);
      values.RESEND_API_KEY = k.token;
      madeNow.key = k.id;
      if (decide.resend_key === 'rotate') oldKeys.push(...keys.map((x) => x.id));
    }

    const oldEndpoints = [];
    if (['create', 'rotate'].includes(decide.stripe_webhook)) {
      const ep = await st.createEndpoint(webhookUrl, shop);
      log.mask(ep.id);
      log.mask(ep.secret);
      values.STRIPE_WEBHOOK_SECRET = ep.secret;
      madeNow.endpoint = ep.id;
      summary.resources.find((r) => r.kind === 'stripe_webhook').id = '***';
      if (decide.stripe_webhook === 'rotate') oldEndpoints.push(...endpoints.map((x) => x.id));
    } else if (decide.stripe_webhook === 'update') {
      await st.setEvents(endpoints[0].id);
    }
    if (need('STRIPE_SECRET_KEY')) values.STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY;
    if (need('CRON_SECRET')) {
      values.CRON_SECRET = randomBytes(32).toString('hex');
      log.mask(values.CRON_SECRET);
    }

    const prev = Object.keys(values).length ? await recordActive() : null;
    if (Object.keys(values).length) {
      try {
        await deploy(values);
      } catch (e) {
        // A key or webhook whose secret never reached the Worker is useless:
        // remove it, so a failed run leaves nothing behind for the next to trip on.
        if (madeNow.key) await rs.deleteKey(madeNow.key).catch(() => log.warn('could not remove the new Resend key; the next run rotates it'));
        if (madeNow.endpoint) await st.deleteEndpoint(madeNow.endpoint).catch(() => log.warn('could not remove the new Stripe webhook; the next run rotates it'));
        throw e;
      }
    }

    // A rotation leaves the old key and webhook in place: they are deleted only
    // after a green smoke on the new version (apply runs it now when it can).
    if (oldKeys.length || oldEndpoints.length) {
      log.info(`kept     ${oldKeys.length} old Resend key(s), ${oldEndpoints.length} old Stripe webhook(s) until a green smoke`);
      summary.oldKept = { resend_key: oldKeys.length, stripe_webhook: oldEndpoints.length };
      if (browser) {
        const green = await smokeOrRollback(prev);
        if (!green) {
          if (madeNow.key) await rs.deleteKey(madeNow.key).catch(() => log.warn('could not remove the new Resend key'));
          if (madeNow.endpoint) await st.deleteEndpoint(madeNow.endpoint).catch(() => log.warn('could not remove the new Stripe webhook'));
          return summary;
        }
        await retireOldKeys();
      }
    }

    summary.ok = true;
    exitCode = 0;
    return summary;

    // ---- helpers for deploy, smoke and rollback ------------------------------
    async function deploy(values) {
      if (values) writeSecretsFile(secretsFile, values);
      const fake = env.LAUNCHER_FAKE_APIS === '1' && deployCmd;
      const cmds = fake
        ? [deployCmd]
        : [...(shopConfig.install ? [shopConfig.install] : []), ...(shopConfig.build ? [shopConfig.build] : []), shopConfig.deploy];
      // The shop's /api/version reports the commit Workers Builds would set.
      const build = expectCommit ? { WORKERS_CI_COMMIT_SHA: expectCommit, WORKERS_CI_BRANCH: 'main' } : {};
      for (let i = 0; i < cmds.length; i++) {
        const last = i === cmds.length - 1;
        const cmd = last && values ? [...cmds[i], '--secrets-file', secretsFile] : cmds[i];
        const extra = last ? { ...build, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } : build;
        log.info(`running  ${cmd.slice(0, 3).join(' ')}`);
        await runCommand(cmd, { cwd: shopDir, env: childEnv(env, extra), log });
      }
    }

    // Before any deploy: the version that is live now, and the commit it reports.
    async function recordActive() {
      const id = await cf.activeVersion(shopConfig.worker);
      log.mask(id);
      const v = await fetch(`${siteUrl()}/api/version`).then((r) => r.json()).catch(() => null);
      const rec = { id, commit: v?.commit || null, live: id ? await isLive(id) : false };
      // smoke and apply deploy test keys: never on top of a live version.
      if (rec.live && mode !== 'live') throw new Error('the shop is on its live key; run mode=rollback before apply or smoke');
      log.info(`recorded the active Worker version (${rec.commit ? rec.commit.slice(0, 7) : 'no commit'}${rec.live ? ', live key' : ''}) before deploy`);
      return rec;
    }

    // ---- live and rollback ------------------------------------------------------
    // Live: one new Worker version with the live restricted key and a new live
    // webhook endpoint's secret. It goes up only on the commit the last smoke
    // proved, and only on top of a test-key version. Then check 1 of the smoke
    // (no test card on a live key); if that fails it rolls back on its own.
    async function goLive() {
      const stl = stripe(http, bases.stripe, { STRIPE_SECRET_KEY: env.STRIPE_LIVE_KEY });
      const prev = await recordActive();
      if (!prev.id) throw new Error('the Worker has no version yet: run apply and a green smoke first');
      if (prev.live) {
        summary.resources.push({ kind: 'worker_version', name: shopConfig.worker, action: 'skip', key: 'live' });
        log.info(`skip     worker_version       ${shopConfig.worker} is on its live key already`);
        summary.ok = true;
        exitCode = 0;
        return summary;
      }
      if (!expectCommit || prev.commit !== expectCommit) {
        throw new Error(`the active version runs ${String(prev.commit).slice(0, 7)}, main is ${String(expectCommit).slice(0, 7)}: run a green smoke on main before going live`);
      }
      const old = await stl.findEndpoints(webhookUrl, shop);
      for (const e of old) log.mask(e.id);
      const ep = await stl.createEndpoint(webhookUrl, shop);
      log.mask(ep.id);
      log.mask(ep.secret);
      summary.resources.push({ kind: 'stripe_webhook', name: webhookUrl, action: 'create', livemode: true, id: '***' });
      try {
        await deploy({ STRIPE_SECRET_KEY: env.STRIPE_LIVE_KEY, STRIPE_WEBHOOK_SECRET: ep.secret, [LIVE_MARK]: '1' });
      } catch (e) {
        await stl.deleteEndpoint(ep.id).catch(() => log.warn('could not remove the new live webhook; rollback/endpoint disables it'));
        throw e;
      }
      summary.resources.push({ kind: 'worker_version', name: shopConfig.worker, action: 'create', key: 'live' });
      if (!(await smokeOrRollback(prev, ['pages']))) {
        await stl.deleteEndpoint(ep.id).catch(() => log.warn('could not remove the new live webhook; rollback/endpoint disables it'));
        return summary;
      }
      // Endpoints left from an earlier live run (disabled by its rollback): their
      // secret is on no version any more.
      for (const e of old) await stl.deleteEndpoint(e.id);
      if (old.length) log.info(`deleted  ${old.length} earlier live webhook(s)`);
      log.info(`live     ${shopConfig.worker} is on its live key`);
      summary.ok = true;
      exitCode = 0;
      return summary;
    }

    // Rollback, job 1: back to the newest version that is not on the live key.
    // Its bindings are the test key and the test webhook secret (a version keeps
    // its secrets), so live checkout stops at once.
    async function rollbackWorker() {
      const active = await cf.activeVersion(shopConfig.worker);
      log.mask(active);
      if (!active) throw new Error('the Worker has no version to roll back');
      if (!(await isLive(active))) {
        summary.resources.push({ kind: 'worker_version', name: shopConfig.worker, action: 'skip', key: 'test' });
        log.info(`skip     worker_version       ${shopConfig.worker} is on a test-key version already`);
        summary.ok = true;
        exitCode = 0;
        return summary;
      }
      let target = null;
      for (const id of await cf.deployedVersions(shopConfig.worker)) {
        log.mask(id);
        if (!(await isLive(id))) {
          target = id;
          break;
        }
      }
      if (!target) throw new Error('no test-key version in the deployment history');
      const fake = env.LAUNCHER_FAKE_APIS === '1' && deployCmd;
      if (!fake && shopConfig.install) await runCommand(shopConfig.install, { cwd: shopDir, env: childEnv(env), log });
      await wranglerRollback(target, `shop-launcher rollback ${runId || ''}`.trim());
      const now = await cf.activeVersion(shopConfig.worker);
      const back = now === target && !(await isLive(now));
      summary.rollback = { ok: back, to: '***', detail: back ? 'back on the test-key version' : 'wrangler rollback ran, but the active version is not the test-key one' };
      summary.resources.push({ kind: 'worker_version', name: shopConfig.worker, action: back ? 'rollback' : 'blocked', key: 'test' });
      log.info(`${back ? 'rollback' : 'FAIL    '} worker_version       ${summary.rollback.detail}`);
      summary.ok = back;
      exitCode = back ? 0 : 1;
      return summary;
    }

    // Rollback, job 2 (environment live): Stripe stops sending live events.
    async function disableLiveEndpoints() {
      const stl = stripe(http, bases.stripe, { STRIPE_SECRET_KEY: env.STRIPE_LIVE_KEY });
      const eps = await stl.findEndpoints(webhookUrl, shop);
      for (const e of eps) log.mask(e.id);
      let n = 0;
      for (const e of eps) {
        if (e.status === 'disabled') continue;
        await stl.disableEndpoint(e.id);
        n++;
      }
      summary.resources.push({ kind: 'stripe_webhook', name: webhookUrl, action: n ? 'disable' : 'skip', livemode: true, count: n });
      log.info(`${n ? 'disable ' : 'skip    '} stripe_webhook       ${n} live endpoint(s) disabled, ${eps.length - n} already off`);
      summary.ok = true;
      exitCode = 0;
      return summary;
    }

    async function wranglerRollback(id, message) {
      const fake = env.LAUNCHER_FAKE_APIS === '1' && deployCmd;
      const cmd = fake ? [...deployCmd, 'rollback', id] : ['npx', '--no-install', 'wrangler', 'rollback', id, '--name', shopConfig.worker, '--message', message];
      log.info('running  wrangler rollback to the recorded version');
      await runCommand(cmd, { cwd: shopDir, env: childEnv(env, { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID }), log });
    }

    async function smokeOrRollback(prev, only) {
      if (!browser && !only) throw new Error('smoke needs a browser (Playwright)');
      summary.checks = await runSmoke({
        http, bases, env, shopConfig: { ...shopConfig, siteUrl: siteUrl() }, expectCommit, browser, sb, supabaseRef: ref, log, runId,
        sleep: smokeSleep, tries: smokeTries, only,
      });
      for (const c of summary.checks) log.info(`${c.ok ? 'pass' : c.skipped ? 'skip' : 'FAIL'}     ${c.title}: ${c.detail}`);
      const green = summary.checks.length === (only || CHECKS).length && summary.checks.every((c) => c.ok);
      if (green) return true;
      const failed = summary.checks.find((c) => !c.ok && !c.skipped);
      summary.errors.push(`smoke failed at "${failed.title}": ${failed.detail}`);
      if (!prev?.id) {
        summary.rollback = { ok: false, detail: 'no earlier version to roll back to' };
        return false;
      }
      try {
        await wranglerRollback(prev.id, `shop-launcher ${mode === 'live' ? 'live check' : 'smoke'} failed ${runId || ''}`.trim());
        const v = await fetch(`${siteUrl()}/api/version`).then((r) => r.json()).catch(() => null);
        const back = !prev.commit || v?.commit === prev.commit;
        summary.rollback = { ok: back, to: '***', commit: v?.commit ? v.commit.slice(0, 7) : null, detail: back ? `rolled back; /api/version is ${String(v?.commit).slice(0, 7)} again` : `rolled back, but /api/version says ${String(v?.commit).slice(0, 7)}` };
      } catch (e) {
        summary.rollback = { ok: false, detail: `wrangler rollback failed: ${log.redact(e.message)}` };
      }
      return false;
    }

    // After a green smoke: every Resend key and Stripe webhook of this shop but
    // the newest (the one on the Worker) is an old one. Delete those.
    async function retireOldKeys() {
      const ks = (await rs.findKeys(keyName)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const es = (await st.findEndpoints(webhookUrl, shop)).sort((a, b) => (b.created || 0) - (a.created || 0));
      for (const k of ks.slice(1)) await rs.deleteKey(k.id);
      for (const e of es.slice(1)) await st.deleteEndpoint(e.id);
      if (ks.length > 1 || es.length > 1) log.info(`deleted  ${Math.max(0, ks.length - 1)} old Resend key(s), ${Math.max(0, es.length - 1)} old Stripe webhook(s) after the green smoke`);
      summary.retired = { resend_key: Math.max(0, ks.length - 1), stripe_webhook: Math.max(0, es.length - 1) };
    }
  } catch (e) {
    if (e instanceof UsageError) exitCode = 2;
    const msg = e instanceof PlanWriteRefused ? `BUG: ${e.message}` : e.message;
    if (!summary.errors.includes(msg)) summary.errors.push(log.redact(msg));
    log.error(msg);
    return summary;
  } finally {
    summary.writes = http ? http.writes() : 0;
    summary.finishedAt = now().toISOString();
    summary.errors = summary.errors.map((x) => log.redact(x));
    summary.exitCode = exitCode;
    if (summaryJson) fs.writeFileSync(summaryJson, log.redact(JSON.stringify(summary, null, 2)) + '\n');
    if (stepSummary) fs.appendFileSync(stepSummary, log.redact(markdown(summary)));
    log.info(`${summary.ok ? 'done' : 'failed'}: ${mode}, ${summary.writes} write calls`);
  }
}

export function markdown(s) {
  const out = [`## Shop launcher: ${s.mode ?? '?'} ${s.shop ?? '?'}: ${s.ok ? 'ok' : 'failed'}`, ''];
  out.push(`Write calls: ${s.writes}`, '');
  if (s.resources.length) {
    out.push('| Resource | Name | Action |', '|---|---|---|');
    for (const r of s.resources) out.push(`| ${r.kind} | ${r.name} | ${r.action} |`);
    out.push('');
  }
  if (s.secrets.length) {
    out.push(`| Worker secret | ${s.mode === 'plan' ? 'Would be' : 'State'} |`, '|---|---|');
    for (const x of s.secrets) out.push(`| ${x.name} | ${x.state} |`);
    out.push('');
  }
  if (s.checks?.length) {
    out.push(`Smoke: ${s.checks.filter((c) => c.ok).length} of ${s.checks.length} passed`, '', '| # | Check | Result | Why |', '|---|---|---|---|');
    s.checks.forEach((c, i) => out.push(`| ${i + 1} | ${c.title} | ${c.ok ? 'pass' : c.skipped ? 'not run' : 'FAIL'} | ${c.detail} |`));
    out.push('');
  }
  if (s.rollback) out.push(`- Rollback: ${s.rollback.detail}`);
  for (const w of s.warnings) out.push(`- Token ${w.token}: ${w.daysLeft !== undefined ? `expires ${w.expiresOn}, ${w.daysLeft} days left` : w.status}`);
  for (const m of s.missingPermissions) out.push(`- Missing ${m.provider} permission: ${m.permission}`);
  for (const e of s.errors) out.push(`- Error: ${e}`);
  return out.join('\n') + '\n';
}

// ---- CLI --------------------------------------------------------------------
// Tests only (LAUNCHER_FAKE_APIS=1): the fake shop's own "Checkout".
function fakeBrowser() {
  return {
    async pay({ productUrl, email }) {
      const site = productUrl.replace(/\/shop\/.*$/, '');
      if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(site)) throw new Error('fake browser is for localhost only');
      const r = await fetch(`${site}/__fake_pay`, { method: 'POST', body: JSON.stringify({ email }) });
      return r.json();
    },
  };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    a[k.slice(2)] = argv[i + 1];
    i++;
  }
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let shopConfig = null;
  if (SLUG.test(args.shop || '')) {
    const p = path.join(root, 'shops', `${args.shop}.json`);
    if (fs.existsSync(p)) shopConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const fake = process.env.LAUNCHER_FAKE_APIS === '1';
  const summary = await run({
    shop: args.shop,
    mode: args.mode,
    shopConfig,
    shopDir: args['shop-dir'],
    secretsFile: args['secrets-file'],
    summaryJson: args['summary-json'],
    stepSummary: process.env.GITHUB_STEP_SUMMARY,
    deployCmd: fake && args['deploy-cmd'] ? args['deploy-cmd'].split(' ') : undefined,
    pollMs: fake ? 0 : 5000,
    expectCommit: args['expect-commit'],
    step: args.step,
    runId: process.env.GITHUB_RUN_ID,
    smokeSleep: fake ? async () => {} : undefined,
    browser:
      args.mode === 'smoke' || (args.mode === 'apply' && args.browser)
        ? fake && args.browser === 'fake'
          ? fakeBrowser()
          : (await import('./checkout-browser.mjs')).playwrightBrowser()
        : undefined,
  });
  process.exitCode = summary.exitCode;
}
