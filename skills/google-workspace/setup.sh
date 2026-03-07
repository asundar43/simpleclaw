#!/usr/bin/env bash
# setup.sh — Configures gws (Google Workspace CLI) with OAuth tokens from the
# SimpleClaw Marketplace.
#
# Called by the AI agent before running gwsc commands. Installs the gws CLI if
# needed, verifies the marketplace connection, and creates a gwsc wrapper script
# that auto-fetches tokens from the marketplace API.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Ensure gws CLI is available.
if ! command -v gws &>/dev/null; then
  ARCH=$(uname -m); OS=$(uname -s | tr 'A-Z' 'a-z')
  case "$ARCH" in x86_64) ARCH=amd64;; aarch64) ARCH=arm64;; esac
  BUNDLED="${SCRIPT_DIR}/bin/gws-${OS}-${ARCH}"
  if [ -f "$BUNDLED" ]; then
    chmod +x "$BUNDLED"
    if cp "$BUNDLED" /usr/local/bin/gws 2>/dev/null; then
      echo "[gws-setup] Installed bundled gws binary to /usr/local/bin/gws."
    else
      mkdir -p "$HOME/.local/bin"
      cp "$BUNDLED" "$HOME/.local/bin/gws"
      export PATH="$HOME/.local/bin:$PATH"
      echo "[gws-setup] Installed bundled gws binary to ~/.local/bin/gws."
    fi
  else
    echo "[gws-setup] Error: gws binary not found and no bundled binary for ${OS}/${ARCH}."
    echo "           Install gws (https://github.com/googleworkspace/cli) or place binary at ${BUNDLED}."
    exit 1
  fi
fi

# 2. Ensure Google is connected via the setup-auth framework.
SETUP_AUTH_LIB="${SCRIPT_DIR}/../setup-auth-lib.sh"
if [ ! -f "$SETUP_AUTH_LIB" ]; then
  SETUP_AUTH_LIB="${HOME}/.openclaw/lib/setup-auth-lib.sh"
fi
if [ ! -f "$SETUP_AUTH_LIB" ]; then
  echo "[gws-setup] Error: setup-auth-lib.sh not found."
  echo "           Expected at ${SCRIPT_DIR}/../setup-auth-lib.sh"
  exit 1
fi

# shellcheck source=../setup-auth-lib.sh
source "$SETUP_AUTH_LIB"

if ! ensure_google_connection; then
  exit 1
fi

# 3. Create gwsc wrapper script that manages a persistent credentials file.
#    On first run the wrapper fetches full OAuth credentials from the marketplace
#    API and writes an authorized_user JSON file. gws reads this file and handles
#    its own token refresh — critical for long-running commands like gmail +watch.
WRAPPER_DIR="$HOME/.local/bin"
CREDS_DIR="$HOME/.config/gwsc"
mkdir -p "$WRAPPER_DIR" "$CREDS_DIR"
chmod 700 "$CREDS_DIR"
WRAPPER_PATH="${WRAPPER_DIR}/gwsc"

cat > "$WRAPPER_PATH" <<'WRAPPER_EOF'
#!/usr/bin/env bash
# gwsc — Google Workspace CLI wrapper with SimpleClaw marketplace auth.
# Manages a persistent authorized_user credentials file so gws can handle its
# own token refresh. This enables long-running commands (watch, streaming, etc.).
set -euo pipefail

_MARKETPLACE_API="${SIMPLECLAW_MARKETPLACE_API:-https://simpleclaw-marketplace-625948851089.us-central1.run.app}"
_TOKEN="${SIMPLECLAW_AUTH_TOKEN:-}"
_GATEWAY_TOKEN="${JARVIS_GATEWAY_TOKEN:-}"
_GATEWAY_USER_ID="${JARVIS_USER_ID:-}"
_CREDS_DIR="${HOME}/.config/gwsc"
_CREDS_FILE="${_CREDS_DIR}/credentials.json"
_MAX_AGE=604800  # 7 days in seconds

# Build auth headers for marketplace API calls.
_build_auth_args() {
  _AUTH_ARGS=()
  if [ -n "$_TOKEN" ]; then
    _AUTH_ARGS=(-H "Authorization: Bearer ${_TOKEN}")
  elif [ -n "$_GATEWAY_TOKEN" ] && [ -n "$_GATEWAY_USER_ID" ]; then
    _AUTH_ARGS=(-H "X-Gateway-Token: ${_GATEWAY_TOKEN}" -H "X-User-Id: ${_GATEWAY_USER_ID}")
  else
    echo "[gwsc] Error: No SIMPLECLAW_AUTH_TOKEN or gateway credentials set." >&2
    echo "[gwsc] Run: bash ~/.openclaw/skills/google-workspace/setup.sh" >&2
    exit 1
  fi
}

