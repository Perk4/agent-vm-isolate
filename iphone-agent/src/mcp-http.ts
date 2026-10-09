// Streamable HTTP mode for the phone MCP server, so a client on another machine
// (a cloud Claude Code session, a connector) can drive the phone. This server
// controls a physical device, so every default fails closed:
// - binds 127.0.0.1 unless a host is given;
// - "exposed" means a non-loopback bind OR a non-loopback --allowed-host (a
//   proxy such as `tailscale serve` in front of a loopback bind). An exposed
//   server refuses to start without a bearer token, and is read-only unless
//   allowActions is set;
// - Host and Origin are checked on every request against DNS rebinding.
// The SDK's allowedHosts/allowedOrigins transport options are deprecated in
// favour of middleware, and its middleware is Express-only, so the checks live here.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIPv4, isIPv6, type AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Device } from "./device.ts";
import { createPhoneMcpServer } from "./mcp.ts";

export type PhoneHttpOptions = {
  port: number;
  /** Bind address. Default 127.0.0.1. Anything that isn't loopback makes the server exposed. */
  host?: string;
  /** Required `Authorization: Bearer` value. Enforced on every bind when set. */
  token?: string;
  /** Allow action tools on an exposed server (read-only otherwise). */
  allowActions?: boolean;
  readOnly?: boolean;
  /** Extra Host/Origin hostnames to accept, e.g. a Tailscale MagicDNS name. A non-loopback one makes the server exposed. */
  allowedHosts?: string[];
};

const HTTP_ONLY_FLAGS = ["--host", "--allow-actions", "--allowed-host"];
const isFlag = (arg: string, flag: string) => arg === flag || arg.startsWith(`${flag}=`);

/**
 * True when argv asks for HTTP mode (`--http` or `--http=<port>`). Throws when an
 * HTTP-only flag appears without it, rather than silently serving stdio.
 */
export function wantsHttp(argv: string[]): boolean {
  if (argv.some((a) => isFlag(a, "--http"))) return true;
  const stray = argv.find((a) => HTTP_ONLY_FLAGS.some((f) => isFlag(a, f)));
  if (stray !== undefined) throw new Error(`${stray.split("=")[0]} only applies to HTTP mode; add --http`);
  return false;
}

function parsePort(raw: string): number {
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 0 && port <= 65535)) throw new Error(`invalid port: ${raw}`);
  return port;
}

/**
 * CLI flags for HTTP mode: `--http [port]` or `--http=<port>`, `--host <addr>`, `--allow-actions`,
 * `--allowed-host <name>` (repeatable). Throws on unknown or malformed flags rather than guessing,
 * since a typo could widen exposure.
 */
export function parseHttpArgs(argv: string[], token: string | undefined): PhoneHttpOptions {
  const args: string[] = [];
  let port = 8765;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--http=")) {
      port = parsePort(a.slice("--http=".length));
      args.push("--http");
    } else if (a === "--http" && /^\d+$/.test(argv[i + 1] ?? "")) {
      i++;
      port = parsePort(argv[i] ?? "");
      args.push("--http");
    } else {
      args.push(a);
    }
  }
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      http: { type: "boolean" },
      mock: { type: "boolean" },
      host: { type: "string" },
      "allow-actions": { type: "boolean" },
      "allowed-host": { type: "string", multiple: true },
    },
  });
  return {
    port,
    ...(values.host !== undefined ? { host: values.host } : {}),
    ...(token ? { token } : {}),
    ...(values["allow-actions"] ? { allowActions: true } : {}),
    ...(values["allowed-host"] ? { allowedHosts: values["allowed-host"] } : {}),
  };
}

export type PhoneHttpServer = { url: string; readOnly: boolean; close: () => Promise<void> };

const MIN_TOKEN_LENGTH = 32;
const WILDCARDS = new Set(["0.0.0.0", "[::]"]);

/** Takes a hostname in `new URL(...).hostname` form (IPv6 in brackets). */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || (isIPv4(hostname) && hostname.startsWith("127."));
}

const dropTrailingDot = (hostname: string) => (hostname.endsWith(".") ? hostname.slice(0, -1) : hostname);

/**
 * A configured host (bind address or --allowed-host) in the form a request's Host header
 * parses to: lowercased and canonicalized by WHATWG URL, IPv6 in brackets, no trailing dot.
 * Undefined for anything that isn't a bare host: scheme, port, path, credentials, whitespace.
 */
