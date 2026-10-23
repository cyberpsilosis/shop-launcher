// scripts/add-launcher-runner.sh without root: the system commands it would
// call are shims in a temp PATH that log each call, so a test can see what
// the script would change. The real scratch-machine run (as root) is in the
// pull request; this keeps the refusals and the no-register path from
// drifting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'add-launcher-runner.sh');
const SRC = fs.readFileSync(SH, 'utf8');
const CODE = SRC.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const U = 'ci-shop-launcher';

// Commands that change the machine, or reach the network or the runner.
const LOGGED = ['useradd', 'chmod', 'install', 'curl', 'tar', 'systemctl', 'sudo', 'jq', 'sha256sum'];

// Fake .runner files left in /tmp would stop a real run on this machine
// (its scan reads /tmp too), so every temp folder goes when the tests end.
const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

function sandbox({ root = true, userExists = false } = {}) {
  const t = tmp('runner-');
  const bin = path.join(t, 'bin');
  const home = path.join(t, 'home');
  const units = path.join(t, 'units');
  const log = path.join(t, 'calls.log');
  for (const d of [bin, home, units]) fs.mkdirSync(d);
  // Stands in for / in the disk-wide .runner scan; home sits inside it.
  const disk = t;
  fs.writeFileSync(log, '');
  const shim = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  shim('id', `if [ "$1" = -u ]; then echo ${root ? 0 : 1000}; elif [ "$1" = -nG ]; then echo "$2"; else echo "uid=1($2)"; fi`);
  shim('getent', `[ "$1" = passwd ] && [ "$2" = ${U} ] && ${userExists ? 'exit 0' : 'exit 2'}; exit 2`);
  for (const c of LOGGED) shim(c, `echo "${c} $*" >> ${log}`);
  // useradd and install also make the folder, as the real ones would.
  shim('useradd', `echo "useradd $*" >> ${log}; for a in "$@"; do last="$a"; done; d="$(sed -n 's/.*--home-dir \\([^ ]*\\).*/\\1/p' <<<"$*")"; mkdir -p "$d"`);
  shim('install', `echo "install $*" >> ${log}; for a in "$@"; do last="$a"; done; mkdir -p "$last"`);
  shim('stat', 'true');
  shim('uname', 'echo x86_64');
  // For the registering path: a fake release, a fake runner whose config.sh
  // records its own argv, its environment and the command line of every
  // process above it, and a sudo that drops "-u <user>".
  shim('node', 'echo 22');
  shim('npm', 'true');
  shim('chown', `echo "chown $*" >> ${log}`);
  shim('curl', `echo "curl $*" >> ${log}; for a in "$@"; do [ "$p" = -o ] && : > "$a"; p="$a"; done; echo '{}'`);
  shim('jq', `echo "jq $*" >> ${log}; case "$*" in *tag_name*) echo v9.9.9;; *digest*) echo sha256:${'a'.repeat(64)};; esac`);
  shim('sha256sum', `echo "sha256sum $*" >> ${log}; cat >/dev/null`);
  shim('tar', `echo "tar $*" >> ${log}; for a in "$@"; do [ "$p" = -C ] && d="$a"; p="$a"; done
cat > "$d/config.sh" <<'CFG'
#!/bin/bash
printf '%s\n' "$@" > "$RUNNER_PROBE/argv"
printf '%s' "\${ACTIONS_RUNNER_INPUT_TOKEN:-}" > "$RUNNER_PROBE/env-token"
pid=$$; : > "$RUNNER_PROBE/cmdlines"
while [ "\${pid:-0}" -gt 1 ]; do
  tr '\0' ' ' < /proc/$pid/cmdline >> "$RUNNER_PROBE/cmdlines"; echo >> "$RUNNER_PROBE/cmdlines"
  pid=$(awk '/^PPid:/ {print $2}' /proc/$pid/status)
done
CFG
printf '#!/bin/bash\necho "svc.sh $*" >> ${log}\n' > "$d/svc.sh"
/bin/chmod +x "$d/config.sh" "$d/svc.sh"`);
  shim('sudo', `echo "sudo $*" >> ${log}; [ "$1" = -u ] && shift 2; exec "$@"`);
  const run = (env = {}, input = '') => {
    const r = spawnSync('bash', [SH], {
      encoding: 'utf8',
      input,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LAUNCHER_RUNNER_HOME_BASE: home,
        LAUNCHER_RUNNER_UNIT_DIR: units,
        LAUNCHER_RUNNER_SCAN_ROOT: disk,
        RUNNER_PROBE: t,
        LAUNCHER_RUNNER_NO_REGISTER: '1',
        ...env,
      },
    });
    // `systemctl list-units` only lists the runner services; every other
    // logged call would change something.
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter((c) => c && !c.startsWith('systemctl list-units'));
    return { ...r, calls };
  };
  return { t, disk, home, units, run };
}

