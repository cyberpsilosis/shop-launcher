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
const LOGGED = ['useradd', 'chmod', 'install', 'curl', 'tar', 'systemctl', 'sudo', 'jq', 'sha256sum', 'node', 'npm'];
const NODE_VERSION = 'v24.21.0';
const NODE_SHA256_X64 = '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz`;
const RUNNER_SHA = 'a'.repeat(64);

// Fake .runner files left in /tmp would stop a real run on this machine
// (its scan reads /tmp too), so every temp folder goes when the tests end.
const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

// without: commands the machine does not have. PATH then holds only the
// shims and links to the real /usr/bin and /bin tools, minus those.
function sandbox({ root = true, userExists = false, without = [] } = {}) {
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
  shim('chown', `echo "chown $*" >> ${log}`);
  const release = JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'actions-runner-linux-x64-9.9.9.tar.gz', digest: `sha256:${RUNNER_SHA}` }] });
  shim('curl', `echo "curl $*" >> ${log}; for a in "$@"; do [ "$p" = -o ] && : > "$a"; p="$a"; done
case "$*" in *api.github.com*) echo '${release}';; esac`);
  // Logs the line it was asked to check, so a test sees the pinned hash.
  shim('sha256sum', `echo "sha256sum $* <$(cat)>" >> ${log}`);
  // Node's tarball unpacks a node that answers the pinned version and runs
  // the real node for -e; GitHub's unpacks a recording config.sh.
  shim('tar', `echo "tar $*" >> ${log}; for a in "$@"; do [ "$p" = -C ] && d="$a"; p="$a"; done
if [ "\${d##*/}" = node ]; then
  mkdir -p "$d/bin"
  printf '#!/bin/bash\nif [ "$1" = --version ]; then echo ${NODE_VERSION}; exit; fi\nexec ${process.execPath} "$@"\n' > "$d/bin/node"
  printf '#!/bin/bash\necho 11.6.0\n' > "$d/bin/npm"
  /bin/chmod +x "$d/bin/node" "$d/bin/npm"
  exit 0
fi
cat > "$d/config.sh" <<'CFG'
#!/bin/bash
printf '%s\\n' "$@" > "$RUNNER_PROBE/argv"
printf '%s' "\${ACTIONS_RUNNER_INPUT_TOKEN:-}" > "$RUNNER_PROBE/env-token"
pid=$$; : > "$RUNNER_PROBE/cmdlines"
while [ "\${pid:-0}" -gt 1 ]; do
  tr '\\0' ' ' < /proc/$pid/cmdline >> "$RUNNER_PROBE/cmdlines"; echo >> "$RUNNER_PROBE/cmdlines"
  pid=$(awk '/^PPid:/ {print $2}' /proc/$pid/status)
done
CFG
printf '#!/bin/bash\necho "svc.sh $*" >> ${log}\n' > "$d/svc.sh"
/bin/chmod +x "$d/config.sh" "$d/svc.sh"`);
  shim('sudo', `echo "sudo $*" >> ${log}; [ "$1" = -u ] && shift 2; exec "$@"`);
  let PATH = `${bin}:/usr/bin:/bin`;
  if (without.length) {
    const sys = path.join(t, 'sys');
    fs.mkdirSync(sys);
    for (const d of ['/bin', '/usr/bin']) {
      for (const n of fs.readdirSync(d)) {
        if (without.includes(n) || fs.existsSync(path.join(sys, n))) continue;
        fs.symlinkSync(path.join(d, n), path.join(sys, n));
      }
    }
    for (const n of without) fs.rmSync(path.join(bin, n), { force: true });
    PATH = `${bin}:${sys}`;
  }
  // systemd is running unless a test removes this folder.
  const systemd = path.join(t, 'run-systemd');
  fs.mkdirSync(systemd);
  const wslConf = path.join(t, 'wsl.conf');
  const env0 = {
    PATH,
    LAUNCHER_RUNNER_HOME_BASE: home,
    LAUNCHER_RUNNER_UNIT_DIR: units,
    LAUNCHER_RUNNER_SCAN_ROOT: disk,
    LAUNCHER_RUNNER_SYSTEMD_RUN: systemd,
    LAUNCHER_RUNNER_WSL_CONF: wslConf,
    RUNNER_PROBE: t,
    LAUNCHER_RUNNER_NO_REGISTER: '1',
  };
  const run = (env = {}, input = '') => {
    const r = spawnSync('/bin/bash', [SH], {
      encoding: 'utf8',
      input,
      env: { ...env0, ...env },
    });
    // `systemctl list-units` only lists the runner services; every other
    // logged call would change something.
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter((c) => c && !c.startsWith('systemctl list-units'));
    return { ...r, calls };
  };
  return { t, bin, log, disk, home, units, systemd, wslConf, env0, release, run };
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
  assert.match(cmdlines, /config\.sh --unattended --url https:\/\/github\.com\/cyberpsilosis\/shop-launcher/, 'the probe really read the command lines');
  assert.match(cmdlines, /bash -c export ACTIONS_RUNNER_INPUT_TOKEN=/, 'including the runner user shell above config.sh');
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
  const cleared = SRC.indexOf('\nTOKEN=""\nSTEP="installing');
  assert.ok(cleared > SRC.indexOf('./config.sh --unattended') && cleared < SRC.indexOf('./svc.sh install "$U"'), 'token cleared right after config.sh, before the service starts');
  // Every refusal comes before the first change.
  const firstWrite = SRC.indexOf('\nuseradd ');
  const lastDie = SRC.lastIndexOf('die "', SRC.indexOf('echo "== runner services before"'));
  assert.ok(firstWrite > 0 && lastDie > 0 && lastDie < firstWrite);
  // No-register exits before the download.
  assert.ok(SRC.indexOf('exit 0') < SRC.indexOf('curl -fsSL https://api.github.com'));
  assert.ok(SRC.indexOf('exit 0') < SRC.indexOf('curl -fsSL -o "$NTGZ"'), 'and before the Node download');
  // Label the workflows ask for, default labels kept (self-hosted is one).
  assert.match(SRC, /^LABEL="shop-launcher"$/m);
  assert.doesNotMatch(CODE, /--no-default-labels/);
});

