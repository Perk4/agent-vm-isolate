# iphone-agent

A small agent harness that controls an iPhone. Everything except the model call is local: the loop, the tools, the screenshot pipeline, the safety gate. Claude is the only remote call.

```
 Claude (Messages API)
        ▲  tool_use / tool_result (+ screenshot image)
        │
 agent.ts ── loop, 7 tools, approve gate, step cap
        │
 device.ts ── points-only view: downscaled screenshot, flattened a11y tree
        │
 wda.ts ── plain-fetch WebDriverAgent client (no Appium)
        │  HTTP :8100 (iproxy / go-ios / pymobiledevice3 port-forward)
        ▼
 WebDriverAgent (XCUITest runner) on the iPhone or Simulator
```

About 670 lines of TypeScript for the harness (plus a ~230-line fake iPhone for tests). Its only runtime dependency is `@anthropic-ai/sdk`. The tests run on Linux against `mock-wda.ts`, a fake iPhone that speaks the same HTTP API.

## Why this design

The research behind it is in [RESEARCH.md](./RESEARCH.md). In short, iOS does not let one app read or tap another app's UI. So anything that drives an iPhone runs off the phone and uses one of two paths:

1. **WebDriverAgent (WDA).** This is Appium's XCUITest HTTP server. You sign it once and it gives you screenshots, the accessibility tree, taps, typing and app launch. mobile-mcp (real devices), Midscene, Open-AutoGLM and Ghost-in-the-Droid all build on it. **This repo uses it.**
2. **macOS iPhone Mirroring with OCR and simulated mouse/keyboard events.** phone-harness and iphone-mirroir-mcp take this route. Nothing is installed on the phone, but there is no accessibility tree, it pauses when you pick up the phone, and it needs macOS 15+ outside the EU.

WDA was the better base for a repeatable prototype. The same API works on the Simulator and on real devices, it is plain JSON, and the accessibility tree lets the model tap exact element centers instead of guessing from pixels.

## Tools the model gets

| tool | WDA call |
|---|---|
| `screenshot` | `GET /screenshot`, downscaled from 3x pixels to points |
| `describe_ui` | `GET /session/:id/source?format=json`, flattened to `Button "Save" center=(340,142) size=68x44` |
| `tap {x,y}` | `POST /session/:id/wda/tap` |
| `swipe {from_x,from_y,to_x,to_y}` | `POST /session/:id/wda/dragfromtoforduration` |
| `type_text {text}` | `POST /session/:id/wda/keys` |
| `press_button {home\|volumeUp\|volumeDown}` | `POST /wda/homescreen`, `POST /session/:id/wda/pressButton` |
| `launch_app {bundle_id}` | `POST /session/:id/wda/apps/launch` |

Every action returns a fresh screenshot, so each turn is one observe → act cycle.

**Coordinates.** WDA taps are in points, but screenshots come back in pixels (3x on most iPhones). The API also downsizes large images. If the model read coordinates off a raw screenshot, its taps would miss. `device.ts` downscales every screenshot to point resolution with a small built-in PNG codec (`png.ts`, using node:zlib). That way screenshot coordinates, `describe_ui` centers and tap coordinates are all the same numbers.

## Try it without a phone

```bash
cd iphone-agent
npm install
npm test                                     # unit + end-to-end tests against the fake iPhone
export ANTHROPIC_API_KEY=...                 # or: ant auth login
npm run agent -- --mock "Turn off Wi-Fi in Settings"
```

## Run it on a real iPhone (Mac, one-time setup)

1. Install Xcode and sign in with your Apple ID. A free account works, but the signature lasts 7 days; a paid account lasts a year.
2. `git clone https://github.com/appium/WebDriverAgent && open WebDriverAgent/WebDriverAgent.xcodeproj`
3. On the **WebDriverAgentLib** and **WebDriverAgentRunner** targets, set Team to your personal team. Change the bundle id to something unique, such as `com.yourname.WebDriverAgentRunner`.
4. On the iPhone:
   - turn on Settings → Privacy & Security → **Developer Mode** and reboot;
   - turn on Settings → Developer → **Enable UI Automation**;
   - trust the computer.
5. Build and start WDA on the phone:
   ```bash
   xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
     -destination 'id=<UDID>' -allowProvisioningUpdates test
   ```
   The first time, trust the developer profile under Settings → General → VPN & Device Management.
6. Forward the port: `iproxy 8100 8100` (`brew install libimobiledevice`), or `pymobiledevice3 usbmux forward 8100 8100`.
7. Check it with `curl localhost:8100/status`, then:
   ```bash
   npm run agent -- --confirm "Open Notes and write a note that says buy milk"
   ```

After the one-time signing, you can start WDA without Xcode. This also works from Linux or Windows: `pymobiledevice3 developer dvt xcuitest com.yourname.WebDriverAgentRunner.xctrunner`, or go-ios `ios runwda ...`. On iOS 17+ these tools open the developer tunnel for you.

**Simulator:** use `-destination 'platform=iOS Simulator,name=iPhone 17'` in step 5. No signing and no port forward are needed.

