#!/bin/sh
# Start the sidecar from a fixed bun path. PATH is not consulted.
set -eu

PLUGIN_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

is_trusted_system_executable() {
  path=$1
  [ -f "$path" ] || return 1
  [ -x "$path" ] || return 1
  owner=$(stat -c '%u' "$path")
  mode=$(stat -c '%a' "$path")
  [ "$owner" = 0 ] || return 1
  case $mode in
    ???[0246][0246]) return 1 ;;
  esac
  return 0
}

is_trusted_user_executable() {
  path=$1
  uid=$2
  [ -f "$path" ] || return 1
  [ -x "$path" ] || return 1
  owner=$(stat -c '%u' "$path")
  mode=$(stat -c '%a' "$path")
  [ "$owner" = "$uid" ] || return 1
  case $mode in
    ???[0246][0246]) return 1 ;;
  esac
  return 0
}

BUN=
for candidate in \
  /usr/bin/bun \
  "${HOME}/.bun/bin/bun" \
  "${HOME}/.local/share/mise/installs/bun/latest/bin/bun"; do
  if is_trusted_system_executable "$candidate" 2>/dev/null \
    || is_trusted_user_executable "$candidate" "$(id -u)" 2>/dev/null; then
    BUN=$candidate
    break
  fi
done

if [ -z "${BUN:-}" ]; then
  echo "muqun: bun not found in a trusted location" >&2
  exit 127
fi

exec "$BUN" run "$PLUGIN_DIR/backend/interface/main.ts"
