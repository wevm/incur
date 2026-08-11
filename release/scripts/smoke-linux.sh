#!/usr/bin/env bash
set -euo pipefail

: "${BINARY_NAME:?}"
: "${BINARY_OUTPUT:?}"
: "${EXPECTED_VERSION:?}"
: "${RUNNER_TEMP:?}"

if [[ "$(uname -s)" != 'Linux' ]]; then
  printf 'This action requires a Linux runner, received %s.\n' "$(uname -s)" >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64 | arm64)
    glibc_target='linux-arm64-glibc'
    musl_target='linux-arm64-musl'
    ;;
  amd64 | x86_64)
    glibc_target='linux-x64-glibc-baseline'
    musl_target='linux-x64-musl-baseline'
    ;;
  *)
    printf 'Unsupported Linux runner architecture: %s.\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

temporary="$(mktemp -d "$RUNNER_TEMP/incur-release-smoke.XXXXXX")"
cleanup() {
  rm -rf "$temporary"
}
trap cleanup EXIT

extract() {
  local target="$1"
  local binary="$2"

  gzip -dc "$BINARY_OUTPUT/${BINARY_NAME}-${target}.gz" > "$binary"
  chmod 755 "$binary"
}

smoke_native() {
  local binary="$1"
  local actual_version

  "$binary" --help > /dev/null
  actual_version="$("$binary" --version)"
  if [[ "$actual_version" != "$EXPECTED_VERSION" ]]; then
    printf 'Expected version %s, received %s.\n' \
      "$EXPECTED_VERSION" "$actual_version" >&2
    exit 1
  fi
  if [[ -n "${SMOKE_COMMAND:-}" ]]; then "$binary" "$SMOKE_COMMAND"; fi
}

smoke_alpine() {
  local binary="$1"
  local command

  command="/smoke/$(basename "$binary")"
  docker run --rm \
    --env EXPECTED_VERSION \
    --env "SMOKE_COMMAND=${SMOKE_COMMAND:-}" \
    --volume "$temporary:/smoke:ro" \
    alpine:3.22 \
    sh -eu -c '
      apk add --no-cache libstdc++ libgcc > /dev/null
      command="$1"
      "$command" --help > /dev/null
      actual_version="$("$command" --version)"
      if [ "$actual_version" != "$EXPECTED_VERSION" ]; then
        printf "Expected version %s, received %s.\n" \
          "$EXPECTED_VERSION" "$actual_version" >&2
        exit 1
      fi
      if [ -n "$SMOKE_COMMAND" ]; then "$command" "$SMOKE_COMMAND"; fi
    ' sh "$command"
}

command -v docker > /dev/null 2>&1 || {
  printf '%s\n' 'Docker is required to smoke-test the musl binary.' >&2
  exit 1
}

glibc_binary="$temporary/${BINARY_NAME}-${glibc_target}"
musl_binary="$temporary/${BINARY_NAME}-${musl_target}"
extract "$glibc_target" "$glibc_binary"
extract "$musl_target" "$musl_binary"
smoke_native "$glibc_binary"
smoke_alpine "$musl_binary"
