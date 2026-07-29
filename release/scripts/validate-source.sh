#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_COMMIT:?}"
: "${EXPECTED_RELEASE_TAG:?}"
: "${EXPECTED_VERSION:?}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [[ "$(git rev-parse HEAD)" != "$EXPECTED_COMMIT" ]]; then
  fail 'The checked-out commit does not match the validated release tag.'
fi

version="$(node -p "require('./package.json').version")"
if [[ "$version" != "$EXPECTED_VERSION" ]]; then
  fail 'package.json changed between release validation and checkout.'
fi
package_name="$(node -p "require('./package.json').name")"
if [[ "$EXPECTED_RELEASE_TAG" != "$version" &&
  "$EXPECTED_RELEASE_TAG" != "v${version}" &&
  "$EXPECTED_RELEASE_TAG" != "V${version}" &&
  "$EXPECTED_RELEASE_TAG" != "${package_name}@${version}" ]]; then
  fail 'The checked-out package version does not match the release tag.'
fi
