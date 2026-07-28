#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?}"
: "${GITHUB_OUTPUT:?}"
: "${GITHUB_REPOSITORY:?}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

api_exists() {
  local response
  if response="$(gh api "$1" 2>&1)"; then
    return 0
  fi
  if [[ "$response" == *'HTTP 404'* ]]; then
    return 1
  fi
  printf '%s\n' "$response" >&2
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

source_commit="$(git rev-parse HEAD)"
if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  fail 'The checked-out source has an invalid commit.'
fi
if [[ "${SOURCE_REF:-}" == refs/pull/* ]]; then
  fail 'Run binary releases from a trusted push or manual workflow, not a pull request.'
fi

tag_exists=false
if api_exists "repos/${GITHUB_REPOSITORY}/git/ref/tags/${release_tag}"; then
  tag_exists=true
  commit="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${release_tag}" --jq '.sha')"
elif [[ -n "${REQUESTED_RELEASE_TAG:-}" ]]; then
  fail "Release tag ${release_tag} does not exist."
else
  commit="$source_commit"
fi

if api_exists "repos/${GITHUB_REPOSITORY}/releases/tags/${release_tag}"; then
  release="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${release_tag}")"
else
  create_release() {
    gh release create "$release_tag" \
      --draft \
      --generate-notes \
      --repo "$GITHUB_REPOSITORY" \
      --target "$source_commit" \
      --title "$release_tag" \
      "$@" > /dev/null
  }
  if [[ "$tag_exists" == 'true' ]]; then
    create_release --verify-tag
  else
    create_release
  fi
  release="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${release_tag}")"
fi

if [[ "$(jq -r '.tag_name' <<< "$release")" != "$release_tag" ]]; then
  fail 'The release does not match the requested tag.'
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
if [[ "$tag_exists" == 'false' && "$commit" != "$source_commit" ]]; then
  fail "Release tag ${release_tag} does not point to the checked-out commit."
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
