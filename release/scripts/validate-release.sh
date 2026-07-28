#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?}"
: "${GITHUB_OUTPUT:?}"
: "${GITHUB_REPOSITORY:?}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

version="$(node -p "require('./package.json').version")"
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail 'package.json must contain a stable semantic version.'
fi

expected_tag="v${version}"
release_tag="${REQUESTED_RELEASE_TAG:-$expected_tag}"
if [[ ! "$release_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "Invalid stable release tag: ${release_tag}."
fi
if [[ "$release_tag" != "$expected_tag" ]]; then
  fail "Expected release tag ${expected_tag}, received ${release_tag}."
fi

visibility="$(gh api "repos/${GITHUB_REPOSITORY}" --jq '.visibility')"
if [[ "$visibility" != 'public' ]]; then
  fail 'Binary.github supports public GitHub repositories only.'
fi

release="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${release_tag}")"
if [[ "$(jq -r '.tag_name' <<< "$release")" != "$release_tag" ]]; then
  fail 'The release does not match the requested tag.'
fi
if [[ "$(jq -r '.prerelease' <<< "$release")" != 'false' ]]; then
  fail 'The release must not be a prerelease.'
fi
if [[ "$(jq -r '.draft' <<< "$release")" != 'true' ]]; then
  fail 'The release must remain a draft until every binary asset is uploaded.'
fi

gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${release_tag}" > /dev/null
commit="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${release_tag}" --jq '.sha')"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail 'The release tag has an invalid commit.'
fi

release_id="$(jq -r '.id' <<< "$release")"
if [[ ! "$release_id" =~ ^[1-9][0-9]*$ ]]; then
  fail 'The release has an invalid identifier.'
fi

{
  printf 'commit=%s\n' "$commit"
  printf 'release_id=%s\n' "$release_id"
  printf 'release_tag=%s\n' "$release_tag"
  printf 'version=%s\n' "$version"
} >> "$GITHUB_OUTPUT"
