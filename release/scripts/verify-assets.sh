#!/usr/bin/env bash
set -euo pipefail

: "${BINARY_NAME:?}"
: "${BINARY_OUTPUT:?}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [[ ! -d "$BINARY_OUTPUT" || -L "$BINARY_OUTPUT" ]]; then
  fail "Binary output is not a regular directory: ${BINARY_OUTPUT}."
fi

expected=(
  "${BINARY_NAME}-darwin-arm64.gz"
  "${BINARY_NAME}-darwin-x64.gz"
  "${BINARY_NAME}-linux-arm64-glibc.gz"
  "${BINARY_NAME}-linux-arm64-musl.gz"
  "${BINARY_NAME}-linux-x64-glibc-baseline.gz"
  "${BINARY_NAME}-linux-x64-musl-baseline.gz"
  "${BINARY_NAME}-windows-arm64.exe.gz"
  "${BINARY_NAME}-windows-x64-baseline.exe.gz"
)

for asset in "${expected[@]}" SHA256SUMS install.ps1 install.sh; do
  file="$BINARY_OUTPUT/$asset"
  if [[ ! -f "$file" || ! -s "$file" || -L "$file" ]]; then
    fail "Release asset is not a regular file: ${file}."
  fi
done

expected_assets="$(mktemp)"
actual_assets="$(mktemp)"
checksum_assets="$(mktemp)"
cleanup() {
  rm -f "$expected_assets" "$actual_assets" "$checksum_assets"
}
trap cleanup EXIT

printf '%s\n' "${expected[@]}" | LC_ALL=C sort > "$expected_assets"
find "$BINARY_OUTPUT" -mindepth 1 -maxdepth 1 -name '*.gz' -printf '%f\n' |
  LC_ALL=C sort > "$actual_assets"
awk '{ name = $2; sub(/^\*/, "", name); print name }' "$BINARY_OUTPUT/SHA256SUMS" |
  LC_ALL=C sort > "$checksum_assets"

diff -u "$expected_assets" "$actual_assets"
diff -u "$expected_assets" "$checksum_assets"

(
  cd "$BINARY_OUTPUT"
  sha256sum --check --strict SHA256SUMS
  for asset in "${expected[@]}"; do gzip -t "$asset"; done
  sh -n install.sh

  command -v pwsh > /dev/null 2>&1 || {
    fail 'PowerShell is required to validate install.ps1.'
  }
  INSTALLER="$PWD/install.ps1" pwsh \
    -NoLogo \
    -NoProfile \
    -NonInteractive \
    -Command - <<'POWERSHELL'
$errors = $null
$tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  $env:INSTALLER,
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -gt 0) {
  $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }
  exit 1
}
POWERSHELL
)
