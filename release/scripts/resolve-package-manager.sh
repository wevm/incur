#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?}"
: "${REQUESTED_PACKAGE_MANAGER:?}"

declared="$(node -p "require('./package.json').packageManager || ''")"
manager="$REQUESTED_PACKAGE_MANAGER"

if [[ "$manager" == 'auto' ]]; then
  manager="${declared%%@*}"
  if [[ -z "$manager" ]]; then
    managers=()
    [[ -f pnpm-lock.yaml ]] && managers+=(pnpm)
    [[ -f package-lock.json ]] && managers+=(npm)
    [[ -f bun.lock || -f bun.lockb ]] && managers+=(bun)
    if [[ "${#managers[@]}" -ne 1 ]]; then
      printf '%s\n' \
        'Could not infer one package manager. Set package_manager explicitly.' >&2
      exit 1
    fi
    manager="${managers[0]}"
  fi
fi

case "$manager" in
  npm | pnpm | bun) ;;
  *)
    printf 'Unsupported package manager: %s. Expected npm, pnpm, or bun.\n' \
      "$manager" >&2
    exit 1
    ;;
esac

pnpm_declared=false
if [[ "$manager" == 'pnpm' && "$declared" == pnpm@* ]]; then
  pnpm_declared=true
fi

{
  printf 'name=%s\n' "$manager"
  printf 'pnpm_declared=%s\n' "$pnpm_declared"
} >> "$GITHUB_OUTPUT"
