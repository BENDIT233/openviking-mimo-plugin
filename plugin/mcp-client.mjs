/**
 * Minimal JSON-RPC 2.0 client for OpenViking's `/mcp` streamable-HTTP endpoint.
 *
 * Deliberately dependency-free: the plugin already ships `@mimo-ai/plugin` and
 * `zod`, and the brief forbids pulling in an MCP SDK. This is the same wire
 * contract `lib/mcp-proxy-core.mjs` speaks for stdio hosts, reduced to what an
 * in-process native tool needs:
 *
 *   initialize -> notifications/initialized -> tools/list | tools/call
 *
 * The server answers either `application/json` or `text/event-stream`; both are
 * parsed here. Nothing in this module throws out to the host — callers get
 * `{ ok:false, error }` and render that as a string for the model.
 */

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 20000;

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

/** Parse a `text/event-stream` body into the JSON messages it carries. */
function parseSseMessages(text) {
  const messages = [];
  let dataLines = [];

  function flush() {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      messages.push(JSON.parse(data));
    } catch {
      /* a malformed frame is skipped, not fatal */
    }
  }

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    if (rawLine === "") { flush(); continue; }
    if (rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  }
  flush();
  return messages;
}

function parseBody(contentType, text) {
  if (!String(text || "").trim()) return [];
  if (String(contentType || "").toLowerCase().includes("text/event-stream")) {
    return parseSseMessages(text);
  }
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

/**
 * Create a live MCP session against one config object.
 *
 * `initialize` is sent without a session header, and whatever `Mcp-Session-Id`
 * the server returns is carried on every later request. Callers own the
 * lifecycle and must `close()` — the plugin caches one session per base URL so
 * a tool call does not pay a fresh handshake each time.
 */
export async function openMcpSession(cfg, options = {}) {
  const mcpUrl = cfg.mcpUrl || `${trimSlash(cfg.baseUrl)}/mcp`;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS);
  let sessionId = "";
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  let closed = false;

  function headers(includeSession = true) {
    const out = {
      "Content-Type": "application/json",
      // Always the negotiated version, never the client's un-negotiated ask:
      // strict upstreams reject a mismatch with HTTP 400 before negotiation.
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
    };
    if (includeSession && sessionId) out["Mcp-Session-Id"] = sessionId;
    if (cfg.apiKey) out.Authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.account) out["X-OpenViking-Account"] = cfg.account;
    if (cfg.user) out["X-OpenViking-User"] = cfg.user;
    if (cfg.peerId) out["X-OpenViking-Actor-Peer"] = cfg.peerId;
    if (cfg.userAgent) out["User-Agent"] = cfg.userAgent;
    return out;
  }

  async function post(message, { includeSession = true, requestTimeoutMs } = {}) {
    const controller = new AbortController();
    const budget = Math.max(1000, Number(requestTimeoutMs) || timeoutMs);
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: headers(includeSession),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const text = await res.text();
      const messages = parseBody(res.headers.get("content-type"), text);
      const nextSession = res.headers.get("mcp-session-id");
      if (nextSession) sessionId = nextSession;
      if (!res.ok) {
        return { ok: false, status: res.status, error: res.statusText || `HTTP ${res.status}`, messages };
      }
      return { ok: true, status: res.status, messages };
    } catch (error) {
      const aborted = error?.name === "AbortError";
      return {
        ok: false,
        status: 0,
        error: aborted ? `timed out after ${budget}ms` : (error?.message || String(error)),
        messages: [],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(method, params = {}, options2 = {}) {
    const id = options2.id || `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await post({ jsonrpc: "2.0", id, method, params }, options2);
    if (!res.ok) return { ok: false, status: res.status, error: res.error };
    const answer = res.messages.find((m) => m && m.id === id)
      || res.messages.find((m) => m && (m.result !== undefined || m.error !== undefined));
    if (!answer) return { ok: false, status: res.status, error: "empty MCP response" };
    if (answer.error) {
      return {
        ok: false,
        status: res.status,
        error: answer.error.message || JSON.stringify(answer.error),
        code: answer.error.code,
      };
    }
    return { ok: true, status: res.status, result: answer.result };
  }

  const init = await request("initialize", {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "openviking-memory-mimo", version: "0.1.0" },
  }, { includeSession: false });

  if (!init.ok) {
    return {
      ok: false,
      mcpUrl,
      protocolVersion,
      sessionId,
      error: init.error,
      async close() {},
      async listTools() { return { ok: false, error: init.error, tools: [] }; },
      async callTool() { return { ok: false, error: init.error }; },
    };
  }
  if (typeof init.result?.protocolVersion === "string") {
    protocolVersion = init.result.protocolVersion;
  }

  // A notification carries no id and expects no answer; failure is not fatal.
  await post(
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { includeSession: true },
  ).catch(() => {});

  return {
    ok: true,
    mcpUrl,
    protocolVersion,
    sessionId,
    get closed() { return closed; },
    async listTools() {
      const res = await request("tools/list", {});
      if (!res.ok) return { ok: false, error: res.error, tools: [] };
      return { ok: true, tools: res.result?.tools || [] };
    },
    async callTool(name, args = {}) {
      const res = await request("tools/call", { name, arguments: args }, { timeoutMs });
      if (!res.ok) return { ok: false, error: res.error, code: res.code };
      return { ok: true, result: res.result };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!sessionId) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        await fetch(mcpUrl, { method: "DELETE", headers: headers(true), signal: controller.signal });
      } catch {
        /* best effort */
      } finally {
        clearTimeout(timer);
        sessionId = "";
      }
    },
  };
}

/**
 * Flatten an MCP `tools/call` result into the text a MiMo tool returns.
 *
 * `content` is the MCP-standard array of `{type:"text",text}` blocks, and that
 * is the answer for every tool OV ships — verified against all of
 * `health`/`list`/`tree`/`find`. `structuredContent` duplicates the same value
 * verbatim, so appending it unconditionally would double the tool result and
 * spend the model's context twice on identical bytes.
 *
 * It is therefore used only as a *fallback*: when `content` carried no text at
 * all, the structured payload is the only thing left worth returning.
 */
export function renderToolResult(result) {
  if (!result || typeof result !== "object") return "";
  const chunks = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string" && block.text.trim()) chunks.push(block.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (text) return text;

  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && Object.keys(structured).length > 0) {
    return JSON.stringify(structured, null, 2);
  }
  return JSON.stringify(result, null, 2);
}
