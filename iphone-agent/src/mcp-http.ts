// Streamable HTTP mode for the phone MCP server, so a client on another machine
// (a cloud Claude Code session, a connector) can drive the phone. This server
// controls a physical device, so every default fails closed:
// - binds 127.0.0.1 unless a host is given;
// - a non-loopback bind refuses to start without a bearer token, and is
//   read-only unless allowActions is set;
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
  /** Bind address. Default 127.0.0.1. Anything that isn't loopback needs `token`. */
  host?: string;
  /** Required `Authorization: Bearer` value. Enforced on every bind when set. */
  token?: string;
  /** Allow action tools on a non-loopback bind (read-only otherwise). */
  allowActions?: boolean;
  readOnly?: boolean;
  /** Extra Host/Origin hostnames to accept, e.g. a Tailscale MagicDNS name. */
  allowedHosts?: string[];
};

/**
 * CLI flags for HTTP mode: `--http [port] [--host <addr>] [--allow-actions] [--allowed-host <name>]...`.
 * Throws on unknown or malformed flags rather than guessing, since a typo could widen exposure.
 */
export function parseHttpArgs(argv: string[], token: string | undefined): PhoneHttpOptions {
  const args = [...argv];
  const at = args.indexOf("--http");
  const next = args[at + 1];
  let port = 8765;
  if (next !== undefined && /^\d+$/.test(next)) {
    port = Number(next);
    args.splice(at + 1, 1);
  }
  if (port > 65535) throw new Error(`invalid port: ${port}`);
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
const WILDCARDS = new Set(["0.0.0.0", "::", "[::]"]);
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || (isIPv4(host) && host.startsWith("127."));
}

/** The form `new URL(...).hostname` gives: IPv6 literals in brackets. */
function asHostname(host: string): string {
  return isIPv6(host) ? `[${host}]` : host.toLowerCase();
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
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
  const host = req.headers.host;
  if (!host) return "missing Host header";
  const hostname = hostnameOf(`http://${host}`);
  if (hostname === undefined || !allowed.has(hostname)) return `Host not allowed: ${host} (see --allowed-host)`;
  // Non-browser clients send no Origin. A browser page on another site would, which is the rebinding case.
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const o = hostnameOf(origin);
    if (o === undefined || !allowed.has(o)) return `Origin not allowed: ${origin}`;
  }
  return undefined;
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function startPhoneHttpServer(device: Device, opts: PhoneHttpOptions): Promise<PhoneHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const local = isLoopback(host);
  if (opts.token !== undefined && (opts.token.length < MIN_TOKEN_LENGTH || /\s/.test(opts.token))) {
    throw new Error(`IPHONE_MCP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters, no whitespace (try: openssl rand -hex 32)`);
  }
  if (!local && opts.token === undefined) {
    throw new Error(`refusing to bind ${host} without a bearer token: set IPHONE_MCP_TOKEN (try: openssl rand -hex 32)`);
  }
  const readOnly = opts.readOnly === true || (!local && opts.allowActions !== true);
  const expected = opts.token === undefined ? undefined : sha256(opts.token);
  const allowed = new Set([
    ...LOOPBACK_HOSTNAMES,
    ...(WILDCARDS.has(host) ? [] : [asHostname(host)]),
    ...(opts.allowedHosts ?? []).map(asHostname),
  ]);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split("?")[0] !== "/mcp") return reply(res, 404, "not found; the endpoint is /mcp");
    const rejected = rejectReason(req, allowed);
    if (rejected) return reply(res, 403, rejected);
    if (expected && !bearerMatches(req.headers.authorization, expected)) {
      return reply(res, 401, "missing or invalid bearer token", { "www-authenticate": 'Bearer realm="iphone-agent"' });
    }
    // Stateless: no sessions, so no server-initiated stream on GET and nothing to DELETE.
    if (req.method !== "POST") return reply(res, 405, "method not allowed", { allow: "POST" });
    // A Server binds one transport, so stateless mode builds both per request. The device is shared.
    const server = createPhoneMcpServer(device, { readOnly });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => void server.close());
    // @ts-expect-error SDK 1.32 typings: the Node transport's onclose/onerror/onmessage accessors return `T | undefined`, which `Transport`'s optional props reject under exactOptionalPropertyTypes. Runtime shape matches.
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) reply(res, 500, err instanceof Error ? err.message : String(err));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, host, () => resolve());
  });
  // SAFETY: listen() on a TCP host/port always reports an AddressInfo, never a pipe path string.
  const { port } = http.address() as AddressInfo;
  const shown = WILDCARDS.has(host) ? "127.0.0.1" : asHostname(host);
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
