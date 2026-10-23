// The fork guard and the workflow shape, enforced. Each forbidden change is
// made to a copy of the real workflows and must fail the check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { checkWorkflows, checkWorkflow } from '../scripts/check-triggers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF = path.join(ROOT, '.github', 'workflows');
const read = (f) => fs.readFileSync(path.join(WF, f), 'utf8');

function copyWith(file, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  for (const f of fs.readdirSync(WF)) fs.writeFileSync(path.join(dir, f), f === file ? edit(read(f)) : read(f));
  return dir;
}

test('the real workflows pass', () => {
  assert.deepEqual(checkWorkflows(WF), []);
});

test('adding pull_request to the test workflow fails the check (and the CLI exits 1)', () => {
  const dir = copyWith('test.yml', (t) => t.replace("on:\n  push:\n    branches: ['**']", "on:\n  push:\n    branches: ['**']\n  pull_request:"));
  assert.match(fs.readFileSync(path.join(dir, 'test.yml'), 'utf8'), /pull_request:/);
  assert.ok(checkWorkflows(dir).some((p) => /trigger "pull_request" is not allowed/.test(p)));
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'check-triggers.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL test\.yml: trigger "pull_request" is not allowed/);
});

for (const trig of ['pull_request', 'pull_request_target', 'issue_comment', 'workflow_run', 'schedule', 'repository_dispatch']) {
  test(`a new workflow on ${trig} fails`, () => {
    const p = checkWorkflow('evil.yml', `on: ${trig}\njobs:\n  x:\n    runs-on: [self-hosted, shop-launcher]\n    steps: [{run: id}]\n`);
    assert.ok(p.some((x) => x.includes(`"${trig}"`)), p.join('; '));
  });
}

test('list and map forms of on: are read too', () => {
  assert.ok(checkWorkflow('a.yml', 'on: [push, pull_request]\njobs: {}\n').length > 0);
  assert.ok(checkWorkflow('b.yml', 'on:\n  push: {}\n  pull_request_target: {}\njobs: {}\n').length > 0);
});

test('launch.yml with an extra push trigger fails', () => {
  const dir = copyWith('launch.yml', (t) => t.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'));
  assert.ok(checkWorkflows(dir).some((p) => p.includes('workflow_dispatch only')));
});

test('a GitHub-hosted runner fails', () => {
  const dir = copyWith('test.yml', (t) => t.replace('runs-on: [self-hosted, shop-launcher]', 'runs-on: ubuntu-latest'));
  assert.ok(checkWorkflows(dir).some((p) => p.includes('laptop runner')));
});

test('cancel-in-progress true fails', () => {
  const dir = copyWith('launch.yml', (t) => t.replace('cancel-in-progress: false', 'cancel-in-progress: true'));
  assert.ok(checkWorkflows(dir).some((p) => p.includes('concurrency')));
});

test('reading secrets outside the provision environment fails', () => {
  const dir = copyWith('launch.yml', (t) => t.replace('    environment: provision\n', ''));
  assert.ok(checkWorkflows(dir).some((p) => p.includes('outside the provision environment')));
});

test('launch.yml never switches on the fake APIs', () => {
  const dir = copyWith('launch.yml', (t) => t.replace('SHOP: ${{ inputs.shop }}\n      MODE', 'SHOP: ${{ inputs.shop }}\n      LAUNCHER_FAKE_APIS: "1"\n      MODE'));
  assert.ok(checkWorkflows(dir).some((p) => p.includes('fake APIs')));
});

test('launch.yml: inputs, environment, cleanup order', () => {
  const doc = YAML.parse(read('launch.yml'));
  const inputs = doc.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ['mode', 'shop']);
  assert.deepEqual(inputs.mode.options, ['plan', 'apply', 'smoke', 'live', 'rollback']);
  const job = doc.jobs.launch;
  assert.equal(job.environment, 'provision');
  assert.deepEqual(job['runs-on'], ['self-hosted', 'shop-launcher']);
  assert.equal(doc.concurrency['cancel-in-progress'], false);
  const steps = job.steps;
  const idx = (re) => steps.findIndex((s) => re.test(s.name || ''));
  const runIdx = idx(/^Run the launcher/);
  const delIdx = idx(/^Delete the secrets file/);
  assert.ok(runIdx >= 0 && delIdx > runIdx);
  assert.equal(steps[delIdx].if, 'always()');
  const last = steps[steps.length - 1];
  assert.match(last.name, /Clear RUNNER_TEMP/);
  assert.equal(last.if, 'always()');
  assert.match(last.run, /secrets-file\.sh clear/);
  // Every step that can see a secret turns tracing off first.
  for (const s of steps) {
    if (s.run && /\$\{\{\s*secrets[.[]/.test(JSON.stringify(s.env || {}))) assert.match(s.run, /^set \+x/, s.name);
  }
  // Every checkout drops its credentials.
  for (const s of steps.filter((x) => /actions\/checkout/.test(x.uses || ''))) assert.equal(s.with['persist-credentials'], false);
  // The modes not built yet are refused in the first job, with their piece.
  assert.match(doc.jobs.check.steps[0].run, /smoke\) echo "::error::mode smoke is not built yet: it arrives with piece 2/);
  assert.match(doc.jobs.check.steps[0].run, /live\|rollback\) echo "::error::mode \$MODE is not built yet: it arrives with piece 3/);
});
