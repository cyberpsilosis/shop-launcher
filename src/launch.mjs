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

export const MODES = ['plan', 'apply'];
export const LATER_MODES = { smoke: 'piece 2', live: 'piece 3', rollback: 'piece 3' };
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
    errors: [],
  };
  let http;
  let exitCode = 1;

  try {
    if (mode in LATER_MODES) {
      throw new UsageError(`mode "${mode}" is not built yet: it arrives with ${LATER_MODES[mode]} of the launcher. Use plan or apply.`);
    }
    if (!MODES.includes(mode)) throw new UsageError(`mode must be plan or apply`);
    if (!SLUG.test(shop || '')) throw new UsageError('shop must be 2 to 31 lowercase letters or digits, starting with a letter');
    if (!shopConfig || shopConfig.slug !== shop) throw new UsageError(`shops/${shop}.json is missing or names another slug`);

    for (const k of [...TOKENS, ...VARIABLES]) log.mask(env[k]);
    const missing = [...TOKENS, ...VARIABLES].filter((k) => !env[k]);
    if (missing.length) throw new UsageError(`missing environment values: ${missing.join(', ')}`);
    if (/^[rs]k_live_/.test(env.STRIPE_SECRET_KEY)) {
      throw new UsageError('STRIPE_SECRET_KEY is a live-mode key; the launcher uses test keys only until the live mode (piece 3) exists');
    }

    const bases = apiBases(env);
    http = createHttp({ mode, fetchImpl });
    const sb = supabase(http, bases.supabase, env);
    const rs = resend(http, bases.resend, env);
    const st = stripe(http, bases.stripe, env);
    const cf = cloudflare(http, bases.cloudflare, env);
    const n = now();

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
    const webhookUrl = `${shopConfig.siteUrl.replace(/\/$/, '')}/api/stripe/webhook`;

    const project = await read('supabase_project', () => sb.findProject(projectName, env.SUPABASE_ORG_ID));
    let ref = project ? project.ref || project.id : null;
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

    async function deploy(values) {
      writeSecretsFile(secretsFile, values);
      const fake = env.LAUNCHER_FAKE_APIS === '1' && deployCmd;
      const cmds = fake
        ? [deployCmd]
        : [...(shopConfig.install ? [shopConfig.install] : []), ...(shopConfig.build ? [shopConfig.build] : []), shopConfig.deploy];
      for (let i = 0; i < cmds.length; i++) {
        const last = i === cmds.length - 1;
        const cmd = last ? [...cmds[i], '--secrets-file', secretsFile] : cmds[i];
        const extra = last ? { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } : {};
        log.info(`running  ${cmd.slice(0, 3).join(' ')}`);
        await runCommand(cmd, { cwd: shopDir, env: childEnv(env, extra), log });
      }
    }

    // Old keys go only after the new ones are on the Worker.
    for (const id of oldKeys) await rs.deleteKey(id);
    for (const id of oldEndpoints) await st.deleteEndpoint(id);

    summary.ok = true;
    exitCode = 0;
    return summary;
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
  for (const w of s.warnings) out.push(`- Token ${w.token}: ${w.daysLeft !== undefined ? `expires ${w.expiresOn}, ${w.daysLeft} days left` : w.status}`);
  for (const m of s.missingPermissions) out.push(`- Missing ${m.provider} permission: ${m.permission}`);
  for (const e of s.errors) out.push(`- Error: ${e}`);
  return out.join('\n') + '\n';
}

// ---- CLI --------------------------------------------------------------------
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
  });
  process.exitCode = summary.exitCode;
}
