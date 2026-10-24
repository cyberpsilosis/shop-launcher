#!/usr/bin/env bash
# Add the self-hosted GitHub Actions runner for cyberpsilosis/shop-launcher
# to Elijah's laptop (WSL Ubuntu), beside the runners already there. Same
# pattern as orb-shop's scripts/laptop-runner/add-orb-shop-runner.sh: its
# own Linux user, its own folder, its own label, started by systemd. The
# launcher needs no database, so unlike the orb's runner it makes none.
#
# Elijah's one command, in Windows PowerShell on the laptop, after pull
# request #2 is merged (README, "Add the runner"). It makes a one-hour
# registration token with gh and pipes it straight in, so the token is never
# shown, copied or saved. Before running anything it fetches this script
# from main; if main does not have it yet, it prints one STOP line naming
# the merge and changes nothing:
#
#   LINE: gh api -X POST repos/cyberpsilosis/shop-launcher/actions/runners/registration-token --jq .token | wsl -u root -- bash -c 'curl -fsLo /root/add-launcher-runner.sh https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/scripts/add-launcher-runner.sh || { curl -fsLo /dev/null https://raw.githubusercontent.com/cyberpsilosis/shop-launcher/main/README.md && echo STOP: scripts/add-launcher-runner.sh is not on main yet - merge pull request \#2, then paste this again. Nothing changed. || echo STOP: the laptop cannot reach raw.githubusercontent.com - check it is online, then paste this again. Nothing changed.; exit 1; } && bash /root/add-launcher-runner.sh'
#
# The line has no $, double quote or apostrophe inside its single quotes:
# PowerShell hands it to wsl inside double quotes, and WSL's own shell would
# expand a $ before bash -c saw it. The \# keeps # from starting a comment.
# It saves the script in /root (only root can write there), not /tmp, where
# another runner's user could plant or swap the file before root runs it.
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
# Every way it can fail ends in one line that starts with STOP: and says
# what was changed so far and what to do next. Refusals and missing tools
# are checked by hand; any other failing command (a download, config.sh,
# svc.sh) is caught by the ERR trap below.
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

# What exists so far, for the STOP line: empty means nothing changed.
UNDO=""
STEP="checking the machine"
die() {
  if [ -z "$UNDO" ]; then echo "STOP: $*; nothing changed" >&2
  else echo "STOP: $*; $UNDO" >&2; fi
  exit 1
}
# Any command that fails outside the hand-made checks (set -e) lands here.
trap 'die "$STEP failed (exit $?, line $LINENO)"' ERR

echo "== checks (nothing changed yet)"
[ "$(id -u)" -eq 0 ] || die "run it with sudo (or wsl -u root)"
for c in useradd chmod install getent; do
  command -v "$c" >/dev/null || die "$c is not installed"
done
if [ "$NO_REGISTER" != 1 ]; then
  for c in curl jq tar sha256sum systemctl sudo node npm; do
    command -v "$c" >/dev/null || die "$c is not installed"
  done
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "launch.yml needs Node 20 or newer, found $(node --version)"
fi
getent passwd "$U" >/dev/null && die "user $U already exists"
[ -e "$H" ] && die "$H already exists"
if compgen -G "${UNIT_DIR}/${UNIT_GLOB}" >/dev/null; then
  die "a shop-launcher runner service already exists in ${UNIT_DIR}"
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
    die "$f is already registered to ${OWNER_REPO}"
  fi
done < <(runner_files)
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported machine $(uname -m)" ;;
esac

TOKEN=""
if [ "$NO_REGISTER" != 1 ]; then
  if [ -t 0 ]; then
    read -rsp "Paste the shop-launcher registration token (it will not show), then press Enter: " TOKEN
    echo
    TOKEN="${TOKEN//[$'\r\n\t ']/}"
    [ -n "$TOKEN" ] || die "no token entered"
  else
    IFS= read -r TOKEN || true # piped in from gh; PowerShell adds \r
    TOKEN="${TOKEN//[$'\r\n\t ']/}"
    [ -n "$TOKEN" ] || die "no registration token came in from gh - in PowerShell run gh auth status (it must be logged in to an account that is admin on ${OWNER_REPO}), then paste the line again"
  fi
  # gh prints its error, or null, when the call fails; neither is a token.
  # The value itself is never printed.
  if [ "$TOKEN" = null ] || ! [[ "$TOKEN" =~ ^[A-Za-z0-9_.-]{20,200}$ ]]; then
    die "what came in from gh is not a runner registration token - in PowerShell run gh auth status (it must be logged in to an account that is admin on ${OWNER_REPO}), then paste the line again"
  fi
fi

echo "== runner services before"
systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print "   ", $1, $3, $4}' || true

echo "== user $U (own group, no password, no sudo)"
STEP="making the user $U"
UNDO="the user $U may exist now, so run wsl -u root -- userdel -r $U in PowerShell, then paste the line again"
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
STEP="downloading GitHub's runner"
UNDO="the user $U exists but no runner is registered, so run wsl -u root -- userdel -r $U in PowerShell, then paste the line again"
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
STEP="registering with GitHub (the token lasts one hour)"
# printf and export are shell builtins, so the token is in no argv.
printf '%s' "$TOKEN" | sudo -u "$U" bash -c \
  'export ACTIONS_RUNNER_INPUT_TOKEN="$(cat)"; cd "$1" && ./config.sh --unattended --url "$2" --name "$3" --labels "$4" --work _work' \
  _ "$DIR" "$REPO_URL" "$NAME" "$LABEL"
TOKEN=""
STEP="installing and starting the runner service"
UNDO="the runner is registered but not running, so send this line to the agent; to undo it yourself: remove ${NAME} under ${OWNER_REPO} Settings > Actions > Runners, then run wsl -u root -- bash -c 'cd $DIR; ./svc.sh uninstall; userdel -r $U' in PowerShell"
(cd "$DIR" && ./svc.sh install "$U" && ./svc.sh start)

trap - ERR
echo "== runner services after"
systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print "   ", $1, $3, $4}' || true
echo
echo "Done: runner ${NAME} (label ${LABEL}) runs as ${U}."
echo "Check: gh api repos/${OWNER_REPO}/actions/runners --jq '.runners[] | [.name, .status] | @tsv'"
