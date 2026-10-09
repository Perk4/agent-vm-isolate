# How people run agent harnesses against phones (research, 2026-10-08)

Three research agents surveyed Reddit/X discussion, GitHub repos, and the iOS control stack. Reddit itself could not be fetched from the research sandbox, so community signal comes from blogs, reviews and write-ups that quote those threads. Star counts are approximate as of the research date.

## The landscape

| Project | Stars | Platforms | How it controls the phone | Notes |
|---|---|---|---|---|
| [zai-org/Open-AutoGLM](https://github.com/zai-org/Open-AutoGLM) | ~26k | Android, HarmonyOS, iPhone | adb / hdc / WDA | Ships a self-hostable 9B phone model |
| [web-infra-dev/midscene](https://github.com/web-infra-dev/midscene) | ~15k | Android, iOS | adb / WDA | Vision-first `aiTap` / `aiInput` SDK |
| [droidrun/mobilerun](https://github.com/droidrun/mobilerun) | ~9.6k | Android (iOS experimental) | Accessibility-service Portal app | |
| [X-PLUG/MobileAgent](https://github.com/X-PLUG/MobileAgent) | ~9.3k | Android | adb | Research code, no iOS |
| [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) | ~8.8k | iOS sim + real, Android | mobilecli / WDA / adb | The de facto MCP; accessibility tree first |
| [TencentQQGYLab/AppAgent](https://github.com/TencentQQGYLab/AppAgent) | ~6.9k | Android | adb | Stale since 2025 |
| [minitap-ai/mobile-use](https://github.com/minitap-ai/mobile-use) | ~3.2k | Android, iOS **sim only** | adb / idb | LangGraph multi-agent |
| [ShawnPana/phone-harness](https://github.com/ShawnPana/phone-harness) | ~3.2k | real iPhone, Android | iPhone Mirroring + Vision OCR + CGEvents | Zero setup on the phone; the 2026 hobbyist favorite |
| [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) | ~2.2k | iOS sim | idb + simctl | |
| [openatx/facebook-wda](https://github.com/openatx/facebook-wda) | ~1.9k | iOS | WDA | Python WDA client library |
| [ghost-in-the-droid/android-agent](https://github.com/ghost-in-the-droid/android-agent) | ~380 | Android, iOS | Appium + WDA | Compiles workflows into replayable skills |
| [ferrumclaudepilgrim/claude-code-android](https://github.com/ferrumclaudepilgrim/claude-code-android) | ~270 | Android, on-device | Termux + self-paired adb | Only fully on-phone harness; just the LLM call leaves the device |
| [jfarcand/iphone-mirroir-mcp](https://github.com/jfarcand/iphone-mirroir-mcp) | ~245 | real iPhone | iPhone Mirroring + OCR | MCP version of phone-harness |
| [samhjn/iClaw](https://github.com/samhjn/iClaw) | ~90 | iOS, on-device | none (sandboxed) | Agent loop in an iOS app; can't touch other apps |

## What the field converges on

- **On Android, the harness can live on the phone.** Termux + Claude Code + `adb connect 127.0.0.1` (wireless debugging paired to itself) gives screencap and input injection with only the model call leaving the device.
- **On iOS it cannot.** Sandboxing blocks one app from reading or tapping another app. Shortcuts, a-Shell, iSH and Scriptable can't do it; Node-based CLIs don't even run in iSH. Every iPhone-controlling harness runs on a computer and reaches the phone through one of two paths:
  - **WebDriverAgent**: the most reliable, with an accessibility tree. It costs a one-time signing step (a free Apple ID works, re-sign every 7 days).
  - **iPhone Mirroring**: the easiest, with nothing on the phone. It is OCR only, pauses when the phone is in use, and needs macOS 15+.
- **The loop is always the same.** Observe (screenshot plus UI tree) → model picks one action → execute → return a fresh screenshot. Tools are small: screenshot, list elements, tap, swipe, type, button, launch app.
- **The classic bug is coordinate space.** WDA works in points and screenshots are in pixels (3x). Downscale the screenshot to points or divide by the scale.

## Using the phone as the remote

A different reading of "run agents on the phone": the phone controls an agent running on a computer. The options:
- Claude Code Remote Control (`claude --remote-control`, `/rc`), driven from the Claude iOS app.
- The older do-it-yourself route: Blink or Termux + Tailscale + tmux.

Combine that with this harness and you can give your iPhone a task from your iPhone.