test('no-register makes the user and the runner folder and nothing else', () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['useradd', 'chmod', 'install']);
  assert.match(r.calls[0], new RegExp(`--home-dir ${s.home}/${U} --user-group --shell /bin/bash ${U}$`));
  assert.equal(r.calls[1], `chmod 750 ${s.home}/${U}`);
  assert.equal(r.calls[2], `install -d -m 750 -o ${U} -g ${U} ${s.home}/${U}/actions-runner`);
  assert.doesNotMatch(r.calls.join('\n'), /\b(curl|tar|systemctl|sudo|config\.sh|svc\.sh)\b/);
  assert.match(r.stdout, /Not downloading, registering or starting a runner/);
});

const refusals = [
  ['an existing ci-shop-launcher user', { userExists: true }, () => {}, /user ci-shop-launcher already exists/],
  ['an existing home folder', {}, (s) => fs.mkdirSync(path.join(s.home, U)), /already exists; nothing changed/],
  ['an installed shop-launcher runner service', {}, (s) =>
    fs.writeFileSync(path.join(s.units, 'actions.runner.cyberpsilosis-shop-launcher.laptop-old.service'), ''),
  /runner service already exists/],
  ["another user's runner registered to shop-launcher", {}, (s) => {
    fs.mkdirSync(path.join(s.home, 'ci-other', 'actions-runner'), { recursive: true });
    fs.writeFileSync(path.join(s.home, 'ci-other', 'actions-runner', '.runner'),
      '﻿{\n  "agentName": "old",\n  "gitHubUrl": "https://github.com/cyberpsilosis/shop-launcher"\n}');
  }, /already registered to cyberpsilosis\/shop-launcher/],
  ['a runner registered to shop-launcher outside /home', {}, (s) =>
    writeRunner(path.join(s.disk, 'opt', 'runners', 'a', 'b', 'shop', '.runner'), 'https://github.com/cyberpsilosis/shop-launcher'),
  /opt\/runners\/a\/b\/shop\/\.runner is already registered/],
  ['a runner in an installed service folder off the scanned disk', {}, (s) => {
    const off = tmp('offdisk-');
    writeRunner(path.join(off, '.runner'), 'https://github.com/cyberpsilosis/shop-launcher');
    fs.writeFileSync(path.join(s.units, 'actions.runner.cyberpsilosis-renamed.x.service'),
      `[Service]\nExecStart=${off}/runsvc.sh\nWorkingDirectory=${off}\n`);
  }, /offdisk-.*\.runner is already registered/],
  ['a shop-launcher URL with a trailing slash', {}, (s) =>
    writeRunner(path.join(s.home, 'ci-other', 'actions-runner', '.runner'), 'https://github.com/cyberpsilosis/shop-launcher/'),
  /already registered to cyberpsilosis\/shop-launcher/],
  ['a shop-launcher URL with a .git suffix', {}, (s) =>
    writeRunner(path.join(s.home, 'ci-other', 'actions-runner', '.runner'), 'https://github.com/cyberpsilosis/shop-launcher.git'),
  /already registered to cyberpsilosis\/shop-launcher/],
  ['a shop-launcher URL with .git/ and other letter case', {}, (s) =>
    writeRunner(path.join(s.home, 'ci-other', 'actions-runner', '.runner'), 'https://GitHub.com/Cyberpsilosis/Shop-Launcher.git/'),
  /already registered to cyberpsilosis\/shop-launcher/],
  ['no root', { root: false }, () => {}, /run it with sudo/],
];

// A .runner file as config.sh writes it: UTF-8 BOM, then indented JSON.
function writeRunner(f, url) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `\ufeff{\n  "agentName": "old",\n  "gitHubUrl": "${url}"\n}`);
}

for (const [what, opts, setup, msg] of refusals) {
  test(`refuses ${what}, before any change`, () => {
    const s = sandbox(opts);
    setup(s);
    const before = fs.readdirSync(s.home, { recursive: true }).sort();
    const r = s.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, msg);
    assert.match(r.stderr, /nothing changed/);
    assert.deepEqual(r.calls, [], 'no command that changes the machine ran');
    assert.deepEqual(fs.readdirSync(s.home, { recursive: true }).sort(), before);
  });
}

