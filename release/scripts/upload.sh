#!/usr/bin/env bash
set -euo pipefail

: "${BINARY_NAME:?}"
: "${BINARY_OUTPUT:?}"
: "${EXPECTED_COMMIT:?}"
: "${EXPECTED_RELEASE_ID:?}"
: "${GH_TOKEN:?}"
: "${GITHUB_REPOSITORY:?}"
: "${RELEASE_TAG:?}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

release="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}")"

if [[ "$(jq -r '.id' <<< "$release")" != "$EXPECTED_RELEASE_ID" ]]; then
  fail 'The draft release was replaced after validation.'
fi
if [[ "$(jq -r '.tag_name' <<< "$release")" != "$RELEASE_TAG" ]]; then
  fail 'The release tag changed before upload.'
fi
if [[ "$(jq -r '.prerelease' <<< "$release")" != 'false' ]]; then
  fail 'The release became a prerelease before upload.'
fi
if [[ "$(jq -r '.draft' <<< "$release")" != 'true' ]]; then
  fail 'The release was published before every binary asset was ready.'
fi

gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${RELEASE_TAG}" > /dev/null
commit="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${RELEASE_TAG}" --jq '.sha')"
if [[ "$commit" != "$EXPECTED_COMMIT" ]]; then
  fail 'The release tag moved after validation.'
fi
if [[ "$(git rev-parse HEAD)" != "$EXPECTED_COMMIT" ]]; then
  fail 'The checked-out commit changed after validation.'
fi

assets=(
  "$BINARY_OUTPUT/${BINARY_NAME}-darwin-arm64.gz"
  "$BINARY_OUTPUT/${BINARY_NAME}-darwin-x64.gz"
  "$BINARY_OUTPUT/${BINARY_NAME}-linux-arm64-glibc.gz"
  "$BINARY_OUTPUT/${BINARY_NAME}-linux-arm64-musl.gz"
  "$BINARY_OUTPUT/${BINARY_NAME}-linux-x64-glibc-baseline.gz"
  "$BINARY_OUTPUT/${BINARY_NAME}-linux-x64-musl-baseline.gz"
  "$BINARY_OUTPUT/${BINARY_NAME}-windows-arm64.exe.gz"
  "$BINARY_OUTPUT/${BINARY_NAME}-windows-x64-baseline.exe.gz"
  "$BINARY_OUTPUT/SHA256SUMS"
  "$BINARY_OUTPUT/install.ps1"
  "$BINARY_OUTPUT/install.sh"
)

for file in "${assets[@]}"; do
  if [[ ! -f "$file" || ! -s "$file" || -L "$file" ]]; then
    fail "Release asset is not a regular file: ${file}."
  fi
  asset="$(basename "$file")"
  if jq -e --arg asset "$asset" \
    '.assets[]? | select(.name == $asset)' <<< "$release" > /dev/null; then
    fail "Release asset already exists: ${asset}."
  fi
done

gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY"
