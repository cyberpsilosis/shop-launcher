#!/usr/bin/env bash
# The one place a launch's generated secrets touch disk.
#   create: makes a mode-600 file under $RUNNER_TEMP and prints its path
#   delete: removes the file named in $1 (or $LAUNCH_SECRETS_FILE)
#   clear:  empties $RUNNER_TEMP, because a self-hosted runner keeps its disk
set +x
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?RUNNER_TEMP is not set}"
case "${1:-}" in
  create)
    f=$(mktemp "$RUNNER_TEMP/launch-secrets.XXXXXXXX")
    chmod 600 "$f"
    printf '%s\n' "$f"
    ;;
  delete)
    f="${2:-${LAUNCH_SECRETS_FILE:-}}"
    if [ -n "$f" ] && [ -e "$f" ]; then
      case "$f" in "$RUNNER_TEMP"/launch-secrets.*) ;; *) echo "refusing to delete a file outside \$RUNNER_TEMP" >&2; exit 1 ;; esac
      # Overwrite before unlinking; shred if the machine has it.
      if command -v shred >/dev/null 2>&1; then shred -u "$f"; else : > "$f"; rm -f "$f"; fi
    fi
    echo "secrets file removed"
    ;;
  clear)
    case "$RUNNER_TEMP" in ""|"/"|"$HOME") echo "refusing to clear $RUNNER_TEMP" >&2; exit 1 ;; esac
    find "$RUNNER_TEMP" -mindepth 1 -delete
    echo "RUNNER_TEMP cleared"
    ;;
  *)
    echo "usage: secrets-file.sh create | delete [file] | clear" >&2
    exit 2
    ;;
esac
