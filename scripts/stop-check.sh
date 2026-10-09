#!/usr/bin/env bash
# Claude Code Stop hook: back-pressure before the agent ends its turn.
# Checks the repo the session is working in (hook input `cwd`, so worktrees
# check themselves), and only when check inputs changed: uncommitted,
# untracked, or committed but not pushed (vs upstream, else vs main).
# Runs root tests + typecheck, anti-slop, iphone-agent typecheck + tests
# (running `npm ci` there first if node_modules is missing).
# Silent and exit 0 when green. On failure prints only the failures to stderr
# and exits 2, which blocks the stop and hands stderr to Claude.
# Blocks at most MAX_BLOCKS times per session (counter in
# <git-dir>/stop-check/<session_id>, reset on success), then lets the stop
# through so an unfixable failure can't trap the session.
# Usage: bash scripts/stop-check.sh < hook-input.json   (stdin may be empty)
set -uo pipefail
# Here-strings, not `printf | grep -q`: under pipefail, grep -q exiting early
# SIGPIPEs printf on long input and the pipeline reports failure.

MAX_BLOCKS=3

input=""
[ -t 0 ] || input="$(cat)"

# session_id (sanitized for a file name) and cwd from the hook JSON.
session_id="" cwd=""
{ IFS= read -r session_id; IFS= read -r cwd; } < <(node -e '
  let s = "";
  process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    let j = {};
    try { j = JSON.parse(s); } catch { /* empty or non-JSON stdin: use defaults */ }
    const id = typeof j.session_id === "string" ? j.session_id.replace(/[^A-Za-z0-9_-]/g, "") : "";
    const cwd = typeof j.cwd === "string" ? j.cwd.replace(/\n/g, "") : "";
    process.stdout.write(id + "\n" + cwd + "\n");
  });
' <<<"$input" 2>/dev/null)

root="$(git -C "${cwd:-$PWD}" rev-parse --show-toplevel 2>/dev/null)" \
  || root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit 0

base=""
if git rev-parse -q --verify '@{upstream}' >/dev/null; then
  base='@{upstream}'
else
  for ref in origin/main main; do
    if base="$(git merge-base HEAD "$ref" 2>/dev/null)"; then break; fi
    base=""
  done
fi
changed="$(
  git diff --name-only HEAD 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
  if [ -n "$base" ]; then git diff --name-only "$base...HEAD" 2>/dev/null; fi
)"
if ! grep -qE '(\.ts$|^fixtures/|^scripts/|^\.claude/skills/anti-slop/|(^|/)(package|package-lock|tsconfig)\.json$)' <<<"$changed"; then
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

dot="${NODE_OPTIONS:-} --test-reporter=dot"
run "root npm test" env NODE_OPTIONS="$dot" npm test --silent
run "anti-slop" bash scripts/anti-slop.sh
deps_ok=1
if [ ! -d iphone-agent/node_modules ]; then
  # A failed install can leave a partial node_modules: remove it so the next
  # run retries (npm ci deletes it first anyway), and skip the checks that
  # need it rather than burying the npm error under missing-module noise.
  if ! out="$(npm ci --prefix iphone-agent --loglevel=error --no-audit --no-fund 2>&1)"; then
    rm -rf iphone-agent/node_modules
    printf 'iphone-agent npm ci failed; run `cd iphone-agent && npm ci` and fix it (skipped root typecheck and iphone-agent checks):\n%s\n\n' "$(tail -n 20 <<<"$out")" >&2
    failed=1
    deps_ok=0
  fi
fi
if [ "$deps_ok" -eq 1 ]; then
  # Root has no deps; borrow iphone-agent's pinned tsc and @types/node.
  run "root typecheck" iphone-agent/node_modules/.bin/tsc -p . --typeRoots iphone-agent/node_modules/@types
  run "iphone-agent typecheck" npm --prefix iphone-agent run --silent typecheck
  run "iphone-agent npm test" env NODE_OPTIONS="$dot" npm --prefix iphone-agent test --silent
fi

state_dir="$(git rev-parse --absolute-git-dir)/stop-check"
counter="$state_dir/${session_id:-no-session}"
if [ "$failed" -eq 0 ]; then
  rm -f "$counter"
  exit 0
fi

blocks="$(cat "$counter" 2>/dev/null || echo 0)"
case "$blocks" in '' | *[!0-9]*) blocks=0 ;; esac
if [ "$blocks" -ge "$MAX_BLOCKS" ]; then
  echo "stop-check: still failing after $MAX_BLOCKS blocks this session; allowing the stop. Say what is still broken." >&2
  exit 0
fi
mkdir -p "$state_dir" && echo $((blocks + 1)) >"$counter"
echo "stop-check: fix the failures above before finishing (block $((blocks + 1))/$MAX_BLOCKS, scripts/stop-check.sh)." >&2
exit 2
