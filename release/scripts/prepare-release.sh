#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?}"
: "${GITHUB_OUTPUT:?}"
: "${GITHUB_REPOSITORY:?}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

package_name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"
if [[ -z "$package_name" || "$package_name" == 'undefined' ]]; then
  fail 'package.json must contain a package name.'
fi
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail 'package.json must contain a stable semantic version.'
fi

visibility="$(gh api "repos/${GITHUB_REPOSITORY}" --jq '.visibility')"
if [[ "$visibility" != 'public' ]]; then
  fail 'Binary.github supports public GitHub repositories only.'
fi

if [[ "${SOURCE_REF:-}" == refs/pull/* ]]; then
  fail 'Run binary releases from a trusted push or manual workflow, not a pull request.'
fi

if [[ -n "${REQUESTED_RELEASE_TAG:-}" ]]; then
  endpoint="repos/${GITHUB_REPOSITORY}/releases/tags/${REQUESTED_RELEASE_TAG}"
else
  endpoint="repos/${GITHUB_REPOSITORY}/releases/latest"
fi
release="$(gh api "$endpoint")"
release_tag="$(jq -er '.tag_name | select(type == "string" and length > 0)' <<< "$release")"

if [[ -n "${REQUESTED_RELEASE_TAG:-}" && "$release_tag" != "$REQUESTED_RELEASE_TAG" ]]; then
  fail 'The release does not match the requested tag.'
fi
if [[ "$release_tag" != "$version" &&
  "$release_tag" != "v${version}" &&
  "$release_tag" != "V${version}" &&
  "$release_tag" != "${package_name}@${version}" ]]; then
  fail "Release tag ${release_tag} does not identify ${package_name} ${version}."
fi
if [[ "$(jq -r '.prerelease' <<< "$release")" != 'false' ]]; then
  fail 'The release must not be a prerelease.'
fi
draft="$(jq -r '.draft' <<< "$release")"
if [[ "$draft" != 'true' && "$draft" != 'false' ]]; then
  fail 'The release has an invalid draft state.'
fi
if [[ "$(jq -r '.immutable // false' <<< "$release")" == 'true' ]]; then
  fail 'The published release is immutable and cannot accept binary assets.'
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
