/**
 * OpenViking long-term memory for the Xiaomi MiMo desktop client (MiMoCode engine).
 *
 * MiMo plugins are in-process ESM modules, not stdin/stdout subprocesses, so
 * this file replaces the whole hook-launcher + wire-journal machinery the
 * Kimi/Codex/Claude ports need. The host contract this is built on was read out
 * of the engine bundle (`app.asar/out/main/node.mjs`) and verified on real
 * turns; README's "宿主契约" table records how each hook was proven.
 *
 *   chat.message                          -> per-prompt semantic recall injection
 *   experimental.chat.system.transform    -> once-per-session user profile
 *   tool.execute.before                   -> viking:// URI guard
 *   session.post                          -> capture + commit (full trajectory)
 *   experimental.session.compacting       -> flush/commit, reset capture dedup
 *   event                                 -> session.deleted cleanup
 *
 * Fail-open is absolute: every hook body is wrapped, so an OV outage or a
 * thrown error can never break the user's turn. Nothing here throws outward.
 */

import {
  addAgentMessages,
  buildAgentProfile,
  commitAgentSession,
  createAgentLogger,
  deriveAgentSessionId,
  loadAgentHookConfig,
  makeAgentFetchJSON,
  readHookState,
  recallForPrompt,
  replayAgentPending,
  shouldBypassAgent,
  stableHash,
  withAgentHookLock,
  writeHookState,
} from "../lib/agent-hook-runtime.mjs";
import {
  finalizeCaptureResult,
  planCapture,
  trajectoryToTurns,
} from "./capture.mjs";
import { buildOpenVikingTools } from "./tools.mjs";
import { evaluateMimoUriGuard } from "./uri-guard.mjs";

/** Wrapper around every injected block; sanitizeCapturedText strips it by name. */
const CONTEXT_OPEN = (source) => `<openviking-context source="${source}">`;
const CONTEXT_CLOSE = "</openviking-context>";

/**
 * Harness wrappers that must never be mistaken for user intent — and, more
 * importantly, must never be fed back into `recallForPrompt` as a query.
 */
const INJECTED_WRAPPERS = [
  /<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi,
  /<relevant-memor(?:y|ies)\b[^>]*>[\s\S]*?<\/relevant-memor(?:y|ies)>/gi,
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<hook_result\b[^>]*>[\s\S]*?<\/hook_result>/gi,
];

function stripInjectedWrappers(text) {
  let value = String(text || "");
  for (const re of INJECTED_WRAPPERS) value = value.replace(re, " ");
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The prompt the user actually typed, with synthetic parts and injected
 * wrappers removed. Returns "" when the message is nothing but injections —
 * in that case recall must not run at all, or a compaction auto-continue would
 * re-query the service with the previous turn's memory block.
 */
export function extractUserPrompt(parts, message) {
  const chunks = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || part.type !== "text") continue;
    if (part.synthetic || part.ignored) continue;
    if (typeof part.text !== "string" || !part.text.trim()) continue;
    const cleaned = stripInjectedWrappers(part.text);
    if (cleaned) chunks.push(cleaned);
  }
  if (chunks.length === 0 && message && typeof message === "object") {
    const text = stripInjectedWrappers(
      typeof message.text === "string" ? message.text : "",
    );
    if (text) chunks.push(text);
  }
  return chunks.join("\n").trim();
}