// ---------------------------------------------------------------------------
// Elijah's paste line (README, "Add the runner"). PowerShell hands the part in
// single quotes to wsl inside double quotes, and wsl runs it through WSL's own
// shell, so the tests run it the same way: bash -c "bash -c \"<inner>\"".
const README = fs.readFileSync(path.resolve(path.dirname(SH), '..', 'README.md'), 'utf8');
const LINE = README.match(/```powershell\n(gh api [^\n]+)\n```/)[1];
const INNER = LINE.match(/ wsl -u root -- bash -c '(.*)'$/)[1];
const NOT_ON_MAIN = 'STOP: scripts/add-launcher-runner.sh is not on main yet - merge pull request #5, then paste this again. Nothing changed.';
const OLDER_ON_MAIN = 'STOP: main still has the older runner script - merge pull request #5 and wait five minutes, then paste this again. Nothing changed.';
const OFFLINE = 'STOP: the laptop cannot reach raw.githubusercontent.com - check it is online, then paste this again. Nothing changed.';
const MAIN_SH = 'https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/scripts/add-launcher-runner.sh';
const MAIN_README = 'https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/README.md';

// raw.githubusercontent.com as a shim: `answers` maps a URL to 200, 404 or
// 'down'. A bash shim runs the real script from this checkout when the line
// asks for /root/add-launcher-runner.sh, so nothing outside the sandbox is read.
// served: what main's copy of the script is: 'new' (this checkout) or 'old'
// (the script before SCRIPT_REV=3, as main had it after #2).
function pasteLine(s, answers, env = {}, input = '', served = 'new') {
  const old = path.join(s.t, 'old-script.sh');
  fs.writeFileSync(old, SRC.replace(/SCRIPT_REV=3/g, ''));
  const served_ = served === 'new' ? SH : old;
  fs.writeFileSync(path.join(s.bin, 'grep'), `#!/bin/bash
args=(); for a in "$@"; do [ "$a" = /root/add-launcher-runner.sh ] && a=${served_}; args+=("$a"); done
exec /bin/grep "\${args[@]}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(s.bin, 'rm'), `#!/bin/bash
case " $* " in *" /root/add-launcher-runner.sh "*) echo "rm $*" >> ${s.log}; exit 0;; esac
exec /bin/rm "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(s.bin, 'curl'), `#!/bin/bash
echo "curl $*" >> ${s.log}
for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in
${Object.entries(answers).map(([u, a]) => `  ${u}) code=${a === 'down' ? 6 : a === 404 ? 22 : 0};;`).join('\n')}
  *) code=0;;
