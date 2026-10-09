# Working in new sessions

Each Claude Code cloud session (claude.ai/code) is a fresh container with a fresh clone. Nothing carries over except what is in git and on GitHub: commits, PRs, issues, `CLAUDE.md`, `thoughts/`. So every session starts from a ticket, a handoff or a plan, and every session ends with a pushed branch, a PR or a handoff note.

The commands live in `.claude/commands/`: `/start_ticket`, `/plan_next`, `/handoff`, plus `/create_plan`, `/validate_plan`, `/show_me`. They only exist once PR #2 is merged into `main`. Until then, start each prompt with "Start from branch `claude/iphone-agent-harness`."

A project Stop hook (`scripts/stop-check.sh`) keeps a session from ending while tests, typecheck or anti-slop fail on changed `.ts`; it is silent when green. After merges, run `/learn` to mine review threads into rules (log: `thoughts/learnings-log.md`).

## Kickoff prompts (copy-paste)

**(a) Start a ticket**

```
/start_ticket 5
```
Without the slash commands:
```
Work on issue #5 in perk4/agent-vm-isolate following CLAUDE.md. Read the issue, its comments and parent #3, CLAUDE.md, REVIEW.md and the code it names. If the change is over ~50 lines, write a plan to thoughts/plans/YYYY-MM-DD-5-<slug>.md (max 3 phases, automated checks per phase) and stop for my approval before coding. Then branch claude/5-<slug>, implement phase by phase, test against the iphone-mock MCP server and the mock WDA, run every CI check locally, and open a PR from the template with "Closes #5", the plan link and a /show_me view. Subscribe to the PR and fix CI and review comments until green. Add anything that surprised you to CLAUDE.md Learnings.
```
Add `autonomous` (`/start_ticket 5 autonomous`) only for small or well-specified tickets where you don't want to review the plan.

**(b) Several tickets in parallel**: one session per ticket, each with prompt (a) and its own number. Only run tickets together that are in the same row of the order below.

**(c) Resume from a handoff**

```
Check out branch claude/5-<slug>, read thoughts/handoffs/<file>.md and continue issue #5 following CLAUDE.md and /start_ticket.
```
The ending session prints this exact line when you run `/handoff`. Run `/handoff` whenever a session ends before its PR is green.

**(d) Plan the next batch**

```
/plan_next
```
Without the slash commands:
```
The open tickets in perk4/agent-vm-isolate are done. Gather state: open and closed issues, PRs merged since the last thoughts/roadmap/ note, incident issues, failed CI runs, CLAUDE.md Learnings, thoughts/plans and thoughts/handoffs, and "Where to go next" in iphone-agent/README.md. Read the review threads on the merged PRs and propose an anti-slop.sh, REVIEW.md or Learnings rule for every finding that repeated. Then propose 3-7 tickets, each one PR in size, with type, acceptance criteria, the test or mock route that proves it, the files it touches and which can run in parallel. Show them as a table and wait for my approval. After I approve, create a tracking issue with sub-issues and write thoughts/roadmap/YYYY-MM-DD.md.
```

## Recommended order for the current batch (#3)

| wave | tickets | notes |
|---|---|---|
| 0 | merge PR #2 | the commands and CI live there |
| 1, parallel | #5 element refs, #7 context hygiene, #8 Streamable HTTP, #10 Stop hook + `/learn` | #7 is independent (request params in the loop). #8 is mostly `mcp.ts` transport; rebase if #5 lands first. |
| 2 | #6 more tools | serialize after #5: both change `TOOLS`, `execute` and `ACTIONS` in `agent.ts` and the MCP tool list |
| 3 | #10 experiment flags | after #5 and #6, since `refs` is the first experiment |
| on a Mac | #4 real device / Simulator, then #9 Mirroring | Mac-only. Run #4 as soon as you're at a Mac; its findings correct the mock, which every other ticket tests against. A cloud session can only do the Linux-testable part and hand you a checklist. |

## Plan or oneshot

- **Oneshot** (no plan): one file or under ~50 lines, e.g. a bug with a clear repro, a new anti-slop rule, a docs fix.
- **Plan**: anything bigger or touching the loop, the approve gate, coordinates or transport. Max 3 phases, each a vertical slice with an automated check.
- **Review the plan file before implementation.** It's the highest-leverage review point: a wrong line in the plan becomes hundreds of wrong lines of code, and fixing it there costs a minute. Edit the plan or reply with changes, then say "approved". Review the PR afterwards against the plan and `REVIEW.md`, not line by line from scratch.
