# CI and agent automation

## What runs where

| Layer | Trigger | Checks | Needs |
| --- | --- | --- | --- |
| `ci.yml` (root, iphone-agent, anti-slop) | every `pull_request`, push to `main` | tests, typecheck, mock e2e smoke, `scripts/anti-slop.sh` | nothing |
| `claude-review.yml` job `review` | PR opened / pushed / reopened / ready for review (same-repo, non-draft, non-bot) | Claude reviews the diff against `REVIEW.md` and `.claude/skills/anti-slop/SKILL.md` and posts inline `blocker:` and `nit:` comments | Claude secret |
| `claude-review.yml` job `claude` | `@claude` in a PR or issue comment or review, or the `agent-ready` label on an issue | Claude does the request. On a PR, it pushes commits to the PR branch. On an issue, it pushes a `claude/issue-N-...` branch and comments a "Create PR" link. | Claude secret + Claude GitHub App |
| `.claude/skills/anti-slop` | any Claude Code session in this repo (local, cloud, or the action) | guides the model while it writes code | nothing |

Without a secret, both Claude jobs **skip** (green, with a notice). This includes fork PRs, which never receive secrets. The review job also skips fork PRs outright.

## One-time setup (repo owner)

1. **Install the Claude GitHub App and add the secret.** The easiest way: in Claude Code, inside this repo, run `/install-github-app` and follow the prompts. It installs https://github.com/apps/claude on the repo and adds the secret. To do it by hand instead:
   - Install https://github.com/apps/claude on `perk4/agent-vm-isolate`.
   - Go to Settings → Secrets and variables → Actions → New repository secret, and add **one** of:
     - `ANTHROPIC_API_KEY`: an API key from console.anthropic.com (billed per token), or
     - `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` locally (Pro/Max subscription).
   The `review` job only needs the secret, because it posts with the workflow's `GITHUB_TOKEN`. The `claude` job also needs the app: its pushes go out as `claude[bot]`, so they trigger CI. Pushes made with `GITHUB_TOKEN` don't.
2. **Create the label** `agent-ready` (Issues → Labels). Adding it to an issue starts the `claude` job.
3. **Branch protection on `main`** (Settings → Branches, or Rules → Rulesets): require a pull request, and require the status checks `root (isolate tests + typecheck)`, `iphone-agent (typecheck, tests, mock e2e)` and `anti-slop`. Don't make the Claude jobs required: they skip when no secret is available.
4. Merge the workflow to `main`. `issue_comment`, `pull_request_review*` and `issues` events always run the workflow file **from the default branch**, so `@claude` and `agent-ready` only work after the merge. The PR review runs from the PR's own copy.

## Security notes

- Only users with write access can trigger the action (it checks this). Bots are refused unless they are listed in `allowed_bots`.
- When the action runs on a PR, it restores `.claude/` and `CLAUDE.md` from the base branch. A PR therefore can't swap in its own skill or instructions; the PR's versions are kept under `.claude-pr/` for reference.
- The action is pinned to a commit SHA (v1.0.245). Bump it deliberately.
- `review` has `contents: read` and `pull-requests: write` only. `claude` has write access to contents, PRs and issues, and its Bash access is limited to the repo's test, typecheck and anti-slop commands (plus the git commands the action adds).
- No secret values live in the repo. Keys come from GitHub secrets only.
