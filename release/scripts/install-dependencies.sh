#!/usr/bin/env bash
set -euo pipefail

: "${PACKAGE_MANAGER:?}"

case "$PACKAGE_MANAGER" in
  pnpm) pnpm install --frozen-lockfile ;;
  npm) npm ci ;;
  bun) bun install --frozen-lockfile ;;
  *)
    printf 'Unsupported package manager: %s.\n' "$PACKAGE_MANAGER" >&2
    exit 1
    ;;
esac
