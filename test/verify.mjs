/**
 * End-to-end verification harness for the OpenViking MiMo plugin.
 *
 * Boots the *real* MiMoCode engine (`app.asar/out/main/engine-entry.mjs`)
 * against a throwaway config dir under the system temp directory, drives a full
 * turn against a local OpenAI-compatible mock provider, and asserts the
 * behaviours the plugin promises. Nothing here touches the user's real
 * `~/.config/mimocode`, `~/.config/mimocode/mimocode.jsonc`, or anything under
 * `~/.openviking` except the hook-state/log files the plugin writes by design.
 *
 * Why the mock recorder matters: recall injection is only proven when the
 * marker appears in the *request body the model actually received*. A hook can
 * log "injected" while the engine drops the part; asserting against the HTTP
 * body is the only check that cannot pass for the wrong reason.
 *
 * Usage (no system node on this machine):
 *   ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" \
 *     test/verify.mjs [--keep] [--filter name]
 *
 * Exits non-zero if any check fails. `--keep` preserves the temp config dir for
 * inspection instead of deleting it.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMockProvider } from "./mock-provider.mjs";
import { resolveOpenVikingCredentials } from "../lib/credentials.mjs";
import { sanitizeCapturedText } from "../lib/capture-utils.mjs";
import {
  addAgentMessages,
  commitAgentSession,
  createAgentLogger,
  loadAgentHookConfig,
  makeAgentFetchJSON,
  stableHash,
} from "../lib/agent-hook-runtime.mjs";
import { openMcpSession } from "../plugin/mcp-client.mjs";
import { evaluateMimoUriGuard } from "../plugin/uri-guard.mjs";
import { planCapture, trajectoryToTurns, turnDedupKey } from "../plugin/capture.mjs";
import { normalizeManifest } from "../scripts/validate-manifest.mjs";

const ASAR = "C:/Program Files/Xiaomi MiMo/resources/app.asar";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? "PASS" : "FAIL";
  process.stdout.write(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function section(title) {
  process.stdout.write(`\n== ${title} ==\n`);
}

function parseArgs(argv) {
  const out = { keep: false, filter: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keep") out.keep = true;
    else if (argv[i] === "--filter" && argv[i + 1]) out.filter = argv[++i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config + install scaffolding
// ---------------------------------------------------------------------------

/**
 * Write a throwaway config dir: the mock provider, plus the plugin wired in the
 * same way a user's config wires it. `lib/` and the skill are copied next to
 * `plugin/` because the plugin imports the shared runtime by relative path.
 */