# Fetch full credentials from marketplace and write authorized_user JSON file.
_fetch_credentials() {
  _build_auth_args

  local RESPONSE
  RESPONSE=$(curl -sf "${_MARKETPLACE_API}/api/connect/google/credentials" \
    -X POST \
    "${_AUTH_ARGS[@]}" 2>/dev/null) || {
    echo "[gwsc] Error: Failed to fetch credentials from marketplace API." >&2
    echo "[gwsc] Re-run: bash ~/.openclaw/skills/google-workspace/setup.sh" >&2
    return 1
  }

  # Parse response fields.
  local CLIENT_ID CLIENT_SECRET REFRESH_TOKEN EMAIL MISSING
  CLIENT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])" 2>/dev/null) || {
    echo "[gwsc] Error: Could not parse client_id from API response." >&2; return 1
  }
  CLIENT_SECRET=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_secret'])" 2>/dev/null) || {
    echo "[gwsc] Error: Could not parse client_secret from API response." >&2; return 1
  }
  REFRESH_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['refresh_token'])" 2>/dev/null) || {
    echo "[gwsc] Error: Could not parse refresh_token from API response." >&2; return 1
  }
  EMAIL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('email',''))" 2>/dev/null || true)

  # Warn about missing scopes (non-fatal).
  MISSING=$(echo "$RESPONSE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
m=d.get('missing_scopes',[])
if m: print(','.join(m))
" 2>/dev/null || true)
  if [ -n "$MISSING" ]; then
    echo "[gwsc] WARNING: Some Google scopes were not granted: ${MISSING}" >&2
    echo "[gwsc] Some services may not work. Disconnect and reconnect Google, granting ALL permissions." >&2
  fi

  # Write authorized_user credentials file (atomic write).
  mkdir -p "$_CREDS_DIR"
  python3 -c "
import json, sys
creds = {
    'type': 'authorized_user',
    'client_id': sys.argv[1],
    'client_secret': sys.argv[2],
    'refresh_token': sys.argv[3]
}
with open(sys.argv[4], 'w') as f:
    json.dump(creds, f, indent=2)
" "$CLIENT_ID" "$CLIENT_SECRET" "$REFRESH_TOKEN" "${_CREDS_FILE}.tmp" || {
    echo "[gwsc] Error: Failed to write credentials file." >&2; return 1
  }
  mv "${_CREDS_FILE}.tmp" "$_CREDS_FILE"
  chmod 600 "$_CREDS_FILE"
  chmod 700 "$_CREDS_DIR"

  if [ -n "$EMAIL" ]; then
    echo "[gwsc] Credentials configured for ${EMAIL}" >&2
  fi
  return 0
}

# Get file age in seconds (cross-platform: macOS stat -f, Linux stat -c).
_file_age() {
  local mtime
  mtime=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0)
  echo $(( $(date +%s) - mtime ))
}

# Handle --refresh-credentials flag.
if [ "${1:-}" = "--refresh-credentials" ]; then
  echo "[gwsc] Refreshing credentials from marketplace..." >&2
  rm -f "$_CREDS_FILE"
  _fetch_credentials || exit 1
  echo "[gwsc] Done." >&2
  exit 0
fi

# Ensure credentials file exists.
if [ ! -f "$_CREDS_FILE" ]; then
  echo "[gwsc] First run — fetching credentials from marketplace..." >&2
  _fetch_credentials || exit 1
fi

# Auto-refresh if credentials are older than 7 days.
if [ -f "$_CREDS_FILE" ] && [ "$(_file_age "$_CREDS_FILE")" -gt "$_MAX_AGE" ]; then
  echo "[gwsc] Credentials older than 7 days, refreshing..." >&2
  _fetch_credentials || echo "[gwsc] Warning: refresh failed, using existing credentials." >&2
fi

# Invoke gws with the persistent credentials file.
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE="$_CREDS_FILE"
exec gws "$@"
WRAPPER_EOF

chmod +x "$WRAPPER_PATH"

# Ensure ~/.local/bin is on PATH.
case ":$PATH:" in
  *":${WRAPPER_DIR}:"*) ;;
  *) export PATH="${WRAPPER_DIR}:$PATH" ;;
esac

echo "[gws-setup] Ready. Use 'gwsc' for all Google Workspace commands."
