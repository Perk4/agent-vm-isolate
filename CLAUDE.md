# agent-vm-isolate

## Layout

- `src/`: root package `isolate` (container vs VM isolation contract). Zero dependencies. Tests in `src/isolate.test.ts`, fixtures in `fixtures/`.
- `iphone-agent/`: separate npm package (own `package.json` + `package-lock.json`). WebDriverAgent harness that lets Claude drive an iPhone: `agent.ts` (loop, tools, approve gate), `wda.ts` (WDA client), `device.ts` (points-only view), `png.ts`, `mock-wda.ts` (fake iPhone), `cli.ts`, `mcp.ts` (same tools as an MCP server). Root `.mcp.json` registers `iphone-mock`, a mock-backed MCP server for testing your work.
- `scripts/anti-slop.sh`: grep-based anti-pattern check (see `REVIEW.md`).
- `.github/`: CI, PR/issue templates, CODEOWNERS. `REVIEW.md`: what blocks a PR.
- `thoughts/plans/`: implementation plans (`/create_plan`, `/validate_plan`).

## Commands

```sh
# root
npm test                                   # node --test on src/isolate.test.ts
npm install --no-save --no-package-lock typescript@5.9.3 @types/node@22 && npx --no-install tsc -p .   # root typecheck
bash scripts/anti-slop.sh                  # anti-slop scan

# iphone-agent (cd iphone-agent first)
npm ci
npm run typecheck                          # tsc -p .
npm test                                   # node --test src/*.test.ts
npm run mock                               # fake WDA on :8100 (PORT env to change)
npm run agent -- --mock "task"             # run the agent against the built-in mock
npm run mcp                                # MCP server on stdio (add --mock for the fake phone)
npm run agent -- --wda http://127.0.0.1:8100 --confirm "task"   # real device; needs ANTHROPIC_API_KEY
```

CI (`.github/workflows/ci.yml`) runs all of the above plus a mock smoke test (`/status`, `/screenshot`, `/source`).

## Conventions

- Zero-dependency where possible. Root has none; justify any new runtime dep in `iphone-agent`.
- TypeScript runs directly via `node --experimental-strip-types`: only erasable syntax. No constructor parameter properties, `enum`, `namespace`, or emit-requiring decorators. Import local files with the `.ts` extension.
- Strict tsconfig (root `tsconfig.json`, extended by `iphone-agent/`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (don't assign `undefined` to an optional prop; omit it or spread conditionally), `verbatimModuleSyntax` (use `import type`).
- Points, not pixels: everything the model sees and everything sent to WDA is in points. Convert once, in `device.ts`.
- Every device-changing tool goes through the `approve` gate (`ACTIONS` in `agent.ts`) and has a mock WDA route plus tests.
- Errors from WDA come back to the model as `tool_result` with `is_error: true`, not as thrown exceptions out of the loop.

## Workflow

Skip the plan for small changes (one file or under ~50 lines): implement, test, open the PR. Plans are at most 3 phases, each a vertical slice that runs end to end. Don't over-plan.

1. Research: read the relevant code and `iphone-agent/RESEARCH.md`; don't guess APIs.
2. Plan: `/create_plan` writes `thoughts/plans/YYYY-MM-DD-slug.md` with phases and automated + manual success criteria.
3. Implement one phase at a time; run the phase's automated checks before moving on.
4. Validate: `/validate_plan` checks the implementation against the plan and runs every check.
5. Align visually on anything non-trivial: `/show_me` gives the file-tree diff, call path and type signatures. Paste it into the PR.
6. Keep PRs small (one plan phase or one fix). Fill in `.github/pull_request_template.md`, link the plan.

Never edit or delete a test to make it pass. A failing test is a finding: fix the code, or explain in the PR why the test was wrong.

## Learnings

Add entries when something bites you. Keep each to one or two lines.

- `--experimental-strip-types` rejects constructor parameter properties (`constructor(private x: T)`). Declare the field and assign it in the body.
- WDA coordinates are points; screenshots are pixels (3x on most iPhones). Mixing them makes taps miss by a factor of the scale.
- The Claude API downsizes large images, so coordinates read off a full-res screenshot are wrong twice over. Send point-resolution screenshots.
