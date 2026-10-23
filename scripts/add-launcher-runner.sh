#!/usr/bin/env bash
# Add the self-hosted GitHub Actions runner for cyberpsilosis/shop-launcher
# to Elijah's laptop (WSL Ubuntu), beside the runners already there. Same
# pattern as orb-shop's scripts/laptop-runner/add-orb-shop-runner.sh: its
# own Linux user, its own folder, its own label, started by systemd. The
# launcher needs no database, so unlike the orb's runner it makes none.
#
# Elijah's one command, in Windows PowerShell on the laptop (README,
# "Add the runner"). It makes a one-hour registration token with gh and
# pipes it straight in, so the token is never shown, copied or saved:
#
#   gh api -X POST repos/cyberpsilosis/shop-launcher/actions/runners/registration-token --jq .token | wsl -u root -- bash -c 'curl -fsSLo /tmp/add-launcher-runner.sh https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/scripts/add-launcher-runner.sh && bash /tmp/add-launcher-runner.sh'
#
# Run by hand instead (sudo bash add-launcher-runner.sh), it asks for the
# token with the input hidden.
#
# It never touches another runner, user or service. It stops before
# changing anything if the ci-shop-launcher user or its home exists, if a
# shop-launcher runner service exists, or if a runner already registered to
# shop-launcher is found anywhere on the Linux disk (every local folder
# except /proc, /sys, /dev, /run and the Windows drives under /mnt) or in
# the folder of any installed runner service. The repository URL in a
# .runner file matches with or without a trailing slash or .git. It only
# reads those files. It never uses --replace.
#
# What it makes:
#   - user ci-shop-launcher: own group only, no password, no sudo, home 750
#   - GitHub's runner in /home/ci-shop-launcher/actions-runner, checked
#     against its published SHA-256, name laptop-shop-launcher, label
#     shop-launcher, as a systemd service running as ci-shop-launcher
# The registration token never appears in a command line, so `ps` and
# /proc/<pid>/cmdline never show it to another user. It reaches the runner
# user's shell through a pipe and config.sh through the environment
# variable ACTIONS_RUNNER_INPUT_TOKEN, which the runner reads, masks in its
# logs and removes from its environment. While config.sh runs (a few
# seconds), only root and ci-shop-launcher can read that environment
# (/proc/<pid>/environ is private to its owner). Nothing writes the token
# to disk.
#
# LAUNCHER_RUNNER_NO_REGISTER=1 makes the user and the empty runner folder
# and stops: no token, no download, no registration, no service. For trying
# it on a scratch machine.
#
# Undo (in this order): sudo ./svc.sh stop && sudo ./svc.sh uninstall in
# the runner folder; delete the runner under shop-launcher Settings >
# Actions > Runners; sudo userdel -r ci-shop-launcher.
set -euo pipefail

OWNER_REPO="cyberpsilosis/shop-launcher"
REPO_URL="https://github.com/${OWNER_REPO}"
LABEL="shop-launcher"
NAME="laptop-shop-launcher"
U="ci-shop-launcher"
HOME_BASE="${LAUNCHER_RUNNER_HOME_BASE:-/home}" # tests only; sudo resets it
UNIT_DIR="${LAUNCHER_RUNNER_UNIT_DIR:-/etc/systemd/system}" # tests only
H="${HOME_BASE}/${U}"
DIR="${H}/actions-runner"
UNIT_GLOB="actions.runner.${OWNER_REPO/\//-}.*"
NO_REGISTER="${LAUNCHER_RUNNER_NO_REGISTER:-}"

die() { echo "STOP: $*" >&2; exit 1; }

echo "== checks (nothing changed yet)"
[ "$(id -u)" -eq 0 ] || die "run it with sudo (or wsl -u root); nothing changed"
for c in useradd chmod install getent; do
  command -v "$c" >/dev/null || die "$c is not installed; nothing changed"
done
if [ "$NO_REGISTER" != 1 ]; then
  for c in curl jq tar sha256sum systemctl sudo node npm; do
    command -v "$c" >/dev/null || die "$c is not installed; nothing changed"
  done
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "launch.yml needs Node 20 or newer, found $(node --version); nothing changed"
fi
getent passwd "$U" >/dev/null && die "user $U already exists; nothing changed"
[ -e "$H" ] && die "$H already exists; nothing changed"
if compgen -G "${UNIT_DIR}/${UNIT_GLOB}" >/dev/null; then
  die "a shop-launcher runner service already exists in ${UNIT_DIR}; nothing changed"
