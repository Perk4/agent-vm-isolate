#!/usr/bin/env bash
# Claude Code Stop hook: back-pressure before the agent ends its turn.
# Silent and exit 0 when checks pass or nothing relevant changed. On failure
# prints only the failing output to stderr and exits 2, which blocks the stop
# and hands stderr to Claude as the reason to keep working.
# Skips when stdin JSON has "stop_hook_active": true (already continuing from
# this hook), so a check that can't be fixed never loops the session.
# Usage: bash scripts/stop-check.sh < hook-input.json   (stdin may be empty)
set -uo pipefail
# Here-strings, not `printf | grep -q`: under pipefail, grep -q exiting early
# SIGPIPEs printf on long input and the pipeline reports failure.

input="$(cat 2>/dev/null || true)"
if grep -qE '"stop_hook_active"[[:space:]]*:[[:space:]]*true' <<<"$input"; then
  exit 0
fi

cd "$(dirname "$0")/.." || exit 0

# Only check when .ts files (or the check scripts) changed: uncommitted,
# untracked, or committed but not pushed. Idle and Q&A sessions stay fast.
changed="$(
  git diff --name-only HEAD 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
  if git rev-parse --verify -q '@{upstream}' >/dev/null; then
    git diff --name-only '@{upstream}...HEAD' 2>/dev/null
  fi
)"
if ! grep -qE '(\.ts$|^scripts/anti-slop\.sh$|^tsconfig\.json$|^iphone-agent/(package\.json|tsconfig\.json)$)' <<<"$changed"; then
  exit 0
fi

failed=0
# run <label> <cmd...>: runs quietly; on failure appends the output to stderr.
run() {
  local label="$1" out
  shift
  if ! out="$("$@" 2>&1)"; then
    printf '%s failed:\n%s\n\n' "$label" "$out" >&2
    failed=1
  fi
}

run "root npm test" env NODE_OPTIONS=--test-reporter=dot npm test --silent
run "anti-slop" bash scripts/anti-slop.sh
if [ -d iphone-agent/node_modules ]; then
  run "iphone-agent typecheck" npm --prefix iphone-agent run --silent typecheck
  run "iphone-agent npm test" env NODE_OPTIONS=--test-reporter=dot npm --prefix iphone-agent test --silent
else
  # Exit-0 stderr only reaches the debug log, so this note never blocks.
  echo "stop-check: iphone-agent/node_modules missing, skipped its typecheck and tests (run npm ci there)" >&2
fi

if [ "$failed" -ne 0 ]; then
  echo "stop-check: fix the failures above before finishing (scripts/stop-check.sh)." >&2
  exit 2
fi
exit 0