function canonicalHost(raw: string): string | undefined {
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const v6 = isIPv6(bare);
  if (bare === "" || /[\s/?#@\\]/.test(bare) || (!v6 && bare.includes(":"))) return undefined;
  try {
    const hostname = dropTrailingDot(new URL(`http://${v6 ? `[${bare}]` : bare}`).hostname);
    return hostname === "" ? undefined : hostname;
  } catch {
    return undefined;
  }
}

function hostnameOf(url: string): string | undefined {
  try {
    return dropTrailingDot(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time: both sides are hashed to 32 bytes, so neither length nor content leaks through timing. */
function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const presented = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "")?.[1] ?? "";
  return timingSafeEqual(sha256(presented), expected);
}

function rejectReason(req: IncomingMessage, allowed: ReadonlySet<string>): string | undefined {
  const ok = (hostname: string | undefined) => hostname !== undefined && (isLoopback(hostname) || allowed.has(hostname));
  const host = req.headers.host;
  if (!host) return "missing Host header";
  if (!ok(hostnameOf(`http://${host}`))) return `Host not allowed: ${host} (see --allowed-host)`;
  // Non-browser clients send no Origin. A browser page on another site would, which is the rebinding case.
  const origin = req.headers.origin;
  if (origin !== undefined && !ok(hostnameOf(origin))) return `Origin not allowed: ${origin}`;
  return undefined;
}

function reply(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

export async function startPhoneHttpServer(device: Device, opts: PhoneHttpOptions): Promise<PhoneHttpServer> {
  const host = canonicalHost(opts.host ?? "127.0.0.1");
  if (host === undefined) throw new Error(`invalid --host "${opts.host}": give a bare hostname or IP address`);
  const allowed = new Set<string>();
  for (const raw of opts.allowedHosts ?? []) {
    const h = canonicalHost(raw);
    if (h === undefined) {
      throw new Error(`invalid --allowed-host "${raw}": give a bare hostname or IP address, with no scheme, port, path or whitespace`);
    }
    allowed.add(h);
  }
  if (opts.token !== undefined && (opts.token.length < MIN_TOKEN_LENGTH || /\s/.test(opts.token))) {
    throw new Error(`IPHONE_MCP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters, no whitespace (try: openssl rand -hex 32)`);
  }
  const publicName = [...allowed].find((h) => !isLoopback(h));
  const exposed = !isLoopback(host) || publicName !== undefined;
  if (exposed && opts.token === undefined) {
    const why = isLoopback(host) ? `accept Host ${publicName}` : `bind ${host}`;
    throw new Error(`refusing to ${why} without a bearer token: set IPHONE_MCP_TOKEN (try: openssl rand -hex 32)`);
  }
  const readOnly = opts.readOnly === true || (exposed && opts.allowActions !== true);
  const expected = opts.token === undefined ? undefined : sha256(opts.token);
  if (!WILDCARDS.has(host)) allowed.add(host);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split("?")[0] !== "/mcp") return reply(res, 404, -32000, "not found; the endpoint is /mcp");
    const rejected = rejectReason(req, allowed);
    if (rejected) return reply(res, 403, -32000, rejected);
    if (expected && !bearerMatches(req.headers.authorization, expected)) {
      return reply(res, 401, -32000, "missing or invalid bearer token", { "www-authenticate": 'Bearer realm="iphone-agent"' });
    }
    // Stateless: no sessions, so no server-initiated stream on GET and nothing to DELETE.
    if (req.method !== "POST") return reply(res, 405, -32000, "method not allowed", { allow: "POST" });
    // A Server binds one transport, so stateless mode builds both per request. The device is shared,
    // and createPhoneMcpServer serializes tool calls per device across these per-request servers.
    const server = createPhoneMcpServer(device, { readOnly });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => void server.close());
    // @ts-expect-error SDK 1.32 typings: the Node transport's onclose/onerror/onmessage accessors return `T | undefined`, which `Transport`'s optional props reject under exactOptionalPropertyTypes. Runtime shape matches.
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // Details stay in the operator's log; the client may be remote.
      console.error("iphone-agent MCP: request failed:", err);
      if (!res.headersSent) reply(res, 500, -32603, "internal error");
      else res.end();
    });
  });
  // listen() wants a bare IPv6 address, not the bracketed URL form.
  const listenHost = host.startsWith("[") ? host.slice(1, -1) : host;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, listenHost, () => resolve());
  });
  // SAFETY: listen() on a TCP host/port always reports an AddressInfo, never a pipe path string.
  const { port } = http.address() as AddressInfo;
  const shown = host === "0.0.0.0" ? "127.0.0.1" : host === "[::]" ? "[::1]" : host;
  return {
    url: `http://${shown}:${port}/mcp`,
    readOnly,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
