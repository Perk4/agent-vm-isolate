# Element refs in describe_ui, and tap by ref

## Goal
Issue #5. `describe_ui` prefixes each element with a ref (`e1`, `e2`, ...) and `tap` accepts `{ref}` as well as `{x,y}`, so the model stops copying coordinates by hand. A stale ref (unknown, from before the last action, or the screen changed since `describe_ui`) is an `is_error` result telling the model to call `describe_ui` again. A stale ref never taps old coordinates.

## Current state
- `iphone-agent/src/device.ts:35` `flattenUi(root, max)` turns the WDA source tree into lines like `Icon "Settings" center=(62,112) size=64x64`. `IPhone.describeUi` (`device.ts:83`) returns that string; nothing is cached.
- `iphone-agent/src/agent.ts:34` `tap` tool: `{x, y}` both required, `strict: true`, `additionalProperties: false`. `execute` (`agent.ts:117`) calls `device.tap(n("x"), n("y"))`.
- `tap` is in `ACTIONS` (`agent.ts:104`), so the approve gate covers it in `runAgent` and `createPhoneMcpServer` (`mcp.ts:46`).
- `mcp.ts:33` passes `input_schema` through unchanged as the MCP `inputSchema`.
- `mcp.test.ts:38` asserts `tap.inputSchema.required` is `["x","y"]`. The ticket changes this contract (x/y are no longer required when `ref` is given), so that assertion changes with it. Called out in the PR.

### Schema constraint
Strict tool use supports `anyOf` but not `oneOf`, and requires `additionalProperties: false` (claude-api skill, `shared/tool-use-concepts.md`, "JSON Schema Limitations"). The Messages API also rejects `oneOf`/`anyOf`/`allOf` at the top level of `input_schema`, and MCP clients forward MCP `inputSchema` to that API, so a root-level union breaks both paths. Choice: one object schema with `ref`, `x`, `y` all optional (`required: []`), `strict: true` kept, and `execute` enforces "ref, or both x and y, not both". The descriptions name both forms.

## Out of scope
- Refs for `swipe` or `type_text`.
- Persisting refs across `describe_ui` calls or matching elements fuzzily after a UI change.

## Phase 1: refs end to end
### Changes
- `device.ts`: split `flattenUi` into `uiElements` (tree to a list with refs and rects) and the formatter; `flattenUi` keeps its signature and prefixes each line with its ref. `Device` gains `tapRef(ref)`. `IPhone` keeps an epoch: every action bumps it before calling WDA; `describeUi` caches the ref map tagged with the epoch it started in and drops it if an action ran meanwhile. `tapRef` refuses when the cache is missing, from an older epoch, or lacks the ref; otherwise it re-reads `/source` and refuses unless the element at that ref has the same type, label and rect. Only then it taps the element's center (points, from the source rect).
- `agent.ts`: `tap` schema `{ref?, x?, y?}`; `execute` validates the either/or and routes to `tapRef` or `tap`. Descriptions and `SYSTEM` say to prefer refs.
- `README.md`: tool table shows `tap {ref} | {x,y}` and the ref prefix.
### Success criteria
Automated:
- [ ] `cd iphone-agent && npm ci && npm run typecheck && npm test`
- [ ] `npm test` (root), root `tsc -p .`, `bash scripts/anti-slop.sh`
- [ ] New tests: tap by ref flips Wi-Fi (agent loop and MCP); stale ref after `launch_app` errors with no `/wda/tap`; ref refused after an out-of-band screen change; unknown ref / no describe_ui / both forms / neither form error; MCP `inputSchema` lists `ref`, `x`, `y`.
Manual:
- [ ] `iphone-mock` MCP server: describe_ui, tap `{ref}` on Settings, then on the Wi-Fi switch.

## Risks & rollback
On a real device `tapRef` costs one extra `/source` call (hundreds of ms on big trees). Elements whose rect moves while the screen settles make refs stale more often; the error tells the model to call describe_ui again. Revert the PR to roll back; nothing is stateful.