esac
[ "$code" = 22 ] && case " $* " in *" -f"*) ;; *) code=0;; esac
[ "$code" = 0 ] && case "$url" in *api.github.com*) echo '${s.release}';; esac
exit $code
`, { mode: 0o755 });
  fs.writeFileSync(path.join(s.bin, 'bash'), `#!/bin/bash
if [ "$1" = /root/add-launcher-runner.sh ]; then shift; exec /bin/bash ${SH} "$@"; fi
exec /bin/bash "$@"
`, { mode: 0o755 });
  const r = spawnSync('/bin/bash', ['-c', `bash -c "${INNER}"`], {
    encoding: 'utf8',
    input,
    env: { ...s.env0, ...env },
  });
  const calls = fs.readFileSync(s.log, 'utf8').split('\n').filter((c) => c && !c.startsWith('systemctl list-units'));
  return { ...r, calls };
}

test('the paste line survives PowerShell and WSL quoting and is the one in the script header', () => {
  assert.ok(SRC.includes(`#   LINE: ${LINE}\n`), 'script header and README carry the same line');
  assert.doesNotMatch(INNER, /[$"'`]/, 'no $, double quote, apostrophe or backtick inside the single quotes');
  assert.doesNotMatch(INNER.replace(/\\#/g, ''), /#/, 'every # is escaped, so none starts a comment');
  assert.match(LINE, /^gh api -X POST repos\/cyberpsilosis\/shop-launcher\/actions\/runners\/registration-token --jq \.token \| wsl -u root -- bash -c '/);
  assert.doesNotMatch(LINE, /\/tmp\//, 'root runs nothing from /tmp, where another user could plant it');
});

test('not on main yet: the fetch 404s, the output is the STOP line, nothing is created or registered', () => {
  const s = sandbox();
  const before = fs.readdirSync(s.home, { recursive: true }).sort();
  const r = pasteLine(s, { [MAIN_SH]: 404, [MAIN_README]: 200 }, { LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\r\n');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `${NOT_ON_MAIN}\n`);
  assert.equal(r.stderr, '', 'no bare curl error');
  assert.deepEqual(r.calls, [`curl -fsLo /root/add-launcher-runner.sh ${MAIN_SH}`, `curl -fsLo /dev/null ${MAIN_README}`]);
  assert.deepEqual(fs.readdirSync(s.home, { recursive: true }).sort(), before, 'nothing created');
  assert.ok(!fs.existsSync(path.join(s.t, 'argv')), 'config.sh never ran');
});

test('offline: both fetches fail and the output is the offline STOP line, nothing created', () => {
  const s = sandbox();
  const r = pasteLine(s, { [MAIN_SH]: 'down', [MAIN_README]: 'down' }, { LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\r\n');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `${OFFLINE}\n`);
  assert.equal(r.stderr, '');
  assert.equal(r.calls.filter((c) => !c.startsWith('curl ')).length, 0);
  assert.deepEqual(fs.readdirSync(s.home), []);
});

test('on main: the line runs the script (no-register makes the user and folder only)', () => {
  const s = sandbox();
  const r = pasteLine(s, { [MAIN_SH]: 200 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LAUNCHER_RUNNER_NO_REGISTER=1: made ci-shop-launcher and .*actions-runner only/);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['curl', 'useradd', 'chmod', 'install']);
});

test('older script on main (#5 not merged yet): the STOP line, the download removed, nothing run', () => {
  const s = sandbox();
  const r = pasteLine(s, { [MAIN_SH]: 200 }, { LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\r\n', 'old');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `${OLDER_ON_MAIN}\n`);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.calls, [`curl -fsLo /root/add-launcher-runner.sh ${MAIN_SH}`, 'rm -f /root/add-launcher-runner.sh']);
  assert.deepEqual(fs.readdirSync(s.home), [], 'nothing created');
  assert.ok(!fs.existsSync(path.join(s.t, 'argv')), 'config.sh never ran');
});

test('on main: the token from gh passes both shells and reaches config.sh only through its environment', () => {
  const s = sandbox();
  const token = 'AFAKEREGISTRATIONTOKEN0000000000';
  const r = pasteLine(s, { [MAIN_SH]: 200 }, { LAUNCHER_RUNNER_NO_REGISTER: '' }, `${token}\r\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Done: runner laptop-shop-launcher \(label shop-launcher\) runs as ci-shop-launcher\./);
  assert.equal(fs.readFileSync(path.join(s.t, 'env-token'), 'utf8'), token);
  assert.doesNotMatch(fs.readFileSync(path.join(s.t, 'cmdlines'), 'utf8'), new RegExp(token));
});

const tokenStops = [
  ['nothing (gh failed or is logged out)', '', /^STOP: no registration token came in from gh - in PowerShell run gh auth status .*; nothing changed$/],
  ['null (gh --jq on an error)', 'null\r\n', /^STOP: what came in from gh is not a runner registration token - .*; nothing changed$/],
  ["gh's error text", '{"message":"Not Found","status":"404"}\n', /^STOP: what came in from gh is not a runner registration token - .*; nothing changed$/],
];
for (const [what, input, msg] of tokenStops) {
  test(`gh sends ${what}: one STOP line, nothing changed`, () => {
    const s = sandbox();
    const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, input);
    assert.equal(r.status, 1);
    assert.match(r.stderr.trim(), msg);
    assert.equal(r.stderr.trim().split('\n').length, 1, 'exactly one line');
    assert.deepEqual(r.calls, []);
    assert.deepEqual(fs.readdirSync(s.home), []);
    if (input.startsWith('{')) assert.doesNotMatch(r.stderr, /Not Found/, 'what came in is never printed');
  });
}

test('a failing download ends in one STOP line that names the step and the undo', () => {
  const s = sandbox();
  const r0 = s.run; // replace curl: the release API call fails
  const curl0 = fs.readFileSync(path.join(s.bin, 'curl'), 'utf8');
  fs.writeFileSync(path.join(s.bin, 'curl'), curl0.replace('\n', '\ncase "$*" in *api.github.com*) echo "curl $*" >> ' + s.log + '; exit 22;; esac\n'), { mode: 0o755 });
  const r = r0({ LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\n');
  assert.equal(r.status, 1);
  const last = r.stderr.trim().split('\n').pop();
  assert.match(last, /^STOP: downloading GitHub's runner failed \(exit 22, line \d+\); the user ci-shop-launcher exists but no runner is registered, so run wsl -u root -- userdel -r ci-shop-launcher in PowerShell, then paste the line again$/);
  assert.equal((r.stderr.match(/STOP:/g) || []).length, 1, 'one STOP line');
  assert.ok(!fs.existsSync(path.join(s.t, 'argv')), 'config.sh never ran');
});

test('a failing config.sh ends in one STOP line: nothing registered, the undo named', () => {
  const s = sandbox();
  // tar puts a config.sh that fails, as an expired token would make it.
  const tar = fs.readFileSync(path.join(s.bin, 'tar'), 'utf8').replace(/printf '%s\\n' "\$@" > "\$RUNNER_PROBE\/argv"/, '$&\nexit 3');
  fs.writeFileSync(path.join(s.bin, 'tar'), tar, { mode: 0o755 });
  const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\n');
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(path.join(s.t, 'argv')), 'config.sh ran');
  const last = r.stderr.trim().split('\n').pop();
  assert.match(last, /^STOP: registering with GitHub \(the token lasts one hour\) failed \(exit 3, line \d+\); the user ci-shop-launcher exists but no runner is registered, so run wsl -u root -- userdel -r ci-shop-launcher in PowerShell, then paste the line again$/);
  assert.ok(!r.calls.some((c) => c.startsWith('svc.sh')), 'no service installed');
});

test('every STOP in the script says what changed: nothing, or how to undo it', () => {
  assert.match(SRC, /elif \[ -z "\$UNDO" \]; then echo "STOP: \$\*; nothing changed" >&2/);
  assert.match(SRC, /echo "STOP: \$\*; nothing changed\. To fix it, paste this one line in PowerShell, then paste the setup line again:" >&2\n    echo "    \$FIX" >&2/);
  assert.match(SRC, /^trap 'die "\$STEP failed \(exit \$\?, line \$LINENO\)"' ERR$/m);
  assert.doesNotMatch(CODE, /echo "STOP:(?! \$\*)/, 'every STOP goes through die');
  // UNDO is set before the first change and before registering.
  assert.ok(SRC.indexOf('UNDO="the user $U may exist now') < SRC.indexOf('\nuseradd '));
  assert.ok(SRC.indexOf('UNDO="the runner is registered but not running') < SRC.indexOf('./svc.sh install "$U"'));
});

// ---------------------------------------------------------------------------
// Prerequisites (attempt 3: "STOP: node is not installed; nothing changed").

test('no node anywhere: the registering path installs the pinned Node and the runner user finds it', () => {
  // The machine has no node, npm or jq at all: not on root's PATH, not in /usr/bin.
  const s = sandbox({ without: ['node', 'npm', 'nodejs', 'jq'] });
  const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\r\n');
  assert.equal(r.status, 0, r.stderr);
  const nodeDir = `${s.home}/${U}/node`;
  // Downloaded from nodejs.org at the pinned version, checked against the pinned hash.
  assert.ok(r.calls.some((c) => /^curl -fsSL -o \S+ /.test(c) && c.endsWith(NODE_URL)), r.calls.join('\n'));
  assert.ok(r.calls.some((c) => c.startsWith('sha256sum -c --quiet - <') && c.includes(`${NODE_SHA256_X64}  `)), 'pinned Node SHA-256 checked');
  assert.ok(r.calls.includes(`install -d -m 755 -o root -g root ${nodeDir}`), 'Node folder owned by root');
  assert.ok(r.calls.some((c) => c.startsWith('tar -xzf ') && c.endsWith(`-C ${nodeDir} --strip-components=1 --no-same-owner`)));
  // The Node check comes before the download, and the download before tar.
  const at = (re) => r.calls.findIndex((c) => re.test(c));
  assert.ok(at(/nodejs\.org/) < at(/^sha256sum .*6e1db87e/) && at(/^sha256sum .*6e1db87e/) < at(/^tar .*\/node /));
  assert.match(r.stdout, /installed Node v24\.21\.0 and npm 11\.6\.0 in .*\/ci-shop-launcher\/node \(pinned SHA-256 matched\)/);
  // The runner's PATH (read by runsvc.sh for every job) puts that Node first.
  const dotPath = fs.readFileSync(path.join(s.home, U, 'actions-runner', '.path'), 'utf8');
  assert.equal(dotPath, `${nodeDir}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n`);
  assert.match(r.stdout, /as ci-shop-launcher, the runner's PATH finds node v24\.21\.0/);
  assert.ok(r.calls.includes(`sudo -u ${U} env PATH=${dotPath.trim()} node --version`), 'checked as the runner user');
  // It never asked the machine for a node or jq of its own.
  assert.ok(!r.calls.some((c) => /^(node|npm|jq) /.test(c)), 'no machine node, npm or jq used');
  assert.ok(r.calls.includes('svc.sh install ci-shop-launcher'));
  assert.match(r.stdout, /Done: runner laptop-shop-launcher/);
});

test('Node that fails its pinned SHA-256 is not installed, and nothing is registered', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.bin, 'sha256sum'), `#!/bin/bash\nl="$(cat)"; echo "sha256sum $* <$l>" >> ${s.log}\ncase "$l" in ${NODE_SHA256_X64}*) exit 1;; esac\n`, { mode: 0o755 });
  const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\n');
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'STOP: Node v24.21.0 did not match its pinned SHA-256, so it was not installed; the user ci-shop-launcher exists but no runner is registered, so run wsl -u root -- userdel -r ci-shop-launcher in PowerShell, then paste the line again');
  assert.ok(!r.calls.some((c) => c.startsWith('tar ')), 'nothing unpacked');
  assert.ok(!fs.existsSync(path.join(s.home, U, 'node')), 'no Node folder');
  assert.ok(!fs.existsSync(path.join(s.t, 'argv')), 'config.sh never ran');
});

test('missing tools: one STOP naming them all, then the one install line, and nothing changed', () => {
  const s = sandbox({ without: ['curl', 'sudo', 'systemctl', 'node', 'npm', 'jq'] });
  const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\r\n');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '== checks (nothing changed yet)\n');
  assert.equal(r.stderr,
    'STOP: WSL is missing curl, systemctl, sudo; nothing changed. To fix it, paste this one line in PowerShell, then paste the setup line again:\n' +
    '    wsl -u root -- sh -c "apt-get update && apt-get install -y curl systemd sudo"\n');
  assert.deepEqual(r.calls, []);
  assert.deepEqual(fs.readdirSync(s.home), []);
});

test('missing tools on the no-register path name only what it uses', () => {
  const s = sandbox({ without: ['useradd', 'curl'] });
  const r = s.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^STOP: WSL is missing useradd; nothing changed\. .*\n    wsl -u root -- sh -c "apt-get update && apt-get install -y passwd"\n$/);
  assert.deepEqual(r.calls, []);
});

test('systemd not running: the STOP line gives the wsl.conf fix and wsl --shutdown, nothing changed', () => {
  const s = sandbox();
  fs.rmdirSync(s.systemd);
  fs.writeFileSync(s.wslConf, '[user]\ndefault=elijah\n');
  const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\r\n');
  assert.equal(r.status, 1);
  const [stop, fix, ...rest] = r.stderr.split('\n');
  assert.equal(stop, 'STOP: systemd is not running in WSL, and the runner needs it to start as a service; nothing changed. To fix it, paste this one line in PowerShell, then paste the setup line again:');
  assert.equal(fix, `    wsl -u root -- sh -c "printf '\\n[boot]\\nsystemd=true\\n' >> /etc/wsl.conf"; wsl --shutdown`);
  assert.deepEqual(rest, ['']);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(fs.readdirSync(s.home), []);
  // What the fix does: PowerShell passes the double-quoted part to wsl, whose
  // shell runs sh -c on it. Run that on a copy of wsl.conf.
  const cmd = fix.trim().match(/^wsl -u root -- (sh -c ".*")\; wsl --shutdown$/)[1].replace('/etc/wsl.conf', s.wslConf);
  const out = spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(s.wslConf, 'utf8'), '[user]\ndefault=elijah\n\n[boot]\nsystemd=true\n');
});

test('systemd switched on but WSL not restarted: the fix is wsl --shutdown alone', () => {
  const s = sandbox();
  fs.rmdirSync(s.systemd);
  fs.writeFileSync(s.wslConf, '[boot]\nsystemd = true\n');
  const r = s.run({ LAUNCHER_RUNNER_NO_REGISTER: '' }, 'AFAKEREGISTRATIONTOKEN0000000000\r\n');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'STOP: systemd is switched on in /etc/wsl.conf but WSL has not restarted since; nothing changed. To fix it, paste this one line in PowerShell, then paste the setup line again:\n    wsl --shutdown\n');
  assert.deepEqual(r.calls, []);
});

test('the no-register path needs no systemd, no Node and no download', () => {
  const s = sandbox({ without: ['node', 'npm', 'curl', 'systemctl', 'sudo', 'jq'] });
  fs.rmdirSync(s.systemd);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['useradd', 'chmod', 'install']);
});
