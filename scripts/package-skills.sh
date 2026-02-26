#!/usr/bin/env bash
set -euo pipefail

# Package skill directories as .tar.gz archives for the marketplace.
#
# Usage:
#   scripts/package-skills.sh                          # package all skills
#   scripts/package-skills.sh --upload                 # package + upload to GCS
#   scripts/package-skills.sh --skills-dir path        # custom skills dir
#   scripts/package-skills.sh --filter name            # package a specific skill
#
# Environment:
#   GCS_SKILLS_BUCKET  GCS bucket name (default: simpleclaw-marketplace)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="${ROOT_DIR}/skills"
GCS_BUCKET="${GCS_SKILLS_BUCKET:-simpleclaw-marketplace}"
OUTPUT_DIR="${ROOT_DIR}/dist/skills"
UPLOAD=false
FILTER=""

# ── Parse args ────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upload)
      UPLOAD=true
      shift
      ;;
    --skills-dir)
      SKILLS_DIR="$2"
      shift 2
      ;;
    --filter)
      FILTER="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --gcs-bucket)
      GCS_BUCKET="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ── Resolve version from root package.json ────────────────────

VERSION=$(node -p "require('${ROOT_DIR}/package.json').version")
echo "Packaging skills v${VERSION} from ${SKILLS_DIR}"

# ── Create output directory ───────────────────────────────────

mkdir -p "$OUTPUT_DIR"

# ── Package each skill ────────────────────────────────────────

count=0
for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name="$(basename "$skill_dir")"

  # Skip hidden directories
  if [[ "$skill_name" == .* ]]; then
    continue
  fi

  # Skip if no SKILL.md
  if [[ ! -f "${skill_dir}SKILL.md" ]]; then
    continue
  fi

  # Apply filter
  if [[ -n "$FILTER" && "$skill_name" != "$FILTER" ]]; then
    continue
  fi

  archive_name="${skill_name}-${VERSION}.tar.gz"
  archive_path="${OUTPUT_DIR}/${archive_name}"

  # Create tar.gz with the skill directory as the root entry
  tar czf "$archive_path" -C "$SKILLS_DIR" "$skill_name"

  echo "  Packaged: ${archive_name}"
  count=$((count + 1))

  # Upload to GCS if requested
  if [[ "$UPLOAD" == "true" ]]; then
    gsutil -q cp "$archive_path" "gs://${GCS_BUCKET}/skills/${archive_name}"
    echo "  Uploaded: gs://${GCS_BUCKET}/skills/${archive_name}"
  fi
done

echo ""
echo "Packaged ${count} skill(s) to ${OUTPUT_DIR}"

if [[ "$UPLOAD" == "true" ]]; then
  echo "Uploaded to gs://${GCS_BUCKET}/skills/"
fi