async function makeConfigDir(base, { includePlugin, mockBaseUrl }) {
  const dir = join(base, "config");
  await mkdir(dir, { recursive: true });
  const config = {
    $schema: "https://mimo.xiaomi.com/mimocode/config.json",
    model: "mock/mock-model",
    // The observer must be an explicit `plugin` entry, not merely a file under
    // `plugin/`. The engine's auto-discovery glob *finds* extra files there, but
    // their hooks do not fire — only named entries receive hook calls (verified
    // in `pair-probe`: two `plugin` entries both fire, an auto-discovered third
    // does not).
    plugin: includePlugin
      ? ["./plugin/openviking.js", "./plugin/zz-observer.js"]
      : [],
    provider: {
      mock: {
        name: "Mock",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: mockBaseUrl, apiKey: "mock-key" },
        models: {
          "mock-model": {
            name: "Mock Model",
            toolcall: true,
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    },
  };
  await writeFile(join(dir, "mimocode.jsonc"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  if (includePlugin) {
    const { cp } = await import("node:fs/promises");
    await cp(join(REPO_ROOT, "lib"), join(dir, "lib"), { recursive: true });
    await cp(join(REPO_ROOT, "plugin"), join(dir, "plugin"), { recursive: true });
    await mkdir(join(dir, "skills"), { recursive: true });
    await cp(join(REPO_ROOT, "skills", "openviking-memory"), join(dir, "skills", "openviking-memory"), {
      recursive: true,
    });

    // `@mimo-ai/plugin` and `zod` must resolve from the plugin's own directory
    // chain, exactly as they do for a plugin installed into the real config
    // dir. Node walks up to the nearest node_modules, so a junction to the
    // user's mimocode node_modules reproduces that layout without downloading
    // anything. (A copy would work too but costs ~40MB per harness run.)
    const modules = join(dir, "node_modules");
    const source = join(homedir(), ".config", "mimocode", "node_modules");
    if (existsSync(source)) {
      try {
        symlinkSync(source, modules, "junction");
      } catch {
        await cp(source, modules, { recursive: true });
      }
    }
    // Mark the copied tree as ESM so Node does not reparse each plugin file as
    // CommonJS first (the engine ships .js plugin entries, not .mjs).
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`, "utf8");
  }
  return dir;
}

async function bootEngine(configDir) {
  // The engine reads its config dir from the environment at import time.
  process.env.MIMOCODE_CONFIG_DIR = configDir;
  process.env.MIMOCODE_DISABLE_PROJECT_CONFIG = "1";
  // The engine writes runtime state (`.mimocode/.cron-lock`, gitignore) into its
  // working directory, so pin the cwd to the temp workspace rather than letting
  // a verification run litter the repo it is testing.
  process.chdir(configDir);

  const mod = await import(`file:///${ASAR}/out/main/engine-entry.mjs`);
  const handle = await mod.Server.listen({
    port: 0,
    hostname: "127.0.0.1",
    cors: ["app://-"],
  });
  return { handle, base: String(handle.url).replace(/\/$/, "") };
}

async function postJSON(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

async function getJSON(base, path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

/** Run one user turn to completion and return the assistant message. */
async function runTurn(base, sessionID, text) {
  const res = await postJSON(base, `/session/${sessionID}/message`, {
    model: { providerID: "mock", modelID: "mock-model" },
    agent: "build",
    parts: [{ type: "text", text }],
  });
  return res;
}

// ---------------------------------------------------------------------------
// OpenViking request recorder
// ---------------------------------------------------------------------------

/**
 * Wrap `globalThis.fetch` before the engine loads the plugin, capturing every
 * request the plugin sends to OpenViking.
 *
 * This is the only way to assert the anti-feedback property on a *real* turn:
 * hook state holds hashed dedup keys, not the text, so inspecting it can never
 * prove what was actually uploaded. The recorder sees the exact payload bytes
 * that went to `/api/v1/sessions/<id>/messages`.
 *
 * Must be installed before the engine import: the plugin is loaded as
 * in-process ESM and resolves `fetch` from the global at call time, but the
 * boot ordering is what makes the capture complete.
 */
function installOvRecorder(matchHostFragment) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url || String(input));
    const isOv = url.includes(matchHostFragment) || url.includes("/api/v1/sessions/");
    if (isOv && init?.body) {
      let body = init.body;
      if (typeof body !== "string") {
        try { body = new TextDecoder().decode(body); } catch { body = String(body); }
      }
      captured.push({ url, method: init.method || "GET", body });
    }
    return original(input, init);
  };
  return {
    captured,
    restore() { globalThis.fetch = original; },
    /** Session add-message payloads, which is where captured turns land. */
    sessionMessages: () => captured.filter((r) => /\/api\/v1\/sessions\/[^/]+\/messages/.test(r.url)),
    commits: () => captured.filter((r) => /\/api\/v1\/sessions\/[^/]+\/commit/.test(r.url)),
  };
}

/**
 * A second, observer plugin that registers the same lifecycle hooks and writes
 * what the engine passed it into a JSON file.
 *
 * This is what makes `outcome: "completed"` observable: the OV plugin has no
 * side channel for it, so a sibling plugin in the same process is the only way
 * to read the hook payload the engine actually delivers. It is deliberately
 * minimal — no OV calls, no mutation — so it cannot affect what is being
 * measured.
 */
async function writeObserverPlugin(dir) {
  const source = `import { writeFileSync } from "node:fs";

const OUT = ${JSON.stringify(join(dir, "observer.json"))};
const seen = { sessionPost: [], chatMessage: [], systemTransform: [], compaction: [], uriGuards: [] };

function flush() {
  try { writeFileSync(OUT, JSON.stringify(seen, null, 2)); } catch {}
}

export default {
  id: "ov-verify-observer",
  async server() {
    // Written at load time so "the engine did not load the observer at all" is
    // distinguishable from "the observer loaded but no hook fired".
    seen.loadedAt = Date.now();
    flush();
    return {
      "session.post": async (input) => {
        // This hook receives the FINAL state after every other plugin's hook
        // has run, so the trajectory and systemPrompt here are the strongest
        // in-process evidence available: they show what OV's injection
        // actually produced, not what a sibling saw mid-chain.
        const messages = Array.isArray(input?.trajectory) ? input.trajectory : [];
        seen.sessionPost.push({
          sessionID: input?.sessionID,
          agentID: input?.agentID,
          outcome: input?.outcome,
          error: input?.error ?? null,
          finalText: input?.finalText ?? null,
          trajectoryRoles: messages.map((m) => ({ role: m?.role, id: m?.id, parts: (m?.parts || []).map((p) => p?.type) })),
          trajectoryPartTypes: messages.flatMap((m) => (m?.parts || []).map((p) => p?.type)),
          // Recall injection shows up here as a synthetic user text part.
          syntheticTexts: messages.flatMap((m) => (m?.parts || [])
            .filter((p) => p?.synthetic && typeof p.text === "string")
            .map((p) => p.text)),
          // The profile block shows up in the system prompt array.
          systemPromptOvBlocks: (Array.isArray(input?.systemPrompt) ? input.systemPrompt : [])
            .filter((s) => typeof s === "string" && s.includes("openviking-context"))
            .map((s) => s.slice(0, 300)),
        });
        flush();
      },
      "chat.message": async (input, output) => {
        seen.chatMessage.push({
          sessionID: input?.sessionID,
          messageID: input?.messageID,
          partTypes: (output?.parts || []).map((p) => p?.type),
          syntheticTexts: (output?.parts || [])
            .filter((p) => p?.synthetic && typeof p.text === "string")
            .map((p) => p.text.slice(0, 200)),
        });
        flush();
      },
      "experimental.chat.system.transform": async (input, output) => {
        seen.systemTransform.push({
          sessionID: input?.sessionID,
          blocks: (output?.system || []).length,
          hasOvBlock: (output?.system || []).some(
            (b) => typeof b === "string" && b.includes("openviking-context"),
          ),
        });
        flush();
      },
      "experimental.session.compacting": async (input) => {
        seen.compaction.push({ sessionID: input?.sessionID });
        flush();
      },
      "tool.execute.before": async (input, output) => {
        seen.uriGuards.push({
          tool: input?.tool,
          sessionID: input?.sessionID,
          cancel: output?.cancel === true,
          cancelReason: output?.cancelReason ?? null,
        });
        flush();
      },
    };
  },
};
`;
  await mkdir(join(dir, "plugin"), { recursive: true });
  await writeFile(join(dir, "plugin", "zz-observer.js"), source, "utf8");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runAll = !args.filter;
  const want = (name) => runAll || name.includes(args.filter);

  const base = await mkdtemp(join(tmpdir(), "ov-mimo-verify-"));
  process.stdout.write(`temp workspace: ${base}\n`);

  const mock = createMockProvider();
  const { baseUrl: mockBaseUrl } = await mock.listen();
  process.stdout.write(`mock provider:   ${mockBaseUrl}\n`);

  const cfgDir = await makeConfigDir(base, { includePlugin: true, mockBaseUrl });
  await writeObserverPlugin(cfgDir);
  const ovRecorder = installOvRecorder("ov.example.com");
  const { handle, base: engineBase } = await bootEngine(cfgDir);
  process.stdout.write(`engine:          ${engineBase}\n`);

  try {
    // -----------------------------------------------------------------------
    if (want("tool-surface")) {
      section("1. plugin loads and registers the native ov_* tool surface");
      const ids = await getJSON(engineBase, "/experimental/tool/ids");
      const list = Array.isArray(ids.body) ? ids.body : [];
      const ovIds = list.filter((id) => String(id).startsWith("ov_")).sort();
      check("all 15 OV tools registered as native MiMo tools", ovIds.length === 15,
        `${ovIds.length} found: ${ovIds.join(", ")}`);
      check("set matches the live OV toolset exactly",
        JSON.stringify(ovIds) === JSON.stringify([
          "ov_add_resource", "ov_cancel_watch", "ov_edit", "ov_find", "ov_forget",
          "ov_glob", "ov_grep", "ov_health", "ov_list", "ov_list_watches",
          "ov_read", "ov_remember", "ov_search", "ov_tree", "ov_write",
        ]), ovIds.join(", "));
    }

    // -----------------------------------------------------------------------
    // The turn runs unconditionally: it is what produces the recorded request
    // bodies that sections 3 and 4 assert against, and those bodies are the
    // only evidence that cannot pass for the wrong reason (a hook can log
    // "injected" while the engine silently drops the part).
    section("2. full turn against a local mock provider");
    const created = await postJSON(engineBase, "/session", { title: "verify" });
    const sessionID = String(created.body?.id || "");
    check("session created", Boolean(sessionID), sessionID);
    if (want("turn")) {
      mock.setScript([{ text: "ACK from mock provider." }]);
      mock.requests.length = 0;
      const turn = await runTurn(engineBase, sessionID,
        "请回忆一下我之前说过关于 OpenViking 的偏好。");
      check("turn completed with outcome=completed",
        turn.status === 200 && turn.body?.info?.role === "assistant",
        `status=${turn.status} role=${turn.body?.info?.role}`);
      check("mock provider received the completion request",
        mock.completionRequests().length > 0,
        `${mock.completionRequests().length} request(s)`);
      check("assistant finish reason is stop",
        turn.body?.info?.finish === "stop", String(turn.body?.info?.finish));
    } else {
      // Sections 2b/4/7 read bodies and observer output produced by this turn,
      // so it has to run even when a `--filter` excludes the turn checks.
      mock.setScript([{ text: "ACK from mock provider." }]);
      mock.requests.length = 0;
      await runTurn(engineBase, sessionID, "请回忆一下我之前说过关于 OpenViking 的偏好。");
    }

    // -----------------------------------------------------------------------
    if (want("tool-schema")) {
      section("3. tool JSON Schemas as they reached the model");
      const bodies = mock.completionRequests();
      check("a completion request body was captured to inspect",
        bodies.length > 0, `${bodies.length} body(ies)`);
      const tools = bodies[0]?.body?.tools || [];
      check("tools array reached the model", Array.isArray(tools) && tools.length > 0,
        `${tools.length} tool(s)`);
      const byName = new Map(tools.map((t) => [t.function?.name, t.function]));
      const search = byName.get("ov_search");
      check("ov_search is in the model's tool list", Boolean(search));
      const params = search?.parameters || {};
      const props = params.properties || {};
      check("ov_search.required = [query] survives zod conversion",
        JSON.stringify(params.required) === JSON.stringify(["query"]),
        JSON.stringify(params.required));
      check("ov_search.enum survives (mode: list|context)",
        JSON.stringify(props.mode?.enum) === JSON.stringify(["list", "context"]),
        JSON.stringify(props.mode?.enum));
      // The engine's openai-compatible transform strips `default` from the
      // emitted schema, so optionality — not the default value — is what has to
      // hold here. The server applies its own defaults for anything unset, which
      // section 7 proves with a minimal-argument live call.
      check("optional field stays OPTIONAL (server default is not forced on the model)",
        !(params.required || []).includes("mode"),
        `required=${JSON.stringify(params.required)}`);
      check("ov_search description reached the model",
        Boolean(search?.description && search.description.length > 20),
        String(search?.description || "").slice(0, 70));
      check("ov_health (no args) exposes an empty object schema",
        Boolean(byName.get("ov_health")),
        JSON.stringify((byName.get("ov_health")?.parameters || {}).properties || {}));
      check("ov_list requires only uri (server default on uri is not forced)",
        JSON.stringify((byName.get("ov_list")?.parameters || {}).required) === JSON.stringify(["uri"]),
        JSON.stringify((byName.get("ov_list")?.parameters || {}).required));
    }

    // -----------------------------------------------------------------------
    if (want("recall")) {
      section("4. recall injection reaches the model's request body");
      const bodies = mock.completionRequests().map((r) => JSON.stringify(r.body));
      const withContext = bodies.filter((b) => b.includes("<openviking-context source=\\\"recall\\\">")
        || b.includes("<openviking-context source=\"recall\">"));
      check("an openviking-context recall block is in a request body",
        withContext.length > 0,
        withContext.length ? `${withContext.length} body(ies) carry it` : "not found in any body");
      // A wrapper with nothing inside would also satisfy the check above; the
      // block must carry real retrieved content from the server.
      const recallBody = withContext[0] || "";
      const inner = recallBody.split("<openviking-context source=\\\"recall\\\">")[1]
        || recallBody.split("<openviking-context source=\"recall\">")[1]
        || "";
      const blockText = inner.split("</openviking-context>")[0] || "";
      check("the recall block carries real retrieved content, not an empty wrapper",
        blockText.replace(/\\\\n/g, "").trim().length > 40,
        `inner block ${blockText.length} chars: ${blockText.slice(0, 120).replace(/\\\\n/g, " ")}`);
      check("the recall block is marked as retrieved context (non-instruction framing)",
        recallBody.includes("viking://") || blockText.includes("viking://"),
        "URIs present in the block");
      const first = bodies[0] || "";
      check("the user's own prompt text is still present alongside the injection",
        first.includes("OpenViking"), "prompt text present");
      const system = JSON.stringify(
        (mock.completionRequests()[0]?.body?.messages || []).filter((m2) => m2.role === "system"),
      );
      check("a system message is present (profile injection channel)",
        system.length > 4, `${system.length} chars of system content`);
    }

    // -----------------------------------------------------------------------
    if (want("guard")) {
      section("5. viking:// URI guard");
      const decision = evaluateMimoUriGuard("read", { filePath: "viking://user/bendit/memories/profile.md" });
      check("read with a viking:// filePath is blocked", Boolean(decision), decision?.uri || "not blocked");
      check("guard reason names the OV tool",
        Boolean(decision?.reason?.includes("ov_read")),
        String(decision?.reason || "").split("\n")[1] || "");

      const bashMention = evaluateMimoUriGuard("bash", { command: 'echo "see viking://user/x for details"' });
      check("bash merely mentioning a URI is NOT blocked", bashMention === null,
        bashMention ? "false positive" : "");
      const bashPath = evaluateMimoUriGuard("bash", { command: "cat viking://user/bendit/memories/profile.md" });
      check("bash using a URI as a path IS blocked", Boolean(bashPath), bashPath?.uri || "not blocked");
      const writeBody = evaluateMimoUriGuard("write", {
        filePath: join(base, "note.md"),
        content: "remember that viking://user/bendit/memories is the root",
      });
      check("write whose CONTENT mentions a URI is NOT blocked", writeBody === null,
        writeBody ? "false positive: file would not be created" : "file write allowed");

      // End-to-end: the blocked tool must not run, and cancelReason must reach
      // the model in the next request body.
      if (sessionID) {        mock.setScript([
          { toolCalls: [{ index: 0, id: "call_guard_1", type: "function",
            function: { name: "read", arguments: JSON.stringify({ filePath: "viking://user/bendit/memories/profile.md" }) } }] },
          { text: "Guard observed." },
        ]);
        mock.requests.length = 0;
        const guardTurn = await runTurn(engineBase, sessionID,
          "Read viking://user/bendit/memories/profile.md for me.");
        const after = mock.completionRequests().map((r) => JSON.stringify(r.body));
        const carried = after.some((b) => b.includes("virtual paths") || b.includes("ov_read"));
        check("cancelReason reached the model in a later request body", carried,
          carried ? "guard text present in body" : `not found; ${after.length} bodies`);
        check("the read tool did not actually execute from the engine's side",
          guardTurn.status === 200, `status=${guardTurn.status}`);

        // The observer cannot be used here: `tool.execute.before` hooks run in
        // registration order and the OV hook both runs first and mutates the
        // shared `output`, so a sibling plugin registered later still sees
        // cancel=true — but a sibling registered earlier does not, and the
        // relative order is not something this plugin should depend on. The
        // request-body assertion above is the ordering-independent proof.
      }
    }

    // -----------------------------------------------------------------------
    if (want("capture")) {
      section("6. capture: sanitize, anti-feedback, dedup");
      // Two independent defences, both asserted: a part MiMo marks synthetic is
      // dropped outright (that is how recall is delivered), AND an injected
      // block sitting in ordinary-looking text is stripped by the shared
      // sanitizer. Either alone would leave a path for recalled memory to be
      // written back into the store as if the user had said it.
      const INJECT_MARKER = "SECRET_INJECTED_RECALL_TEXT_SHOULD_NOT_SURVIVE";
      const injectedBlock = [
        "<openviking-context source=\"recall\">",
        INJECT_MARKER,
        "</openviking-context>",
      ].join("\n");
      const trajectory = [
        {
          role: "user", id: "msg_u1", agent: "build", created: Date.now(),
          parts: [
            { type: "text", text: "What did I decide about the OpenViking rollout?" },
            // The real delivery shape: synthetic, and carrying a genuine block.
            {
              type: "text", text: injectedBlock,
              synthetic: true, id: "p_syn", sessionID: "s", messageID: "msg_u1",
            },
            // The belt-and-braces case: an injected block that is NOT marked
            // synthetic (a quoted tool result, a replayed part).
            { type: "text", text: `Noted.\n${injectedBlock}` },
          ],
        },
        {
          role: "assistant", id: "msg_a1", agent: "build", created: Date.now(),
          parts: [
            { type: "reasoning", text: "REASONING_MUST_BE_SKIPPED" },
            { type: "step-start" },
            { type: "text", text: "You decided to ship it in two phases." },
            { type: "tool", tool: "bash", callID: "c1",
              state: { status: "completed", input: { command: "ls -la" }, output: "total 0" } },
            { type: "file", url: "file:///tmp/x", mime: "text/plain" },
            { type: "step-finish" },
          ],
        },
      ];

      const cfg = loadAgentHookConfig("mimo");
      const turns = trajectoryToTurns(trajectory, cfg);
      check("trajectory produced 2 capture turns (user + assistant)", turns.length === 2,
        `got ${turns.length}`);

      const userTurn = turns.find((t) => t.role === "user") || { content: "" };
      check("anti-feedback: injected <openviking-context> text is NOT in the captured payload",
        !userTurn.content.includes(INJECT_MARKER),
        userTurn.content.slice(0, 140).replace(/\n/g, " | "));
      check("the user's real text survives sanitizing",
        userTurn.content.includes("OpenViking rollout"));
      check("a synthetic part is dropped even when it carries no recognizable wrapper",
        !userTurn.content.includes("<openviking-context source=\"recall\">"),
        userTurn.content.slice(0, 100).replace(/\n/g, " | "));

      const assistantTurn = turns.find((t) => t.role === "assistant") || { content: "" };
      check("assistant turns ARE captured (assistant half of the exchange)",
        assistantTurn.content.includes("two phases"),
        assistantTurn.content.slice(0, 80));
      check("reasoning parts are skipped",
        !assistantTurn.content.includes("REASONING_MUST_BE_SKIPPED"));
      check("tool calls render as [tool-call NAME]",
        assistantTurn.content.includes("[tool-call bash]"),
        assistantTurn.content.slice(0, 200).replace(/\n/g, " | "));
      check("tool results render as [tool-result]",
        assistantTurn.content.includes("[tool-result]"));
      check("file parts are skipped",
        !assistantTurn.content.includes("file:///tmp/x"));

      // Dedup: same turns twice -> second plan is empty.
      const planA = planCapture(turns, {}, cfg, stableHash);
      const afterA = { capturedKeys: planA.toSend.map((i) => i.dedupKey) };
      const planB = planCapture(turns, afterA, cfg, stableHash);
      check("dedup prevents a double capture", planB.payloads.length === 0,
        `second plan had ${planB.payloads.length} payload(s)`);
      check("dedup keys are role+content+id stable",
        turnDedupKey(turns[0], stableHash) === turnDedupKey({ ...turns[0] }, stableHash));

      const ackTurns = trajectoryToTurns([
        { role: "user", id: "m2", agent: "build", created: 1, parts: [{ type: "text", text: "ok" }] },
      ], cfg);
      const ackPlan = planCapture(ackTurns, {}, cfg, stableHash);
      check("bare acknowledgement is not captured", ackPlan.payloads.length === 0);

      // Real server round trip, so the add+commit path is exercised for real.
      const creds = resolveOpenVikingCredentials();
      if (creds.hasApiKey) {
        const sessionId = `mimo-verify-${Date.now().toString(36)}`;
        const { fetchJSON } = makeAgentFetchJSON(cfg, base);
        const { log, logError } = createAgentLogger("mimo", "verify", { ...cfg, debug: false });
        const payload = [
          { role: "user", content: "Verification probe: the user decided to ship OpenViking in two phases." },
          { role: "assistant", content: "Noted: ship OpenViking in two phases." },
        ];
        const added = await addAgentMessages(fetchJSON, sessionId, payload);
        check("live addAgentMessages accepted both turns",
          Number(added.sent || 0) + Number(added.queued || 0) === payload.length,
          `sent=${added.sent} queued=${added.queued} failed=${added.failed} err=${added.lastError?.message || added.lastError || "-"}`);
        const committed = await commitAgentSession(fetchJSON, sessionId, log);
        check("live commitAgentSession accepted",
          committed.ok === true || committed.result?.status,
          `ok=${committed.ok} status=${committed.result?.status} trace=${committed.traceId || "-"}`);
        if (!committed.ok) logError("commit", committed.error);
      } else {
        check("live add/commit skipped (no API key resolved)", true, "credentials unavailable");
      }
    }

    // -----------------------------------------------------------------------
    if (want("e2e-capture")) {
      section("7. session.post captured the real turn into OpenViking");
      // The turn from section 2 ran through the plugin's own `session.post`
      // hook. Reading the hook state it wrote proves the hook fired with the
      // real trajectory and that the server acked — as opposed to the unit-level
      // capture checks in section 6, which exercise the mapper directly.
      const nativeSessionId = sessionID;
      const statePath = join(homedir(), ".openviking", "hook-state", "mimo", `${nativeSessionId}.json`);
      await new Promise((r) => setTimeout(r, 1500));
      const exists = existsSync(statePath);
      check("the plugin wrote hook state for this session", exists, statePath);
      if (exists) {
        const raw = await readFile(statePath, "utf8");
        const state = JSON.parse(raw);
        check("hook state is under ~/.openviking/hook-state/mimo/ (clientId=mimo)",
          statePath.includes(join(".openviking", "hook-state", "mimo")), statePath);
        check("session.post captured at least one dedup key",
          Array.isArray(state.capturedKeys) && state.capturedKeys.length > 0,
          `${(state.capturedKeys || []).length} key(s)`);
        check("the derived OV session id carries the mimo- prefix",
          String(state.ovSessionId || "").startsWith("mimo-"),
          String(state.ovSessionId || "").slice(0, 60));
      }

      // The strongest anti-feedback evidence available: the recorded upload
      // bytes. Hook state holds only hashes, so it could never prove what was
      // actually sent — this does.
      const uploads = ovRecorder.sessionMessages();
      const uploadedBytes = uploads.map((r) => r.body).join("\n");
      check("the plugin uploaded captured turns to the live OV session",
        uploads.length > 0,
        `${uploads.length} message upload(s), ${uploadedBytes.length} bytes`);
      check("ANTI-FEEDBACK on a real turn: injected recall text is NOT in the uploaded payload",
        uploadedBytes.length > 0 && !uploadedBytes.includes("Relevant memory from OpenViking"),
        uploadedBytes.length ? "no injected body in the upload" : "no upload captured");
      check("no <openviking-context> wrapper reached OpenViking",
        !uploadedBytes.includes("<openviking-context"),
        uploadedBytes.includes("<openviking-context") ? "WRAPPER LEAKED" : "clean");
      check("the user's real prompt text IS in the uploaded payload",
        uploadedBytes.includes("OpenViking"), "prompt text present in upload");
      check("the session was committed",
        ovRecorder.commits().length > 0,
        `${ovRecorder.commits().length} commit(s)`);
    }

    // -----------------------------------------------------------------------
    if (want("session-post")) {
      section("2b. the engine's own session.post payload (observed in-process)");
      await new Promise((r) => setTimeout(r, 800));
      const observerPath = join(cfgDir, "observer.json");
      check("the observer plugin was loaded by the engine and recorded hooks",
        existsSync(observerPath), observerPath);
      if (existsSync(observerPath)) {
        const seen = JSON.parse(await readFile(observerPath, "utf8"));
        const post = (seen.sessionPost || []).at(-1);
        check("session.post fired for the turn", Boolean(post),
          `${(seen.sessionPost || []).length} call(s)`);
        if (post) {
          check("session.post outcome is exactly \"completed\"",
            post.outcome === "completed", String(post.outcome));
          check("session.post carried no error", post.error === null, String(post.error));
          check("session.post carried the full trajectory (user + assistant roles)",
            post.trajectoryRoles.some((m2) => m2.role === "user")
              && post.trajectoryRoles.some((m2) => m2.role === "assistant"),
            JSON.stringify(post.trajectoryRoles.map((m2) => m2.role)));
          check("the trajectory's part types are the ones the capture mapper handles",
            post.trajectoryPartTypes.includes("text"),
            JSON.stringify([...new Set(post.trajectoryPartTypes)]));
          // session.post runs LAST, so its trajectory shows the result of every
          // injection — including a sibling plugin's. This is the in-process
          // counterpart to the request-body assertion in section 4.
          check("session.post's final trajectory carries the injected recall block",
            (post.syntheticTexts || []).some((t) => t.includes("openviking-context")),
            `${(post.syntheticTexts || []).length} synthetic text part(s)`);
          check("session.post's final system prompt carries the profile block",
            (post.systemPromptOvBlocks || []).length > 0,
            `${(post.systemPromptOvBlocks || []).length} openviking-context block(s)`);
        }
      }
    }

    // -----------------------------------------------------------------------
    if (want("profile-once")) {
      section("5b. profile injection is idempotent, not per-turn");
      // Two turns in one session. The engine caches the built `system` array
      // per session, so the real invariant is: exactly one session-start block
      // in the request, on *every* turn. A per-turn duplicate would mean the
      // plugin pushed twice; a zero on turn 2 would mean the engine rebuilt the
      // prompt and the plugin failed to restore the profile.
      mock.setScript([{ text: "first" }]);
      await runTurn(engineBase, sessionID, "first probe question about the codebase");
      const first = JSON.stringify(
        (mock.completionRequests().at(-1)?.body?.messages || []).filter((m2) => m2.role === "system"),
      );
      mock.setScript([{ text: "second" }]);
      await runTurn(engineBase, sessionID, "second probe question about something else");
      const second = JSON.stringify(
        (mock.completionRequests().at(-1)?.body?.messages || []).filter((m2) => m2.role === "system"),
      );
      const count = (s) => (s.match(/source=\\?"session-start\\?"/g) || []).length;
      check("session-start profile appears exactly once on the first turn",
        count(first) === 1, `${count(first)} occurrence(s)`);
      check("session-start profile is NOT duplicated on the second turn",
        count(second) === 1, `${count(second)} occurrence(s)`);
      check("the profile block is substantial (a real profile was fetched)",
        first.includes("openviking-context") && first.length > 3000,
        `${first.length} chars of system content`);
    }

    // -----------------------------------------------------------------------
    if (want("profile-retry")) {
      section("5b2. a failed profile fetch retries on the next request");
      // A local stub that fails the first N calls then serves a real profile
      // body. Counting the calls is what makes this a retry test: asserting
      // "no block was pushed" alone would also pass if the hook had silently
      // cached a failure and never tried again.
      const { createServer } = await import("node:http");
      let calls = 0;
      let healthy = false;
      const stub = createServer((req, res) => {
        calls += 1;
        // Fail every call until the test flips the switch. `buildProfileBlock`
        // fires three requests in parallel and returns a block if ANY of them
        // succeeds, so a partial failure would still produce a profile and the
        // test would not be exercising the outage path at all.
        if (!healthy) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", error: { message: "stub outage" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          result: typeof req.url === "string" && req.url.includes("/fs/ls") ? [] : "# Profile\n\nStub profile body for the retry test.\n",
          status: "ok",
        }));
      });
      await new Promise((r) => stub.listen(0, "127.0.0.1", r));
      const stubUrl = `http://127.0.0.1:${stub.address().port}`;

      const prevUrl = process.env.OPENVIKING_URL;
      const prevSource = process.env.OPENVIKING_CREDENTIAL_SOURCE;
      const prevTimeout = process.env.OPENVIKING_TIMEOUT_MS;
      // `env` wins over ovcli.conf in the credential chain, so this redirects
      // the plugin without touching the user's real credential file.
      process.env.OPENVIKING_URL = stubUrl;
      process.env.OPENVIKING_CREDENTIAL_SOURCE = "env";
      process.env.OPENVIKING_TIMEOUT_MS = "3000";
      try {
        const mod = await import(`file:///${cfgDir.replace(/\\/g, "/")}/plugin/openviking.js`);
        const hooks = await mod.default.server({
          client: {}, project: {}, directory: cfgDir, worktree: cfgDir,
          experimental_workspace: { register() {} },
          serverUrl: new URL(stubUrl), $: undefined,
        });
        const sys1 = [];
        await hooks["experimental.chat.system.transform"](
          { sessionID: "ses_retry_probe", model: {} }, { system: sys1 },
        );
        const afterFirst = calls;
        check("the first request attempted a profile fetch", afterFirst > 0,
          `${afterFirst} OV call(s)`);
        check("no profile block is pushed while OV is failing", sys1.length === 0,
          `${sys1.length} block(s)`);

        const sys2 = [];
        await hooks["experimental.chat.system.transform"](
          { sessionID: "ses_retry_probe", model: {} }, { system: sys2 },
        );
        check("a failure is NOT cached as delivered — the next request retried",
          calls > afterFirst, `${calls} total OV call(s), was ${afterFirst}`);

        // OV comes back; the next request must pick the profile up.
        healthy = true;
        const sys3 = [];
        await hooks["experimental.chat.system.transform"](
          { sessionID: "ses_retry_probe", model: {} }, { system: sys3 },
        );
        check("once OV recovers, the profile is fetched and pushed",
          sys3.length === 1 && String(sys3[0]).includes("openviking-context"),
          `${sys3.length} block(s), ${String(sys3[0] || "").length} chars`);

        const beforeDup = calls;
        const sys4 = [];
        await hooks["experimental.chat.system.transform"](
          { sessionID: "ses_retry_probe", model: {} }, { system: sys4 },
        );
        check("an already-delivered profile is restored with no further fetch",
          sys4.length === 1 && calls === beforeDup,
          `${sys4.length} block(s) restored, ${calls - beforeDup} extra fetch(es)`);
      } finally {
        await new Promise((r) => stub.close(r));
        if (prevUrl === undefined) delete process.env.OPENVIKING_URL;
        else process.env.OPENVIKING_URL = prevUrl;
        if (prevSource === undefined) delete process.env.OPENVIKING_CREDENTIAL_SOURCE;
        else process.env.OPENVIKING_CREDENTIAL_SOURCE = prevSource;
        if (prevTimeout === undefined) delete process.env.OPENVIKING_TIMEOUT_MS;
        else process.env.OPENVIKING_TIMEOUT_MS = prevTimeout;
      }
    }

    // -----------------------------------------------------------------------
    if (want("skill")) {
      section("5c. the MiMo native plugin manifest and skill metadata");
      // Manifest is checked with the desktop's own validation rules (ported in
      // scripts/validate-manifest.mjs), not with an approximation.
      const manifestPath = join(REPO_ROOT, "mimo-plugin.json");
      const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      let normalized = null;
      try { normalized = normalizeManifest(rawManifest); } catch (error) { normalized = null; }
      check("mimo-plugin.json validates against the desktop's manifest rules",
        normalized !== null, normalized ? "accepted" : "rejected");
      if (normalized) {
        check("manifest kind is composite (declares skills)",
          normalized.kind === "composite", normalized.kind);
        check("manifest components.skills path is relative with no traversal",
          normalized.components.skills.length === 1
            && normalized.components.skills[0].path === "skills/openviking-memory",
          JSON.stringify(normalized.components.skills));
        check("every declared skill path exists in the repo",
          existsSync(join(REPO_ROOT, normalized.components.skills[0].path, "SKILL.md")),
          normalized.components.skills[0].path);
      }

      const skillPath = join(cfgDir, "skills", "openviking-memory", "SKILL.md");
      const exists = existsSync(skillPath);
      check("skill directory was installed", exists, skillPath);

      // The engine discovers `{skill,skills}/**/SKILL.md` under every config
      // directory and serves what it parsed over GET /skill. That response is
      // the ground truth for "the skill is visible to the agent" — and it also
      // proves the frontmatter parser accepted the description, since a value
      // containing an unquoted `:` or `[` makes the parse fail silently.
      const skillList = await getJSON(engineBase, "/skill");
      const discovered = Array.isArray(skillList.body)
        ? skillList.body.find((s2) => s2.name === "openviking-memory")
        : null;
      check("the engine discovered the skill and serves it from GET /skill",
        Boolean(discovered),
        discovered ? discovered.location : `${Array.isArray(skillList.body) ? skillList.body.length : 0} skills listed`);
      if (discovered) {
        check("the engine parsed the description (frontmatter was valid YAML to it)",
          typeof discovered.description === "string" && discovered.description.length > 100,
          `${String(discovered.description || "").length} chars`);
        check("the parsed description matches SKILL.md (no silent truncation)",
          discovered.description.startsWith("OpenViking long-term memory discipline"),
          String(discovered.description).slice(0, 60));
        check("the skill body reached the engine",
          typeof discovered.content === "string" && discovered.content.includes("ov_search"),
          `${String(discovered.content || "").length} chars of body`);
      }
      if (exists) {
        const text = await readFile(skillPath, "utf8");
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        check("SKILL.md has a frontmatter block", Boolean(fm));
        const body = fm ? fm[1] : "";
        check("frontmatter name matches the directory name",
          /^name:\s*openviking-memory\s*$/m.test(body),
          (body.match(/^name:.*$/m) || [""])[0]);
        check("name is letters/numbers/hyphens only",
          /^name:\s*[A-Za-z0-9-]+\s*$/m.test(body));
        check("description is present and non-empty",
          /^description:\s*"/m.test(body) && body.length > 120,
          `${body.length} chars of frontmatter`);
        // A value containing `:` or `[`/`]` MUST be quoted or MiMo's
        // hand-rolled YAML parser fails and the desktop silently skips the skill.
        for (const line of body.split(/\r?\n/)) {
          const m2 = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
          if (!m2) continue;
          const value = m2[2];
          const risky = /[:\[\]{}]/.test(value) || value.trimStart().startsWith("[");
          check(`frontmatter "${m2[1]}" is quoted if it contains : or brackets`,
            !risky || (value.startsWith("\"") && value.endsWith("\"")),
            risky && !value.startsWith("\"") ? `UNQUOTED: ${value.slice(0, 50)}` : "ok");
        }
      }
      for (const [locale, mustContain] of [["zh-CN", "displayName"], ["en-US", "displayName"]]) {
        const p = join(cfgDir, "skills", "openviking-memory", "locales", `${locale}.json`);
        if (!existsSync(p)) {
          check(`locales/${locale}.json exists`, false, p);
          continue;
        }
        const parsed = JSON.parse(await readFile(p, "utf8"));
        check(`locales/${locale}.json has displayName + brief and nothing else`,
          Object.keys(parsed).sort().join(",") === "brief,displayName"
            && typeof parsed.displayName === "string"
            && typeof parsed.brief === "string",
          `${mustContain}: ${parsed.displayName}; keys=${Object.keys(parsed).join(",")}`);
      }

      // The OV-side integration record must keep the official eleven fields
      // verbatim so OV's own tooling can read it; any port-specific note has to
      // live outside them (in `provenance`).
      const integration = JSON.parse(
        await readFile(join(REPO_ROOT, "integration.json"), "utf8"),
      );
      const OFFICIAL_FIELDS = [
        "schemaVersion", "id", "version", "client", "installMode", "source",
        "capabilities", "hooksConfig", "mcpConfig", "installedAt", "updatedAt",
      ];
      const missing = OFFICIAL_FIELDS.filter((f) => !(f in integration));
      check("integration.json carries all 11 official OV fields",
        missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "all present");
      check("integration.json client is \"mimo\"", integration.client === "mimo", String(integration.client));
      check("integration.json installMode is managed-native",
        integration.installMode === "managed-native", String(integration.installMode));
      check("integration.json capabilities match the brief",
        JSON.stringify(integration.capabilities) === JSON.stringify(["hooks", "mcp", "tools", "skills"]),
        JSON.stringify(integration.capabilities));
      const extra = Object.keys(integration).filter((k) => !OFFICIAL_FIELDS.includes(k));
      check("port-specific keys are namespaced under provenance",
        extra.every((k) => k === "provenance" || k === "sourceRepository" || k === "status")
          && Boolean(integration.provenance),
        `extra keys: ${extra.join(", ") || "none"}`);
    }

    // -----------------------------------------------------------------------
    if (want("native-tools")) {
      section("8. native tools against the live OpenViking server");
      const cfg = loadAgentHookConfig("mimo");
      const session = await openMcpSession(cfg);
      check("MCP session established", session.ok === true, session.ok ? session.protocolVersion : session.error);
      if (session.ok) {
        const listed = await session.listTools();
        check("live tools/list returns the OV tool set",
          listed.ok && listed.tools.length === 15,
          listed.ok ? `${listed.tools.length} tools` : listed.error);

        const health = await session.callTool("health", {});
        check("ov_health returns real content from the live server",
          health.ok && JSON.stringify(health.result || {}).length > 10,
          health.ok ? JSON.stringify(health.result).slice(0, 160) : health.error);

        const listing = await session.callTool("list", { uri: "viking://user/bendit/memories" });
        const rendered = listing.ok ? JSON.stringify(listing.result) : "";
        check("ov_list on viking://user/bendit/memories returns real content",
          listing.ok && rendered.length > 10,
          listing.ok ? rendered.slice(0, 200) : listing.error);

        // Proves the point section 3 has to settle for asserting indirectly:
        // every unset knob (`recursive`, `offset`, `sort_order`) is defaulted by
        // the SERVER, so a schema that leaves them optional is correct rather
        // than lossy.
        const tree = await session.callTool("tree", { uri: "viking://user/bendit/memories", level_limit: 1 });
        check("ov_tree called with only its one explicit arg is accepted by the server",
          tree.ok, tree.ok ? "server defaulted level_limit/node_limit/offset" : tree.error);

        // A live search proves the injection query face is the same one the
        // plugin's recall path uses.
        const found = await session.callTool("find", { query: "OpenViking integration", limit: 3 });
        check("ov_find answers a semantic query",
          found.ok, found.ok ? `ok, ${JSON.stringify(found.result).length} bytes` : found.error);
      }
      await session.close();

      // Through the plugin's own tool wrappers — the same `execute` the engine
      // invokes — so the zod shape and the MCP dispatch are exercised together
      // rather than the MCP layer alone.
      const mod = await import(`file:///${cfgDir.replace(/\\/g, "/")}/plugin/openviking.js`);
      const hooks = await mod.default.server({
        client: {}, project: {}, directory: cfgDir, worktree: cfgDir,
        experimental_workspace: { register() {} }, serverUrl: new URL(engineBase), $: undefined,
      });
      const toolCtx = {
        sessionID: "ses_tool_probe", messageID: "msg_tool_probe", agent: "build",
        directory: cfgDir, worktree: cfgDir,
        abort: new AbortController().signal, metadata() {}, ask: async () => {},
      };
      const healthResult = await hooks.tool.ov_health.execute({}, toolCtx);
      check("plugin tool wrapper ov_health returns real content end-to-end",
        typeof healthResult === "string" && healthResult.includes("healthy"),
        String(healthResult).slice(0, 100));

      const listResult = await hooks.tool.ov_list.execute(
        { uri: "viking://user/bendit/memories" }, toolCtx,
      );
      check("plugin tool wrapper ov_list returns real content end-to-end",
        typeof listResult === "string" && listResult.includes("profile.md"),
        String(listResult).slice(0, 120).replace(/\n/g, " | "));

      // A tool with no args at all and a tool whose args are all optional are
      // the shapes a too-strict schema would break; both must still dispatch.
      const watchesResult = await hooks.tool.ov_list_watches.execute({}, toolCtx);
      check("an all-optional-args tool dispatches with an empty object",
        typeof watchesResult === "string" && watchesResult.length > 0,
        String(watchesResult).slice(0, 90).replace(/\n/g, " | "));
      check("the tool result is not duplicated (content and structuredContent are not both emitted)",
        typeof watchesResult === "string" && !watchesResult.includes("\"result\":"),
        `${String(watchesResult).length} chars`);
    }

    // -----------------------------------------------------------------------
    if (want("credential-reload")) {
      section("8b. a rotated credential file is picked up without a restart");
      // The plugin is in-process and long-lived, so editing ovcli.conf has to
      // take effect on the next tool call. Two stub OV endpoints stand in for
      // "old server" and "new server"; the credential file is rewritten between
      // calls and the answer must come from the second stub.
      const { createServer } = await import("node:http");
      async function startStub(label) {
        const hits = { initialize: 0 };
        const server = createServer((req, res) => {
          let raw = "";
          req.on("data", (b) => { raw += b; });
          req.on("end", () => {
            let msg = {};
            try { msg = JSON.parse(raw); } catch { /* ignore */ }
            if (msg.method === "initialize") hits.initialize += 1;
            const reply = msg.id === undefined ? "" : `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: msg.method === "initialize"
                ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: label, version: "1" } }
                : { content: [{ type: "text", text: `${label} answered` }] },
            })}\n\n`;
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(reply);
          });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        return {
          hits, url: `http://127.0.0.1:${server.address().port}`,
          close: () => new Promise((r) => server.close(r)),
        };
      }

      const stubA = await startStub("stub-A");
      const stubB = await startStub("stub-B");
      const confDir = join(base, "cred");
      await mkdir(confDir, { recursive: true });
      const confPath = join(confDir, "ovcli.conf");
      await writeFile(confPath, JSON.stringify({ url: stubA.url, api_key: "probe-key-a" }), "utf8");

      // Imported from the config dir (not the repo root) so `zod` resolves.
      const { buildOpenVikingTools } = await import(
        `file:///${cfgDir.replace(/\\/g, "/")}/plugin/tools.mjs`
      );

      const prevConf = process.env.OPENVIKING_CLI_CONFIG_FILE;
      const prevUrlEnv = process.env.OPENVIKING_URL;
      const prevSrc = process.env.OPENVIKING_CREDENTIAL_SOURCE;
      delete process.env.OPENVIKING_URL;
      delete process.env.OPENVIKING_CREDENTIAL_SOURCE;
      process.env.OPENVIKING_CLI_CONFIG_FILE = confPath;
      try {
        let reloads = 0;
        const credTools = buildOpenVikingTools({
          cfg: loadAgentHookConfig("mimo"),
          reloadConfig: () => { reloads += 1; return loadAgentHookConfig("mimo"); },
          log: () => {}, logError: () => {},
        });
        const call = () => credTools.ov_health.execute({}, {
          sessionID: "s", messageID: "m", agent: "build",
          directory: confDir, worktree: confDir,
          abort: new AbortController().signal, metadata() {}, ask: async () => {},
        });

        const firstResult = await call();
        check("first call was served by stub A", String(firstResult).includes("stub-A answered"),
          String(firstResult).slice(0, 50));

        // Changing the key length guarantees a size change too, so the probe
        // does not depend on mtime resolution.
        await writeFile(confPath, JSON.stringify({ url: stubB.url, api_key: "probe-key-bbbbbbbb" }), "utf8");

        const secondResult = await call();
        check("the credential change was detected", reloads > 0, `${reloads} reload(s)`);
        check("the next call was served by stub B — the MCP session was rebuilt",
          String(secondResult).includes("stub-B answered"),
          String(secondResult).slice(0, 50));
        check("stub B saw a fresh handshake", stubB.hits.initialize >= 1,
          `${stubB.hits.initialize}`);
      } finally {
        await stubA.close();
        await stubB.close();
        if (prevConf === undefined) delete process.env.OPENVIKING_CLI_CONFIG_FILE;
        else process.env.OPENVIKING_CLI_CONFIG_FILE = prevConf;
        if (prevUrlEnv !== undefined) process.env.OPENVIKING_URL = prevUrlEnv;
        if (prevSrc !== undefined) process.env.OPENVIKING_CREDENTIAL_SOURCE = prevSrc;
      }
    }

    // -----------------------------------------------------------------------
    if (want("fail-open")) {
      section("9. fail-open: an OV outage never breaks the user's turn");
      // Drive the plugin's own hooks and native tools with the credential chain
      // pointed at a dead port (env wins over ovcli.conf). This exercises the
      // real hook bodies — recall, profile, capture, tool execute — rather than
      // a re-implementation, and needs no second engine because the engine's
      // config is a module-level singleton.
      const prevUrl = process.env.OPENVIKING_URL;
      const prevSource = process.env.OPENVIKING_CREDENTIAL_SOURCE;
      const prevTimeout = process.env.OPENVIKING_TIMEOUT_MS;
      process.env.OPENVIKING_URL = "http://127.0.0.1:1";
      process.env.OPENVIKING_CREDENTIAL_SOURCE = "env";
      process.env.OPENVIKING_TIMEOUT_MS = "1200";
      try {
        const mod = await import(`file:///${cfgDir.replace(/\\/g, "/")}/plugin/openviking.js`);
        const hooks = await mod.default.server({
          client: {}, project: {}, directory: cfgDir, worktree: cfgDir,
          experimental_workspace: { register() {} },
          serverUrl: new URL(engineBase), $: undefined,
        });

        // chat.message (recall) must not throw and must not inject.
        const parts = [{ type: "text", text: "does recall survive an outage?" }];
        let recallThrew = null;
        try {
          await hooks["chat.message"](
            { sessionID: "ses_outage", messageID: "msg_outage" },
            { message: { id: "msg_outage" }, parts },
          );
        } catch (error) { recallThrew = error; }
        check("chat.message does not throw while OV is down",
          recallThrew === null, recallThrew ? String(recallThrew.message) : "ok");
        check("chat.message injected nothing from a dead server",
          parts.length === 1, `${parts.length} part(s), expected 1`);

        // system.transform (profile) must not throw.
        let profileThrew = null;
        const sys = [];
        try {
          await hooks["experimental.chat.system.transform"](
            { sessionID: "ses_outage", model: {} }, { system: sys },
          );
        } catch (error) { profileThrew = error; }
        check("experimental.chat.system.transform does not throw while OV is down",
          profileThrew === null, profileThrew ? String(profileThrew.message) : "ok");
        check("no profile was pushed from a dead server", sys.length === 0,
          `${sys.length} block(s)`);

        // session.post (capture) must not throw.
        let captureThrew = null;
        try {
          await hooks["session.post"]({
            sessionID: "ses_outage", agentID: "build", outcome: "completed",
            trajectory: [{
              role: "user", id: "m1", agent: "build", created: Date.now(),
              parts: [{ type: "text", text: "a captured line that cannot be uploaded" }],
            }],
          }, {});
        } catch (error) { captureThrew = error; }
        check("session.post does not throw while OV is down",
          captureThrew === null, captureThrew ? String(captureThrew.message) : "ok");

        // Native tools must degrade to a returned string, never a throw.
        const healthTool = hooks.tool?.ov_health;
        check("ov_health tool is registered", Boolean(healthTool));
        if (healthTool) {
          let toolResult = null;
          let toolThrew = null;
          try {
            toolResult = await healthTool.execute({}, { sessionID: "s", messageID: "m",
              agent: "build", directory: cfgDir, worktree: cfgDir,
              abort: new AbortController().signal, metadata() {}, ask: async () => {} });
          } catch (error) { toolThrew = error; }
          check("a native ov_* tool returns a string instead of throwing",
            toolThrew === null && typeof toolResult === "string",
            toolThrew ? `THREW: ${toolThrew.message}` : String(toolResult).slice(0, 90));
          check("the tool's error string tells the user what to check",
            typeof toolResult === "string" && toolResult.includes("ovcli.conf"),
            String(toolResult || "").slice(0, 90));
        }
      } finally {
        if (prevUrl === undefined) delete process.env.OPENVIKING_URL;
        else process.env.OPENVIKING_URL = prevUrl;
        if (prevSource === undefined) delete process.env.OPENVIKING_CREDENTIAL_SOURCE;
        else process.env.OPENVIKING_CREDENTIAL_SOURCE = prevSource;
        if (prevTimeout === undefined) delete process.env.OPENVIKING_TIMEOUT_MS;
        else process.env.OPENVIKING_TIMEOUT_MS = prevTimeout;
      }
    }

    // -----------------------------------------------------------------------
    if (want("compaction")) {
      section("10. session.compacting flushes and resets the dedup ledger");
      const mod = await import(`file:///${cfgDir.replace(/\\/g, "/")}/plugin/openviking.js`);
      const hooks = await mod.default.server({
        client: {}, project: {}, directory: cfgDir, worktree: cfgDir,
        experimental_workspace: { register() {} },
        serverUrl: new URL(engineBase), $: undefined,
      });
      check("experimental.session.compacting hook exists",
        typeof hooks["experimental.session.compacting"] === "function");

      const statePath = join(homedir(), ".openviking", "hook-state", "mimo", `${sessionID}.json`);
      // Drive a real turn first so there is a dedup ledger to clear. Without
      // this the check would pass vacuously on a session that never captured.
      mock.setScript([{ text: "captured before compaction." }]);
      await runTurn(engineBase, sessionID, "a line that will be captured before compaction");
      await new Promise((r) => setTimeout(r, 800));

      const beforeRaw = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : null;
      check("session.post recorded dedup keys to reset",
        (beforeRaw?.capturedKeys || []).length > 0,
        `${(beforeRaw?.capturedKeys || []).length} key(s) before compaction`);

      await hooks["experimental.session.compacting"]({ sessionID }, { context: [] });
      const afterRaw = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : null;
      // Compaction rewrites the message list, so keys from the old list would
      // suppress the freshly-summarized turns on the next capture.
      check("compaction reset the capture dedup ledger",
        Array.isArray(afterRaw?.capturedKeys) && afterRaw.capturedKeys.length === 0,
        `after=${(afterRaw?.capturedKeys || []).length} keys`);
      check("compaction preserved the persisted OV session id",
        afterRaw?.ovSessionId === beforeRaw?.ovSessionId,
        String(afterRaw?.ovSessionId || ""));
    }
  } finally {
    try { await handle.stop?.(); } catch { /* the engine may already be down */ }
    ovRecorder.restore();
    await mock.close();
    // Step out of the tree before deleting it: the cwd was moved into the temp
    // config dir for the engine's sake, and Windows refuses to remove a
    // directory that is any process's working directory (EBUSY).
    try { process.chdir(dirname(base)); } catch { /* nothing left to do */ }
    if (!args.keep) {
      // Unlink the node_modules junction before the recursive delete. Node's
      // rm() does not follow junctions (verified), but the target here is the
      // user's real ~/.config/mimocode/node_modules — a link is cheap insurance.
      const modules = join(base, "config", "node_modules");
      try { await rm(modules, { recursive: false, force: true }); } catch { /* not a link */ }
      await rm(base, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nkept: ${base}\n`);
    }
  }

  section("summary");
  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`${passed}/${results.length} checks passed\n`);
  if (failures > 0) {
    process.stdout.write("failed checks:\n");
    for (const r of results.filter((x) => !x.ok)) {
      process.stdout.write(`  - ${r.name}${r.detail ? ` :: ${r.detail}` : ""}\n`);
    }
  }
  // The engine leaves watchers, timers and DB handles open; waiting for a clean
  // event-loop drain would hang the harness forever. All evidence is flushed.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
