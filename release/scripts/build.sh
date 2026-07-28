#!/usr/bin/env bash
set -euo pipefail

: "${BINARY_ENTRY:?}"
: "${BINARY_OUTPUT:?}"
: "${GITHUB_OUTPUT:?}"
: "${GITHUB_REPOSITORY:?}"
: "${PACKAGE_MANAGER:?}"
: "${VERSION:?}"

case "$PACKAGE_MANAGER" in
  pnpm) incur=(pnpm exec incur) ;;
  npm) incur=(npm exec --no -- incur) ;;
  bun) incur=(bunx --no-install incur) ;;
  *)
    printf 'Unsupported package manager: %s.\n' "$PACKAGE_MANAGER" >&2
    exit 1
    ;;
esac

args=(
  --json
  build
  "$BINARY_ENTRY"
  --installer
  --output "$BINARY_OUTPUT"
  --repository "$GITHUB_REPOSITORY"
  --version "$VERSION"
)
if [[ -n "${BINARY_NAME:-}" ]]; then args+=(--name "$BINARY_NAME"); fi

result="$("${incur[@]}" "${args[@]}")"
name="$(jq -er '.name | select(type == "string")' <<< "$result")"
if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'Invalid binary name returned by Incur.\n' >&2
  exit 1
fi
version="$(jq -er '.version | select(type == "string")' <<< "$result")"
if [[ "$version" != "$VERSION" ]]; then
  printf 'Expected build version %s, received %s.\n' "$VERSION" "$version" >&2
  exit 1
fi

printf 'Built %s %s.\n' "$name" "$version"
printf 'name=%s\n' "$name" >> "$GITHUB_OUTPUT"
