#!/usr/bin/env bash
# anti-slop: fail fast on common model-generated TypeScript anti-patterns.
# Scans .ts files under src/ and iphone-agent/src/ (node_modules excluded).
# Prints file:line:text for each hit; exits 1 if anything is found.
# Usage: bash scripts/anti-slop.sh [dir ...]   (paths relative to the repo root)
# Rules are documented in REVIEW.md ("Anti-slop list").
set -uo pipefail
# Run the last stage of each pipeline (report) in this shell so `fail` sticks.
shopt -s lastpipe

cd "$(dirname "$0")/.."

DIRS=("$@")
if [ "${#DIRS[@]}" -eq 0 ]; then
  for d in src iphone-agent/src; do
    if [ -d "$d" ]; then DIRS+=("$d"); fi
  done
fi

fail=0

# report <rule>: reads "file:line:text" lines on stdin; prints them and marks failure.
report() {
  local rule="$1" out
  out="$(cat)"
  if [ -n "$out" ]; then
    echo "anti-slop: $rule"
    printf '%s\n' "$out" | sed 's/^/  /'
    fail=1
  fi
}

# Non-test source files vs test files.
src_grep() { grep -rnE --include='*.ts' --exclude='*.test.ts' --exclude-dir=node_modules "$@" "${DIRS[@]}"; }
test_grep() { grep -rnE --include='*.test.ts' --exclude-dir=node_modules "$@" "${DIRS[@]}"; }

# 1. `any` escapes the type system (`unknown` + narrowing is fine).
src_grep '(:[[:space:]]*any\b|\bas[[:space:]]+any\b|<any>)' \
  | report "explicit 'any' (use unknown and narrow)"

# 2. Compiler suppression.
src_grep '@ts-(ignore|nocheck)' \
  | report "@ts-ignore / @ts-nocheck (fix the type; use @ts-expect-error with a reason if truly unavoidable)"

# 3. console.log outside CLI entry points (cli.ts and mock-wda.ts print by design).
src_grep 'console\.log\(' \
  | grep -vE '^iphone-agent/src/(cli|mock-wda)\.ts:' \
  | report "console.log outside CLI entry points (return data or write to stderr deliberately)"

# 4. TODO/FIXME must reference an issue, e.g. TODO(#123): ...
src_grep '\b(TODO|FIXME)\b' | grep -vE '#[0-9]+' \
  | report "TODO/FIXME without an issue reference like #123"

# 5a. Empty catch on one line: `catch {}` / `catch (e) {}`.
src_grep 'catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{[[:space:]]*\}' \
  | report "empty catch block"

# 5b. `catch {` whose very next line is `}`. A body holding a comment that
#     explains why the error is swallowed is NOT empty and is allowed.
multi=""
while IFS= read -r f; do
  multi+="$(awk -v f="$f" '
    prev && /^[[:space:]]*\}/ { print f ":" prevno ":" prevline }
    { prev = ($0 ~ /catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{[[:space:]]*$/); prevno = NR; prevline = $0 }
  ' "$f")"
done < <(grep -rlE --include='*.ts' --exclude='*.test.ts' --exclude-dir=node_modules 'catch' "${DIRS[@]}")
printf '%s' "$multi" | report "empty catch block (multi-line; handle the error or comment why it is ignored)"

# 6. Lint suppression (source and tests).
grep -rnE --include='*.ts' --exclude-dir=node_modules 'eslint-disable' "${DIRS[@]}" \
  | report "eslint-disable"

# 7. Focused tests silently skip the rest of the suite.
test_grep '\b(test|it|describe|suite)\.only\(|\bonly:[[:space:]]*true' \
  | report ".only( / { only: true } in tests"

# 8. Placeholder text.
src_grep -i 'lorem ipsum|your[-_]api[-_]key|sk-ant-x{3,}|<insert[ _-]' \
  | report "placeholder text"

if [ "$fail" -ne 0 ]; then
  echo "anti-slop: FAILED"
  exit 1
fi
echo "anti-slop: clean (${DIRS[*]})"
