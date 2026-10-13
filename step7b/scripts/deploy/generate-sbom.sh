#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
if command -v syft >/dev/null 2>&1; then
  syft dir:. -o cyclonedx-json=artifacts/sbom.cyclonedx.json
else
  echo 'syft is required for local SBOM generation; CI installs it through the pinned action.' >&2
  exit 1
fi
