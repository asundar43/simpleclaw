#!/usr/bin/env bash
set -euo pipefail

# Publish SimpleClaw core + extensions to Google Artifact Registry.
#
# Usage:
#   scripts/publish-to-gar.sh                          # publish all (tagged "latest")
#   scripts/publish-to-gar.sh --tag beta               # publish with beta dist-tag
#   scripts/publish-to-gar.sh --tag dev                 # publish dev snapshot from current HEAD
#   scripts/publish-to-gar.sh --core-only              # publish core only
#   scripts/publish-to-gar.sh --extensions-only        # publish extensions only
#   scripts/publish-to-gar.sh --dry-run                # show what would be published
#   scripts/publish-to-gar.sh --catalog                # also generate & upload catalog
#
# Release channels:
#   latest  - stable release (default), tagged releases only
#   beta    - prerelease (e.g. 2026.2.25-beta.1)
#   dev     - auto-versioned snapshot from current HEAD (YYYY.M.D-dev.HHMMSS)
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
DIST_TAG="latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only) CORE_ONLY=true; shift ;;
    --extensions-only) EXTENSIONS_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --catalog) UPDATE_CATALOG=true; shift ;;
    --tag) DIST_TAG="${2:?--tag requires a value}"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "Registry: ${GAR_REGISTRY}"
echo "Tag:      ${DIST_TAG}"
echo ""

# ── Auth ─────────────────────────────────────────────────────

echo "Configuring npm auth for GAR..."
TOKEN=""
npx google-artifactregistry-auth 2>/dev/null || {
  TOKEN=$(gcloud auth print-access-token 2>/dev/null || \
    curl -sH "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
  npm config set "//${GAR_REGION}-npm.pkg.dev/${GAR_PROJECT}/${GAR_REPO}/:_authToken" "${TOKEN}"
}

# Ensure token is available for dist-tag commands
if [ -z "$TOKEN" ]; then
  TOKEN=$(gcloud auth print-access-token 2>/dev/null || true)
fi

NPM_AUTH_ARG=""
if [ -n "$TOKEN" ]; then
  NPM_AUTH_ARG="//${GAR_REGION}-npm.pkg.dev/${GAR_PROJECT}/${GAR_REPO}/:_authToken=${TOKEN}"
fi

# ── Dev version stamping ─────────────────────────────────────

DEV_VERSION=""

if [ "$DIST_TAG" = "dev" ]; then
  BASE_VERSION=$(node -e "console.log(require('${ROOT_DIR}/package.json').version)")
  TIMESTAMP=$(date -u +%H%M%S)
  SHORT_SHA=$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "000000")
  DEV_VERSION="${BASE_VERSION}-dev.${TIMESTAMP}+${SHORT_SHA}"
  echo "Dev version: ${DEV_VERSION}"
  echo ""
fi

# ── Publish helpers ──────────────────────────────────────────

PUBLISHED_PACKAGES=()

publish_package() {
  local dir="$1"
  local name
  name=$(node -e "console.log(require('${dir}/package.json').name)")
  local version
  version=$(node -e "console.log(require('${dir}/package.json').version)")
  local is_private
  is_private=$(node -e "console.log(require('${dir}/package.json').private ?? false)")

  if [ "$is_private" = "true" ]; then
    echo "  SKIP ${name} (private: true)"
    return
  fi

  # For dev builds, temporarily stamp the version in package.json
  local original_version="$version"
  if [ -n "$DEV_VERSION" ]; then
    version="$DEV_VERSION"
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('${dir}/package.json', 'utf-8'));
      p.version = '${DEV_VERSION}';
      fs.writeFileSync('${dir}/package.json', JSON.stringify(p, null, 2) + '\n');
    "
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "  DRY RUN: would publish ${name}@${version} (tag: ${DIST_TAG})"
    # Restore version if we stamped it
    if [ -n "$DEV_VERSION" ]; then
      node -e "
        const fs = require('fs');
        const p = JSON.parse(fs.readFileSync('${dir}/package.json', 'utf-8'));
        p.version = '${original_version}';
        fs.writeFileSync('${dir}/package.json', JSON.stringify(p, null, 2) + '\n');
      "
    fi
    return
  fi

  echo "  Publishing ${name}@${version}..."
  if (cd "$dir" && npm publish --registry "${GAR_REGISTRY}" --tag "${DIST_TAG}" --access public 2>&1); then
    PUBLISHED_PACKAGES+=("${name}@${version}")
  else
    echo "  WARN: Failed to publish ${name}@${version} (may already exist)"
    PUBLISHED_PACKAGES+=("${name}@${version}")
  fi

  # Restore original version after dev publish
  if [ -n "$DEV_VERSION" ]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('${dir}/package.json', 'utf-8'));
      p.version = '${original_version}';
      fs.writeFileSync('${dir}/package.json', JSON.stringify(p, null, 2) + '\n');
    "
  fi
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

# ── Dist-tag management ──────────────────────────────────────

if [ "$DRY_RUN" = "false" ] && [ "${#PUBLISHED_PACKAGES[@]}" -gt 0 ] && [ -n "$NPM_AUTH_ARG" ]; then
  echo "=== Dist-tags (${DIST_TAG}) ==="
  for pkg_version in "${PUBLISHED_PACKAGES[@]}"; do
    name="${pkg_version%@*}"
    version="${pkg_version##*@}"
    echo "  Tagging ${name}@${version} as ${DIST_TAG}..."
    npm dist-tag add "${name}@${version}" "${DIST_TAG}" \
      --registry "${GAR_REGISTRY}" --"${NPM_AUTH_ARG}" 2>&1 || {
      echo "  WARN: Failed to tag ${name}@${version} as ${DIST_TAG}"
    }
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