export default {
  id: "openviking-memory",

  async server(input) {
    const cfg = loadAgentHookConfig("mimo");
    const { log, logError } = createAgentLogger("mimo", "plugin", cfg);

    // `input.directory` is the session workspace; the app's own cwd is not.
    const cwd = String(input?.directory || input?.worktree || process.cwd());
    const { fetchJSON } = makeAgentFetchJSON(cfg, cwd);

    /**
     * Per-session hot state. Never authoritative for dedup — hook state is.
     *
     * MiMo's session ids (`ses_<hex>`) are already hook-state-safe, so the OV
     * session id and the hook-state filename both key on the sessionID
     * verbatim; `deriveAgentSessionId` adds only the `mimo-` prefix.
     */
    const sessions = new Map();

    function sessionState(sessionID) {
      let state = sessions.get(sessionID);
      if (!state) {
        state = {
          ovSessionId: deriveAgentSessionId("mimo-", { session_id: sessionID }),
          profileDelivered: false,
          profileBlock: "",
          profileInFlight: null,
          promptHash: "",
          promptAt: 0,
          recallBlock: "",
        };
        sessions.set(sessionID, state);
      }
      return state;
    }

    // ---------------------------------------------------------------------
    // User profile -> system prompt
    // ---------------------------------------------------------------------
    // The hook fires before every LLM request, including each step inside one
    // turn, and the block is ~5k tokens. Two things keep it from being re-sent:
    //
    //   - The engine caches the built `system` array per session and passes the
    //     cached array back in, so a block pushed on turn 1 is still present on
    //     turn 2 (verified against the engine — this is why the check below
    //     looks at content rather than a delivered flag).
    //   - The scan below is therefore idempotence by content, not a one-shot
    //     flag. That distinction matters: the engine also *rebuilds* the system
    //     array from scratch on a checkpoint/rebuild, and a one-shot flag would
    //     leave the rebuilt prompt profile-less for the rest of the session.
    //
    // A flag is still kept, but only to short-circuit the fetch: once we have
    // successfully delivered, there is no reason to hit OV again on every step.
    async function injectProfile(sessionID, output) {
      if (!cfg.enabled || !sessionID || !Array.isArray(output?.system)) return;
      if (output.system.some((block) => typeof block === "string"
        && block.includes(CONTEXT_OPEN("session-start")))) return;
      const state = sessionState(sessionID);
      if (state.profileDelivered && state.profileBlock) {
        output.system.push(state.profileBlock);
        return;
      }
      if (!state.profileInFlight) {
        state.profileInFlight = buildAgentProfile(fetchJSON, cfg, cwd)
          .catch((error) => {
            logError("profile", error);
            return null;
          })
          .then((block) => {
            state.profileInFlight = null;
            return block;
          });
      }
      const profile = await state.profileInFlight;
      if (!profile) return;
      // Re-read the live array: the fetch above awaited, and another caller may
      // have delivered into it in the meantime.
      if (output.system.some((block) => typeof block === "string"
        && block.includes(CONTEXT_OPEN("session-start")))) return;
      const composed = [CONTEXT_OPEN("session-start"), profile, CONTEXT_CLOSE].join("\n");
      output.system.push(composed);
      // Marked delivered only on success, so an OV outage on the first request
      // retries on the next one instead of losing the profile for the session.
      state.profileDelivered = true;
      state.profileBlock = composed;
      log("profile", { sessionID, chars: profile.length });
    }

    // ---------------------------------------------------------------------
    // Per-prompt semantic recall -> synthetic message part
    // ---------------------------------------------------------------------
    async function injectRecall(sessionID, messageID, prompt, output) {
      const state = sessionState(sessionID);
      const promptHash = stableHash(prompt);
      const now = Date.now();

      // A retried or replayed prompt (and MiMo's own text-tool-call retry)
      // arrives with identical text; re-injecting would double the block and
      // pay a second retrieval for nothing.
      if (state.promptHash === promptHash && now - state.promptAt < 500 && state.recallBlock) {
        pushRecallPart(sessionID, messageID, state.recallBlock, output);
        return;
      }

      const block = await recallForPrompt(fetchJSON, cfg, prompt, cwd, log, {
        // Passing the OV session id is what enables server-side query expansion
        // and the cross-turn dedup ledger for thin harnesses.
        sessionId: state.ovSessionId,
      }).catch((error) => {
        logError("recall", error);
        return null;
      });

      state.promptHash = promptHash;
      state.promptAt = now;
      state.recallBlock = block || "";
      if (!block) return;
      pushRecallPart(sessionID, messageID, block, output);
      log("recall", { sessionID, chars: block.length });
    }

    /** Injected parts need id/sessionID/messageID or the engine rejects them. */
    function pushRecallPart(sessionID, messageID, block, output) {
      if (!Array.isArray(output?.parts)) return;
      if (output.parts.some((part) => typeof part?.text === "string"
        && part.text.includes(CONTEXT_OPEN("recall")))) return;
      output.parts.push({
        id: `prt_ov_recall_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        type: "text",
        text: [CONTEXT_OPEN("recall"), block, CONTEXT_CLOSE].join("\n"),
        synthetic: true,
        sessionID,
        messageID: messageID || `msg_ov_recall_${Date.now().toString(36)}`,
      });
    }

    // ---------------------------------------------------------------------
    // Capture + commit
    // ---------------------------------------------------------------------
    async function captureFromTrajectory(sessionID, trajectory, log2) {
      if (!cfg.autoCapture) return { captured: 0 };
      const ovSessionId = sessionState(sessionID).ovSessionId;
      const turns = trajectoryToTurns(trajectory, cfg);
      if (turns.length === 0) return { captured: 0 };

      return withAgentHookLock("mimo", sessionID, async () => {
        const state = await readHookState("mimo", sessionID);
        const plan = planCapture(turns, state, cfg, stableHash);
        if (plan.payloads.length === 0) return { captured: 0, deduped: true };

        const result = await addAgentMessages(fetchJSON, ovSessionId, plan.payloads);
        const applied = finalizeCaptureResult(state, plan, result);
        if (Number(applied.captured || 0) <= 0) {
          log2("capture_none_sent", { ovSessionId, status: result?.status });
          return { captured: 0 };
        }
        await writeHookState("mimo", sessionID, {
          ...applied,
          ovSessionId,
          capturedSinceCommit: Number(applied.captured || 0),
        });
        return { captured: applied.captured, ovSessionId };
      });
    }

    /**
     * Commit the OV session. `budgetMs` caps the OV round trip because the hook
     * this runs under (session.post, compaction, session delete) is on the
     * user's critical path and must not stall the engine.
     */
    async function commit(sessionID, ovSessionId, log2, budgetMs) {
      const commitCfg = { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, budgetMs) };
      const commitFetch = makeAgentFetchJSON(commitCfg, cwd).fetchJSON;
      const result = await commitAgentSession(commitFetch, ovSessionId, log2);
      if (result.ok) {
        await withAgentHookLock("mimo", sessionID, async () => {
          const state = await readHookState("mimo", sessionID);
          await writeHookState("mimo", sessionID, { ...state, capturedSinceCommit: 0 });
        }).catch(() => {});
      }
      return result;
    }

    // Best-effort replay of anything a previous process left queued.
    replayAgentPending(fetchJSON, log).catch((error) => logError("replay", error));

    // `reloadConfig` lets the tool layer pick up a rotated api_key or a changed
    // server URL without a MiMo restart: an in-process plugin has no process
    // boundary to bounce, and `ovcli.conf` edits are a normal user action.
    const ovTools = buildOpenVikingTools({
      cfg,
      reloadConfig: () => loadAgentHookConfig("mimo"),
      log,
      logError,
    });

    return {
      tool: ovTools,

      "chat.message": async (chatInput, output) => {
        try {
          if (!cfg.enabled) return;
          const sessionID = chatInput?.sessionID || output?.message?.sessionID;
          if (!sessionID) return;
          if (shouldBypassAgent(cfg, { session_id: sessionID, cwd })) return;
          const prompt = extractUserPrompt(output?.parts, output?.message);
          if (!prompt) return;
          if (!cfg.autoRecall) return;
          await injectRecall(sessionID, chatInput?.messageID || output?.message?.id, prompt, output);
        } catch (error) {
          logError("chat.message", error);
        }
      },

      "experimental.chat.system.transform": async (sysInput, output) => {
        try {
          if (!cfg.enabled) return;
          const sessionID = sysInput?.sessionID;
          if (!sessionID) return;
          if (shouldBypassAgent(cfg, { session_id: sessionID, cwd })) return;
          await injectProfile(sessionID, output);
        } catch (error) {
          logError("system.transform", error);
        }
      },

      "tool.execute.before": async (toolInput, output) => {
        try {
          if (!cfg.enabled) return;
          const decision = evaluateMimoUriGuard(toolInput?.tool, output?.args);
          if (!decision) return;
          output.cancel = true;
          output.cancelReason = decision.reason;
          log("uri_guard", {
            tool: toolInput?.tool,
            uri: decision.uri,
            sessionID: toolInput?.sessionID,
          });
        } catch (error) {
          logError("tool.execute.before", error);
        }
      },

      "session.post": async (postInput) => {
        try {
          if (!cfg.enabled) return;
          const sessionID = postInput?.sessionID;
          if (!sessionID) return;
          if (shouldBypassAgent(cfg, { session_id: sessionID, cwd })) return;
          const state = sessionState(sessionID);
          const outcome = postInput?.outcome || "completed";
          if (outcome === "cancelled") return;
          const result = await captureFromTrajectory(sessionID, postInput?.trajectory, log);
          if (Number(result.captured || 0) <= 0) return;
          await commit(sessionID, state.ovSessionId, log, 6000);
        } catch (error) {
          logError("session.post", error);
        }
      },

      "experimental.session.compacting": async (compactInput) => {
        try {
          if (!cfg.enabled) return;
          const sessionID = compactInput?.sessionID;
          if (!sessionID) return;
          const state = sessionState(sessionID);
          // Flush whatever the trajectory capture queued before the host
          // rewrites history, then drop the dedup ledger: compaction produces a
          // new message list, and keys from the old one would suppress the
          // freshly-summarized turns.
          if (cfg.autoCapture) {
            await commit(sessionID, state.ovSessionId, log, 8000);
          }
          await withAgentHookLock("mimo", sessionID, async () => {
            const doc = await readHookState("mimo", sessionID);
            await writeHookState("mimo", sessionID, { ...doc, capturedKeys: [] });
          });
          state.recallBlock = "";
          state.promptHash = "";
        } catch (error) {
          logError("session.compacting", error);
        }
      },

      event: async ({ event } = {}) => {
        try {
          if (!cfg.enabled) return;
          if (event?.type !== "session.deleted") return;
          const sessionID = event?.properties?.info?.id
            || event?.properties?.sessionID
            || event?.properties?.id;
          if (!sessionID) return;
          const state = sessions.get(sessionID);
          if (!state) return;
          // The session is gone from the host but its OV session is not:
          // commit so nothing captured this turn is left unextracted.
          await commit(sessionID, state.ovSessionId, log, 5000);
          sessions.delete(sessionID);
        } catch (error) {
          logError("event", error);
        }
      },
    };
  },
};
