#!/usr/bin/env bash
set -euo pipefail

# Publish SimpleClaw core + extensions to Google Artifact Registry.
#
# Usage:
#   scripts/publish-to-gar.sh                          # publish all
#   scripts/publish-to-gar.sh --core-only              # publish core only
#   scripts/publish-to-gar.sh --extensions-only        # publish extensions only
#   scripts/publish-to-gar.sh --dry-run                # show what would be published
#   scripts/publish-to-gar.sh --catalog                # also generate & upload catalog
#
# Environment:
#   GAR_REGION       - GAR region (default: us-central1)
#   GAR_PROJECT      - GCP project ID (required)
#   GAR_REPO         - GAR npm repository name (default: simpleclaw-npm)
#   GCS_CATALOG_URL  - GCS URL for catalog upload (default: gs://simpleclaw-marketplace/catalog.json)

GAR_REGION="${GAR_REGION:-us-central1}"
GAR_PROJECT="${GAR_PROJECT:?GAR_PROJECT is required}"
GAR_REPO="${GAR_REPO:-simpleclaw-npm}"
GCS_CATALOG_URL="${GCS_CATALOG_URL:-gs://simpleclaw-marketplace/catalog.json}"
GAR_REGISTRY="https://${GAR_REGION}-npm.pkg.dev/${GAR_PROJECT}/${GAR_REPO}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CORE_ONLY=false
EXTENSIONS_ONLY=false
DRY_RUN=false
UPDATE_CATALOG=false

for arg in "$@"; do
  case "$arg" in
    --core-only) CORE_ONLY=true ;;
    --extensions-only) EXTENSIONS_ONLY=true ;;
    --dry-run) DRY_RUN=true ;;
    --catalog) UPDATE_CATALOG=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

echo "Registry: ${GAR_REGISTRY}"
echo ""

# Authenticate npm with GAR
echo "Configuring npm auth for GAR..."
npx google-artifactregistry-auth 2>/dev/null || {
  # Fallback: use gcloud access token directly
  TOKEN=$(gcloud auth print-access-token 2>/dev/null || \
    curl -sH "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
  npm config set "//${GAR_REGION}-npm.pkg.dev/${GAR_PROJECT}/${GAR_REPO}/:_authToken" "${TOKEN}"
}

publish_package() {
  local dir="$1"
  local name
  name=$(node -e "console.log(require('${dir}/package.json').name)")
  local version
  version=$(node -e "console.log(require('${dir}/package.json').version)")
  local is_private
  is_private=$(node -e "console.log(require('${dir}/package.json').private ?? false)")

  if [ "$is_private" = "true" ]; then
    echo "  SKIP ${name}@${version} (private: true in package.json)"
    return
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "  DRY RUN: would publish ${name}@${version}"
    return
  fi

  echo "  Publishing ${name}@${version}..."
  (cd "$dir" && npm publish --registry "${GAR_REGISTRY}" --access public 2>&1) || {
    echo "  WARN: Failed to publish ${name}@${version} (may already exist)"
  }
}

# ── Core package ──────────────────────────────────────────────

if [ "$EXTENSIONS_ONLY" = "false" ]; then
  echo "=== Core Package ==="
  publish_package "$ROOT_DIR"
  echo ""
fi

# ── Extension packages ────────────────────────────────────────

if [ "$CORE_ONLY" = "false" ]; then
  echo "=== Extensions ==="
  for ext_dir in "$ROOT_DIR"/extensions/*/; do
    if [ ! -f "${ext_dir}package.json" ]; then
      continue
    fi
    publish_package "$ext_dir"
  done
  echo ""
fi

# ── Catalog generation ────────────────────────────────────────

if [ "$UPDATE_CATALOG" = "true" ]; then
  echo "=== Catalog ==="
  CATALOG_FILE=$(mktemp /tmp/catalog.XXXXXX.json)
  bun "$SCRIPT_DIR/generate-catalog.ts" --registry "$GAR_REGISTRY" --output "$CATALOG_FILE"

  if [ "$DRY_RUN" = "true" ]; then
    echo "  DRY RUN: would upload catalog to ${GCS_CATALOG_URL}"
    cat "$CATALOG_FILE"
  else
    echo "  Uploading catalog to ${GCS_CATALOG_URL}..."
    gsutil cp "$CATALOG_FILE" "$GCS_CATALOG_URL"
    echo "  Done."
  fi

  rm -f "$CATALOG_FILE"
fi

echo "Publish complete."