fi
# Another user may already run this repository's runner, in any folder.
# Read every .runner file on the Linux disk and in each installed runner
# service's folder (read only) and stop if one is ours. -xdev keeps find on
# local disks, so the Windows drives under /mnt are not walked.
SCAN_ROOT="${LAUNCHER_RUNNER_SCAN_ROOT:-/}" # tests only
OURS="github\.com/${OWNER_REPO//./\\.}(\.git)?/*\""
runner_files() {
  find "$SCAN_ROOT" "$HOME_BASE" -xdev \
    \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /mnt \
       -o -name _work -o -name node_modules -o -name .git \) -prune \
    -o -name .runner -type f -print0 2>/dev/null || true
  for u in "${UNIT_DIR}"/actions.runner.*.service; do
    [ -f "$u" ] || continue
    d="$(sed -n 's/^WorkingDirectory=//p' "$u" | head -1)"
    [ -n "$d" ] && [ -f "$d/.runner" ] && printf '%s\0' "$d/.runner"
  done
  return 0
}
while IFS= read -r -d '' f; do
  if grep -Eqi -- "$OURS" "$f" 2>/dev/null; then
    die "$f is already registered to ${OWNER_REPO}; nothing changed"
  fi
done < <(runner_files)
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported machine $(uname -m); nothing changed" ;;
esac

TOKEN=""
if [ "$NO_REGISTER" != 1 ]; then
  if [ -t 0 ]; then
    read -rsp "Paste the shop-launcher registration token (it will not show), then press Enter: " TOKEN
    echo
  else
    IFS= read -r TOKEN || true # piped in from gh; PowerShell adds \r
  fi
  TOKEN="${TOKEN//[$'\r\n\t ']/}"
  [ -n "$TOKEN" ] || die "no token entered; nothing changed"
fi

echo "== runner services before"
systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print "   ", $1, $3, $4}' || true

echo "== user $U (own group, no password, no sudo)"
useradd --create-home --home-dir "$H" --user-group --shell /bin/bash "$U"
chmod 750 "$H"
groups_now="$(id -nG "$U")"
[ "$groups_now" = "$U" ] || die "$U is in groups '$groups_now', expected only '$U'"
if grep -rqsw -- "$U" /etc/sudoers /etc/sudoers.d; then
  die "$U is named in sudoers; remove it before going on"
fi
install -d -m 750 -o "$U" -g "$U" "$DIR"
echo "    $(id "$U")"
stat -c '    %A %U:%G %n' "$H" "$DIR"

if [ "$NO_REGISTER" = 1 ]; then
  echo "LAUNCHER_RUNNER_NO_REGISTER=1: made $U and $DIR only. Not downloading, registering or starting a runner."
  exit 0
fi

echo "== GitHub's Actions runner"
RELEASE="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
VERSION="$(jq -r .tag_name <<<"$RELEASE" | sed 's/^v//')"
ASSET="actions-runner-linux-${ARCH}-${VERSION}.tar.gz"
SHA256="$(jq -r --arg n "$ASSET" '.assets[] | select(.name == $n) | .digest // empty' <<<"$RELEASE" | sed 's/^sha256://')"
if [ -z "$SHA256" ]; then
  SHA256="$(jq -r .body <<<"$RELEASE" | grep -o "BEGIN SHA linux-${ARCH} -->[0-9a-f]\{64\}" | grep -o '[0-9a-f]\{64\}' | head -1 || true)"
fi
[ -n "$SHA256" ] || die "no published SHA-256 for ${ASSET}"
TGZ="$(mktemp)"
curl -fsSL -o "$TGZ" "https://github.com/actions/runner/releases/download/v${VERSION}/${ASSET}"
echo "${SHA256}  ${TGZ}" | sha256sum -c --quiet - || die "SHA-256 mismatch for ${ASSET}"
tar -xzf "$TGZ" -C "$DIR"
rm -f "$TGZ"
printf 'LANG=C.UTF-8\n' > "${DIR}/.env"
chown -R "$U:$U" "$DIR"
echo "    runner ${VERSION} (${ARCH}) in ${DIR}"

echo "== register ${NAME} (label ${LABEL}) with ${REPO_URL}"
# printf and export are shell builtins, so the token is in no argv.
printf '%s' "$TOKEN" | sudo -u "$U" bash -c \
  'export ACTIONS_RUNNER_INPUT_TOKEN="$(cat)"; cd "$1" && ./config.sh --unattended --url "$2" --name "$3" --labels "$4" --work _work' \
  _ "$DIR" "$REPO_URL" "$NAME" "$LABEL"
TOKEN=""
(cd "$DIR" && ./svc.sh install "$U" && ./svc.sh start)

echo "== runner services after"
systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print "   ", $1, $3, $4}' || true
echo
echo "Done: runner ${NAME} (label ${LABEL}) runs as ${U}."
echo "Check: gh api repos/${OWNER_REPO}/actions/runners --jq '.runners[] | [.name, .status] | @tsv'"