test("a runner for another repository does not stop it, and its file is left alone", () => {
  const s = sandbox();
  const f = path.join(s.home, 'ci-orb-shop', 'actions-runner', '.runner');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"gitHubUrl": "https://github.com/cyberpsilosis/shop-launcher-old"}');
  // Look-alikes outside /home must not stop it either.
  writeRunner(path.join(s.disk, 'opt', 'r1', '.runner'), 'https://github.com/cyberpsilosis/shop-launcher.github');
  writeRunner(path.join(s.disk, 'opt', 'r2', '.runner'), 'https://github.com/cyberpsilosis/orb-shop.git/');
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"gitHubUrl": "https://github.com/cyberpsilosis/shop-launcher-old"}');
  assert.ok(r.calls.every((c) => !c.includes('ci-orb-shop') && !c.includes('/opt/')), 'never touches the other runners');
});

test('the registration token reaches config.sh in no command line, only its environment', () => {
  const s = sandbox();
  const token = 'AFAKEREGISTRATIONTOKEN0000000000';
  const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, `${token}\r\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Done: runner laptop-shop-launcher \(label shop-launcher\) runs as ci-shop-launcher\./);
  const probe = (n) => fs.readFileSync(path.join(s.t, n), 'utf8');
  // config.sh got the token from ACTIONS_RUNNER_INPUT_TOKEN, \r from PowerShell stripped.
  assert.equal(probe('env-token'), token);
  const argv = probe('argv');
  assert.doesNotMatch(argv, /--token/);
  assert.doesNotMatch(argv, new RegExp(token));
  assert.match(argv, /^--unattended\n--url\nhttps:\/\/github\.com\/cyberpsilosis\/shop-launcher\n--name\nlaptop-shop-launcher\n--labels\nshop-launcher\n/);
  // What `ps` would show: config.sh and every process above it.
  const cmdlines = probe('cmdlines');
  assert.ok(cmdlines.split('\n').filter(Boolean).length >= 3, cmdlines);
  assert.doesNotMatch(cmdlines, new RegExp(token), 'token in a process command line');
  assert.doesNotMatch(r.calls.join('\n'), new RegExp(token), 'token in a logged command');
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(token), 'token printed');
  // Nothing in the runner folder holds it.
  for (const f of fs.readdirSync(s.home, { recursive: true })) {
    const p = path.join(s.home, f);
    if (fs.statSync(p).isFile()) assert.doesNotMatch(fs.readFileSync(p, 'utf8'), new RegExp(token), p);
  }
  assert.ok(r.calls.some((c) => c === 'svc.sh install ci-shop-launcher'));
});

test('the registering path takes no token from argv or env and never stores it', () => {
  assert.doesNotMatch(CODE, /--replace/);
  assert.doesNotMatch(SRC, /\$\{?TOKEN\}?"?\s*>/, 'no redirect of the token into a file');
  assert.doesNotMatch(SRC, /TOKEN="\$\{?[A-Z_]*TOKEN[A-Z_]*:-/, 'token is not taken from an env var');
  assert.match(SRC, /printf '%s' "\$TOKEN" \| sudo -u "\$U"/, 'token goes to the runner user through a pipe');
  assert.match(CODE, /export ACTIONS_RUNNER_INPUT_TOKEN="\$\(cat\)"/, 'and to config.sh through its environment');
  assert.doesNotMatch(CODE, /--token/, 'never as a config.sh argument');
  assert.match(SRC, /TOKEN=""\n\(cd "\$DIR" && \.\/svc\.sh install/, 'token cleared before the service starts');
  // Every refusal comes before the first change.
  const firstWrite = SRC.indexOf('\nuseradd ');
  const lastDie = SRC.lastIndexOf('die "', SRC.indexOf('echo "== runner services before"'));
  assert.ok(firstWrite > 0 && lastDie > 0 && lastDie < firstWrite);
  // No-register exits before the download.
  assert.ok(SRC.indexOf('exit 0') < SRC.indexOf('curl -fsSL https://api.github.com'));
  // Label the workflows ask for, default labels kept (self-hosted is one).
  assert.match(SRC, /^LABEL="shop-launcher"$/m);
  assert.doesNotMatch(CODE, /--no-default-labels/);
});
