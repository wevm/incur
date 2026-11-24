#!/bin/sh
# Runs the API, README, and differential tests under kcov and fails unless every line of
# src/ that has code runs. Differential cases with a `bin` start child processes; the
# differential binary runs each under its own kcov, and the reports are merged.
#
# Usage (from `zig build coverage`): coverage.sh <src dir> <api> <readme> <differential>
# Reports go to zig-out/kcov; zig-out/kcov/merged/index.html is the browsable report.
set -eu

src=$(cd "$1" && pwd)
api=$2
readme=$3
differential=$4
kcov=$(command -v kcov) || { echo "coverage: kcov is not installed" >&2; exit 1; }
out=$(pwd)/zig-out/kcov
rm -rf "$out"
mkdir -p "$out"

"$kcov" --include-path="$src" "$out/$(basename "$api")" "$api" > /dev/null
# README examples run in child processes, each under its own kcov.
INCUR_KCOV="$out" INCUR_KCOV_BIN="$kcov" INCUR_KCOV_INCLUDE="$src" "$readme" > /dev/null
# A traced process cannot start another tracer, so the in-process cases run under kcov and the
# `bin` cases run untraced, each child under its own kcov.
INCUR_DIFFERENTIAL_CASES=in-process "$kcov" --include-path="$src" "$out/differential" "$differential"
INCUR_DIFFERENTIAL_CASES=bin INCUR_KCOV="$out" INCUR_KCOV_BIN="$kcov" INCUR_KCOV_INCLUDE="$src" "$differential"

"$kcov" --merge "$out/merged" "$out"/*/ > /dev/null
report="$out/merged/kcov-merged/cobertura.xml"

# Lists `file:line` for every instrumented line with no hits.
uncovered=$(awk '
    /<class / { match($0, /filename="[^"]*"/); file = substr($0, RSTART + 10, RLENGTH - 11) }
    /<line / && /hits="0"/ { match($0, /number="[0-9]+"/); print file ":" substr($0, RSTART + 8, RLENGTH - 9) }
' "$report")

# Functions with no instrumented lines were never compiled, so no test references them. Only
# functions evaluated at compile time (`derive.zig` schema derivation, generic type
# constructors, and generic functions, whose instances kcov does not attribute to the signature)
# may be missing.
instrumented=$(awk '
    /<class / { match($0, /filename="[^"]*"/); file = substr($0, RSTART + 10, RLENGTH - 11); n = split(file, parts, "/"); file = parts[n] }
    /<line / { match($0, /number="[0-9]+"/); print file ":" substr($0, RSTART + 8, RLENGTH - 9) }
' "$report")
missing=""
for path in "$src"/*.zig; do
    name=$(basename "$path")
    [ "$name" = derive.zig ] && continue
    for line in $(grep -nE '^\s*(pub )?fn [A-Za-z_]+\(' "$path" | grep -vE 'comptime [A-Za-z_]+: (type|anytype|Input)\b|: anytype\b|\) type \{' | cut -d: -f1); do
        if ! printf '%s\n' "$instrumented" | grep -qx "$name:$line"; then
            missing="$missing
$name:$line: $(sed -n "${line}p" "$path" | sed 's/^ *//')"
        fi
    done
done

summary="$out/merged/kcov-merged/coverage.json"
total=$(grep -o '^  "total_lines": [0-9]*' "$summary" | grep -o '[0-9]*$')
covered=$(grep -o '^  "covered_lines": [0-9]*' "$summary" | grep -o '[0-9]*$')
percent=$(grep -o '^  "percent_covered": "[0-9.]*"' "$summary" | grep -o '[0-9.]*')
echo "coverage: $covered of $total lines in src/ covered ($percent%)"

status=0
if [ -n "$uncovered" ]; then
    echo "coverage: uncovered lines:" >&2
    for entry in $uncovered; do
        file=${entry%:*}
        line=${entry##*:}
        case $file in /*) path=$file ;; *) path="$src/$(basename "$file")" ;; esac
        echo "  $(basename "$file"):$line: $(sed -n "${line}p" "$path" | sed 's/^ *//')" >&2
    done
    status=1
fi
if [ -n "$missing" ]; then
    echo "coverage: functions never compiled (unreferenced code hides from kcov):$missing" >&2
    status=1
fi
exit $status