## Use it as an MCP server

The same seven tools are also served over MCP (`src/mcp.ts`). Any MCP client can then drive the phone with its own loop: Claude Code, Claude Desktop, or the Agent SDK. The client's per-tool permission prompts serve as the approval gate.

```bash
# real phone (WDA forwarded to :8100)
claude mcp add iphone -- node --experimental-strip-types /abs/path/iphone-agent/src/mcp.ts
# fake phone, no device needed
claude mcp add iphone-mock -- node --experimental-strip-types /abs/path/iphone-agent/src/mcp.ts --mock
```

- `WDA_URL` points the server at a different WDA.
- `IPHONE_MCP_READ_ONLY=1` exposes only `screenshot` and `describe_ui`.
- `screenshot` and `describe_ui` are marked `readOnlyHint`, so clients can auto-allow them and still prompt for taps.
- The repo-root `.mcp.json` registers `iphone-mock`. Any Claude Code session in this repo gets a fake iPhone to test its work against.

### Over HTTP (remote clients)

stdio only works when the client runs on the Mac the phone is plugged into. `--http [port]` serves the same tools over MCP Streamable HTTP at `/mcp` (default port 8765), so a client on another machine can use them, such as a cloud Claude Code session or the Claude app through a connector. stdio is still the default.

```bash
npm run mcp -- --http                 # http://127.0.0.1:8765/mcp, loopback only
npm run mcp -- --mock --http 9000     # fake phone on port 9000
claude mcp add --transport http iphone http://127.0.0.1:8765/mcp
```

This server controls a physical phone, so the defaults fail closed:

- It binds `127.0.0.1`. Binding anything else needs an explicit `--host <addr>` **and** a bearer token in `IPHONE_MCP_TOKEN` (at least 32 characters, e.g. `openssl rand -hex 32`). Without the token, the server refuses to start.
- When `IPHONE_MCP_TOKEN` is set (on any bind), every request needs `Authorization: Bearer <token>`. Anything else gets 401. The comparison is constant-time.
- A non-loopback bind is **read-only** (`screenshot`, `describe_ui`) unless you also pass `--allow-actions`. `IPHONE_MCP_READ_ONLY=1` always wins.
- Against DNS rebinding, the `Host` header (and `Origin`, when a browser sends one) must name a loopback address, the `--host` address, or a name given with `--allowed-host <name>` (repeatable). Otherwise the server answers 403. A wildcard bind such as `0.0.0.0` needs `--allowed-host` for every name clients will use.
- The server is stateless: only `POST /mcp` is served, with no sessions and no server-initiated stream.

**Reach it through a tunnel, not an open port.** [Tailscale](https://tailscale.com) puts the Mac and the client on a private, encrypted network, so nothing is exposed to the internet or the LAN:

```bash
# on the Mac with the phone (100.x.y.z is `tailscale ip -4`)
export IPHONE_MCP_TOKEN=$(openssl rand -hex 32)
npm run mcp -- --http --host 100.x.y.z --allowed-host mac.your-tailnet.ts.net            # read-only
npm run mcp -- --http --host 100.x.y.z --allowed-host mac.your-tailnet.ts.net --allow-actions

# on the client machine, in the same tailnet
claude mcp add --transport http iphone http://mac.your-tailnet.ts.net:8765/mcp \
  --header "Authorization: Bearer $IPHONE_MCP_TOKEN"
```

Alternatively, keep the default loopback bind and let `tailscale serve 8765` proxy it with HTTPS inside the tailnet. If requests come back 403 `Host not allowed`, add `--allowed-host mac.your-tailnet.ts.net`. Set `IPHONE_MCP_TOKEN` in this setup too: the bind is loopback, so nothing else forces a token or read-only mode, and the proxy makes every tailnet device look local. Use Tailscale ACLs to limit which devices can reach the Mac. Don't use `tailscale funnel` or router port forwarding: they publish the phone to the internet.

## CLI flags

- `--wda <url>` (default `http://127.0.0.1:8100`, or `WDA_URL`)
- `--mock` uses the built-in fake iPhone
- `--confirm` asks y/N before every action that touches the device
- `--model <id>` (default `claude-opus-5-5`), `--effort low|medium|high|xhigh|max` (default `medium`)
- `--max-steps <n>` (default 30)
- `--no-fallbacks` turns off server-side refusal fallbacks, which are on by default

## Safety

The system prompt tells the model to stop before passwords, purchases, sending messages and security settings. The prompt is not the guarantee, though. For anything beyond a test device, run with `--confirm`, or pass an `approve` callback to `runAgent`. The callback sees every action before it reaches the phone.

## Where to go next

- **Run it from your phone.** Start the harness on the Mac inside Claude Code and drive it with Claude Code Remote Control (`claude --remote-control`) from the Claude iOS app. You give the iPhone a task from the iPhone itself.
- **Mirroring backend.** Implement `Device` with `screencapture` of the iPhone Mirroring window and CGEvent clicks, for setups with no WDA signing.
- **Context hygiene.** Keep only the last N screenshots on long tasks (context editing `clear_tool_uses_20250919`).
