// The secrets file's life: made mode 600 under RUNNER_TEMP, deleted by the
// always() step, and RUNNER_TEMP emptied at the end of the job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'secrets-file.sh');
const sh = (runnerTemp, ...args) => spawnSync(SH, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp } });

test('create makes a mode-600 file inside RUNNER_TEMP', () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const r = sh(rt, 'create');
  assert.equal(r.status, 0, r.stderr);
  const f = r.stdout.trim();
  assert.ok(f.startsWith(rt + '/launch-secrets.'));
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
});

test('delete removes it, and refuses a path outside RUNNER_TEMP', () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const f = sh(rt, 'create').stdout.trim();
  fs.writeFileSync(f, '{"CRON_SECRET":"x"}');
  assert.equal(sh(rt, 'delete', f).status, 0);
  assert.ok(!fs.existsSync(f));
  const outside = path.join(os.tmpdir(), `keep-${process.pid}`);
  fs.writeFileSync(outside, 'keep');
  assert.equal(sh(rt, 'delete', outside).status, 1);
  assert.ok(fs.existsSync(outside));
  fs.rmSync(outside);
  assert.equal(sh(rt, 'delete', '').status, 0, 'nothing to delete in plan mode is fine');
});

test('clear empties RUNNER_TEMP and refuses / and HOME', () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  fs.mkdirSync(path.join(rt, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'a', 'b', 'summary.json'), '{}');
  sh(rt, 'create');
  assert.equal(sh(rt, 'clear').status, 0);
  assert.deepEqual(fs.readdirSync(rt), []);
  assert.equal(sh('/', 'clear').status, 1);
  assert.equal(sh(process.env.HOME, 'clear').status, 1);
});
