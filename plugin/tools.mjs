/**
 * OpenViking's tool surface, exposed as *native* MiMo tools.
 *
 * The user's explicit choice is native tools over an MCP registration, so this
 * module drives `@mimo-ai/plugin`'s `tool()` directly and talks to OV's `/mcp`
 * JSON-RPC endpoint with `fetch` — no MCP SDK dependency.
 *
 * Definitions are data, not code: `plugin/ov-tools.schema.json` is generated
 * from the live server by `scripts/capture-tool-schemas.mjs`, and the zod arg
 * shapes below are converted from the server's own JSON Schema so a rename or a
 * new enum value in OV shows up as a reviewable file diff.
 *
 * Naming: every tool is prefixed `ov_` (e.g. `ov_search`) so it cannot collide
 * with MiMo's built-ins (`read`, `grep`, `glob`, `write`, `edit`, `bash`).
 *
 * Error handling is by contract: `execute` never throws. A failed OV call
 * returns a human-readable string, which the engine feeds back to the model as
 * the tool result — the model can retry or route around it, whereas a throw
 * would abort the step.
 */

import { readFileSync, statSync } from "node:fs";

import { z } from "zod";

import { defaultCredentialPaths } from "../lib/mcp-proxy-config.mjs";
import { openMcpSession, renderToolResult } from "./mcp-client.mjs";

