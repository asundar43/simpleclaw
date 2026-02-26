#!/usr/bin/env bash
set -euo pipefail

cd /repo

export SIMPLECLAW_STATE_DIR="/tmp/simpleclaw-test"
export SIMPLECLAW_CONFIG_PATH="${SIMPLECLAW_STATE_DIR}/simpleclaw.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${SIMPLECLAW_STATE_DIR}/credentials"
mkdir -p "${SIMPLECLAW_STATE_DIR}/agents/main/sessions"
echo '{}' >"${SIMPLECLAW_CONFIG_PATH}"
echo 'creds' >"${SIMPLECLAW_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${SIMPLECLAW_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm simpleclaw reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${SIMPLECLAW_CONFIG_PATH}"
test ! -d "${SIMPLECLAW_STATE_DIR}/credentials"
test ! -d "${SIMPLECLAW_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${SIMPLECLAW_STATE_DIR}/credentials"
echo '{}' >"${SIMPLECLAW_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm simpleclaw uninstall --state --yes --non-interactive

test ! -d "${SIMPLECLAW_STATE_DIR}"

echo "OK"
