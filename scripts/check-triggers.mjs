#!/usr/bin/env node
// The fork guard, as a check. This repository is public and its jobs run on
// Elijah's laptop, so no workflow may start from anything a stranger can do.
// Allowed: workflow_dispatch (needs write access) and push (a fork's push
// runs in the fork, never here). Anything else fails, by allowlist, so a new
// trigger type GitHub adds later fails too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ALLOWED = ['workflow_dispatch', 'push'];
export const SECRET_ENVIRONMENTS = ['provision', 'live'];

function triggers(doc) {
  const on = doc?.on ?? doc?.[true]; // YAML 1.1 readers turn `on` into true
  if (on === undefined || on === null) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}

function labels(runsOn) {
  if (typeof runsOn === 'string') return [runsOn];
  if (Array.isArray(runsOn)) return runsOn.map(String);
  if (runsOn && typeof runsOn === 'object') return [...(runsOn.labels ? [].concat(runsOn.labels) : []), ...(runsOn.group ? ['group:' + runsOn.group] : [])];
  return [];
}

export function checkWorkflow(file, text) {
  const problems = [];
  const name = path.basename(file);
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return [`${name}: not valid YAML (${e.message})`];
  }
  const t = triggers(doc);
  if (t.length === 0) problems.push(`${name}: no trigger found`);
  for (const x of t) if (!ALLOWED.includes(x)) problems.push(`${name}: trigger "${x}" is not allowed (only ${ALLOWED.join(', ')})`);

  for (const [id, job] of Object.entries(doc?.jobs || {})) {
    if (job?.uses) {
      problems.push(`${name}: job ${id} calls a reusable workflow; not allowed`);
      continue;
    }
    if (!labels(job?.['runs-on']).includes('self-hosted')) {
      problems.push(`${name}: job ${id} must run on the laptop runner (self-hosted); GitHub-hosted runners do not start on this account`);
    }
    const body = JSON.stringify(job);
    const env = job?.environment?.name ?? job?.environment;
    if (/\$\{\{\s*secrets[.[]/.test(body) && !SECRET_ENVIRONMENTS.includes(env)) {
      problems.push(`${name}: job ${id} reads secrets outside the provision and live environments`);
    }
    // The live key is gated by Elijah's approval of the `live` environment:
    // no other job may name it, and the live job runs for live and rollback only.
    if (/STRIPE_RK_LIVE/.test(body) && env !== 'live') problems.push(`${name}: job ${id} names the live Stripe key outside the live environment`);
    if (env === 'live' && !/inputs\.mode == 'live'/.test(String(job.if))) problems.push(`${name}: job ${id} in the live environment needs an if on inputs.mode`);
  }

  if (name === 'launch.yml') {
    if (t.length !== 1 || t[0] !== 'workflow_dispatch') problems.push('launch.yml: must be workflow_dispatch only');
    const c = doc?.concurrency;
    if (!c || String(c.group).replace(/\s/g, '') !== 'launch-${{inputs.shop}}' || c['cancel-in-progress'] !== false) {
      problems.push('launch.yml: needs concurrency group launch-${{ inputs.shop }} with cancel-in-progress: false');
    }
    if (/LAUNCHER_FAKE_APIS/.test(text)) problems.push('launch.yml: must never turn on the fake APIs');
  }
  return problems;
}

export function checkWorkflows(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const problems = [];
  if (files.length === 0) problems.push(`${dir}: no workflow files`);
  for (const f of files) problems.push(...checkWorkflow(f, fs.readFileSync(path.join(dir, f), 'utf8')));
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2] || '.github/workflows';
  const problems = checkWorkflows(dir);
  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length) process.exit(1);
  console.log(`ok: every workflow in ${dir} starts only on ${ALLOWED.join(' or ')}`);
}
