#!/usr/bin/env node
// A dry run of one dispatch of launch.yml, as GitHub would schedule it, with
// no runner, no secret and no network. For each job it says whether it runs,
// is skipped or waits on a protected environment, and which secrets it names.
// It reads the real workflow file, so a change that lets a job see the live
// key before Elijah's approval shows up here (test/live.test.mjs).
//
//   node scripts/dispatch-dry-run.mjs <mode> <shop> [--approved]
//
// GitHub's rules it models: jobs start in `needs` order; a job's `if` is
// evaluated before its environment's protection rules, so a skipped job asks
// for no approval; a job whose environment has a required reviewer waits,
// unscheduled, until he approves; its dependants wait with it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Environments Elijah protects with a required reviewer (plan P4).
export const PROTECTED = ['live'];

function evaluate(expr, ctx) {
  const src = String(expr)
    .replace(/^\s*\$\{\{|\}\}\s*$/g, '')
    .replace(/!=/g, '!==')
    .replace(/([^=!])==([^=])/g, '$1===$2');
  // eslint-disable-next-line no-new-func
  return Boolean(new Function('inputs', 'needs', 'cancelled', 'always', 'success', 'failure', `return (${src});`)(
    ctx.inputs, ctx.needs, () => false, () => true, () => Object.values(ctx.needs).every((n) => n.result === 'success'), () => Object.values(ctx.needs).some((n) => n.result === 'failure'),
  ));
}

// Secret names a job refers to, with the shop filled in for format(...).
export function secretsNamed(job, shop) {
  const body = JSON.stringify(job);
  const names = new Set();
  for (const m of body.matchAll(/secrets\.([A-Z0-9_]+)/g)) names.add(m[1]);
  for (const m of body.matchAll(/secrets\[format\('([A-Z0-9_]+)\{0\}'/g)) names.add(m[1] + shop);
  return [...names].sort();
}

export function dryRun(doc, { mode, shop, approved = false, outcomes = {} }) {
  const jobs = doc.jobs || {};
  const result = {};
  const order = [];
  const pending = new Set(Object.keys(jobs));
  while (pending.size) {
    const ready = [...pending].filter((id) => [].concat(jobs[id].needs || []).every((n) => result[n]));
    if (!ready.length) throw new Error('needs cycle');
    for (const id of ready) {
      pending.delete(id);
      const job = jobs[id];
      const needs = Object.fromEntries([].concat(job.needs || []).map((n) => [n, { result: result[n].status === 'ran' ? outcomes[n] || 'success' : result[n].status }]));
      const env = job.environment?.name ?? job.environment ?? null;
      let status;
      if (Object.values(needs).some((n) => n.result === 'waiting')) status = 'waiting';
      else status = evaluate(job.if ?? 'success()', { inputs: { mode, shop }, needs }) ? 'ran' : 'skipped';
      if (status === 'ran' && PROTECTED.includes(env) && !approved) status = 'waiting';
      result[id] = { status, environment: env, secrets: status === 'ran' ? secretsNamed(job, shop.toUpperCase()) : [] };
      order.push(id);
    }
  }
  return order.map((id) => ({ job: id, ...result[id] }));
}

export function readLaunch(root) {
  return YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'launch.yml'), 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, shop] = process.argv.slice(2);
  const approved = process.argv.includes('--approved');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`dispatch launch.yml mode=${mode} shop=${shop}${approved ? ' (live environment approved)' : ' (no approval)'}`);
  for (const r of dryRun(readLaunch(root), { mode, shop, approved })) {
    console.log(`${r.job.padEnd(8)} ${r.status.padEnd(8)} env=${(r.environment || '-').padEnd(9)} secrets read: ${r.secrets.join(', ') || 'none'}`);
  }
}