/** Read once at load; a missing file leaves the tool surface empty, not broken. */
function loadSchema() {
  try {
    return JSON.parse(readFileSync(new URL("./ov-tools.schema.json", import.meta.url), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Convert one JSON-Schema property into a zod type.
 *
 * Covers what OV actually publishes (string / integer / number / boolean /
 * enum / array / object-with-additionalProperties) and degrades to
 * `z.unknown()` for anything else, so a future schema addition degrades one
 * argument instead of failing the whole plugin load.
 */
export function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== "object") return z.unknown();
  let type;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((v) => typeof v === "string");
    // Mixed/typed enums fall back to a bare literal so the value survives.
    type = values.length === schema.enum.length ? z.enum(values) : z.unknown();
  } else if (schema.type === "string") {
    type = z.string();
  } else if (schema.type === "integer") {
    type = z.number().int();
  } else if (schema.type === "number") {
    type = z.number();
  } else if (schema.type === "boolean") {
    type = z.boolean();
  } else if (schema.type === "array") {
    type = z.array(jsonSchemaToZod(schema.items));
  } else if (schema.type === "object") {
    type = schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? z.record(z.string(), jsonSchemaToZod(schema.additionalProperties))
      : z.record(z.string(), z.unknown());
  } else {
    type = z.unknown();
  }

  const meta = {};
  if (typeof schema.description === "string" && schema.description.trim()) {
    meta.description = schema.description;
  }
  if (schema.default !== undefined) meta.default = schema.default;
  if (Object.keys(meta).length > 0 && typeof type.meta === "function") {
    type = type.meta(meta);
  }
  return type;
}

/** Build the zod raw shape `tool()` expects from one server tool definition. */
export function buildArgShape(definition) {
  const schema = definition?.inputSchema && typeof definition.inputSchema === "object"
    ? definition.inputSchema
    : {};
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape = {};
  for (const [name, prop] of Object.entries(properties)) {
    let field = jsonSchemaToZod(prop);
    // Every field the server did not mark required must be `.optional()`, and
    // only that. Two traps sit next to each other here:
    //
    //   1. `.default(undefined)` is not a no-op in zod 4 — it sets
    //      `defaultValue: undefined`, and the engine's JSON Schema generator
    //      then dies on `JSON.parse(JSON.stringify(undefined))` with
    //      `"undefined" is not valid JSON` before the first model request.
    //   2. `.default(x)` makes the field *required* in the emitted JSON Schema
    //      (verified against the engine), which would force the model to invent
    //      values the server already defaults — `ov_health()` would become
    //      uncallable and `ov_list({uri})` would demand every unset knob.
    //
    // So the server's default is carried as `.meta({default})` (documentation
    // the model can read) while optionality is carried by `.optional()`.
    if (!required.has(name)) field = field.optional();
    shape[name] = field;
  }
  return shape;
}

/**
 * Snapshot the credential files' identity (mtime + size) so a rotated api_key
 * or a moved server URL is noticed by a long-lived in-process plugin.
 *
 * The path list comes from the shared `defaultCredentialPaths`, which is the
 * same set the stdio proxy watches — the two must not drift, or `ovcli.conf`
 * edits would work for one host integration and not the other.
 */
function snapshotCredentials(env = process.env) {
  const out = new Map();
  for (const path of defaultCredentialPaths(env)) {
    try {
      const stat = statSync(path);
      out.set(path, `${stat.mtimeMs}:${stat.size}`);
    } catch {
      out.set(path, "missing");
    }
  }
  return out;
}

function credentialsChanged(before, after) {
  if (before.size !== after.size) return true;
  for (const [path, stamp] of before) {
    if (after.get(path) !== stamp) return true;
  }
  return false;
}

/**
 * Build MiMo's tool map from the captured schema, wiring each tool to a live
 * `tools/call`.
 *
 * One MCP session is cached so a tool call does not pay a fresh handshake. The
 * credential files are re-snapshotted before reuse and the session is rebuilt
 * when they change, because an in-process plugin has no process boundary to
 * restart: without this, editing `ovcli.conf` would need a full MiMo restart.
 * The shared proxy solves the same problem the same way.
 *
 * @param {object} opts
 * @param {Function} opts.reloadConfig - returns a freshly resolved hook config
 */
export function buildOpenVikingTools({
  cfg,
  reloadConfig = null,
  log = () => {},
  logError = () => {},
}) {
  const data = loadSchema();
  if (!data || !Array.isArray(data.tools)) {
    logError("tools", new Error("plugin/ov-tools.schema.json missing or malformed; OV tools disabled"));
    return {};
  }

  let activeCfg = cfg;
  let credentials = snapshotCredentials();
  let session = null;
  let sessionPromise = null;

  /** Re-read credentials; drop the cached session when they moved. */
  function refreshCredentials() {
    const next = snapshotCredentials();
    if (!credentialsChanged(credentials, next)) return false;
    credentials = next;
    if (!reloadConfig) return false;
    try {
      activeCfg = reloadConfig() || activeCfg;
    } catch (error) {
      logError("tools_reload", error);
      return false;
    }
    session?.close?.().catch(() => {});
    session = null;
    sessionPromise = null;
    log("tools_credentials_reloaded", {
      mcpUrl: activeCfg.mcpUrl,
      credentialSource: activeCfg.credentialSource,
      hasApiKey: Boolean(activeCfg.apiKey),
    });
    return true;
  }

  async function sessionFor() {
    refreshCredentials();
    if (session?.ok) return session;
    if (!sessionPromise) {
      sessionPromise = openMcpSession(activeCfg)
        .then((next) => {
          session = next;
          sessionPromise = null;
          if (!next.ok) log("tools_session_failed", { error: next.error });
          else log("tools_session_ready", { mcpUrl: next.mcpUrl, tools: data.tools.length });
          return next;
        })
        .catch((error) => {
          sessionPromise = null;
          logError("tools_session", error);
          return { ok: false, error: error?.message || String(error) };
        });
    }
    return sessionPromise;
  }

  const tools = {};
  for (const definition of data.tools) {
    const name = `ov_${definition.name}`;
    tools[name] = {
      description: buildDescription(definition),
      args: buildArgShape(definition),
      execute: async (args) => {
        try {
          const live = await sessionFor();
          if (!live.ok) {
            // Drop the dead session so the next call retries the handshake
            // rather than replaying a cached failure for the whole session.
            session = null;
            return `OpenViking is unreachable: ${live.error}. Check ~/.openviking/ovcli.conf and that the server is up.`;
          }
          const res = await live.callTool(definition.name, args || {});
          if (!res.ok) {
            session = null;
            return `OpenViking tool "${definition.name}" failed: ${res.error}`;
          }
          const text = renderToolResult(res.result);
          return text || `OpenViking tool "${definition.name}" returned no content.`;
        } catch (error) {
          logError(`tool:${name}`, error);
          return `OpenViking tool "${definition.name}" failed: ${error?.message || String(error)}`;
        }
      },
    };
  }

  log("tools_registered", { count: Object.keys(tools).length, names: Object.keys(tools) });
  return tools;
}

/**
 * The server descriptions are multi-paragraph ("Args:\n uri: ..."), which is
 * useful documentation but noisy in a tool list. Keep the first paragraph and
 * append the routing hint the skill teaches, so the model sees a consistent
 * `ov_*` surface without losing the server's own wording.
 */
function buildDescription(definition) {
  const raw = String(definition.description || "").trim();
  const firstParagraph = raw.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ").trim();
  const body = firstParagraph || `OpenViking ${definition.name}.`;
  return `${body}\n\nOpenViking tool (name in the OV toolset: \`${definition.name}\`). viking:// URIs only — they are not local filesystem paths.`;
}
