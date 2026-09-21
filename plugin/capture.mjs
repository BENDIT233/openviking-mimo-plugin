/**
 * `session.post` trajectory -> OpenViking capture turns.
 *
 * MiMo hands the hook the full raw agent slice, which deletes the entire
 * wire-journal parser the Kimi port needs: there is no transcript file to
 * locate, no byte cursor, and no compaction-rewrite hazard. A trajectory part
 * already carries everything a capture turn needs.
 *
 * Part shapes (from `TrajectoryPart` in @mimo-ai/plugin/dist/index.d.ts,
 * cross-checked against a live `session.post` payload):
 *
 *   text       {type:"text", text}
 *   reasoning  {type:"reasoning", text}                       -> skipped
 *   tool       {type:"tool", tool, callID, state:{status, input, output, error}}
 *   file       {type:"file", url, mime, filename}             -> skipped
 *   step-start / step-finish / patch / snapshot / retry / compaction / checkpoint
 *                                                             -> skipped
 *
 * Sanitizing goes through the shared `capture-utils` layer, whose
 * `sanitizeCapturedText` strips `<openviking-context>` — that property is what
 * stops injected recall from re-entering the memory store, and it is asserted
 * in `test/capture.test.mjs`.
 */

import {
  sanitizeCapturedText,
  shouldCaptureText,
} from "../lib/capture-utils.mjs";

/** Part types that carry no conversation content worth storing. */
const SKIPPED_PART_TYPES = new Set([
  "reasoning",
  "step-start",
  "step-finish",
  "patch",
  "snapshot",
  "file",
  "retry",
  "compaction",
  "checkpoint",
  "subtask",
  "agent",
]);

const DEFAULT_TOOL_MAX_CHARS = 1000000;

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compact(value, maxChars = DEFAULT_TOOL_MAX_CHARS) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : safeStringify(value);
  const trimmed = String(text).trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Render one trajectory part as the capture line it contributes, or "". */
export function renderTrajectoryPart(part, cfg = {}) {
  if (!part || typeof part !== "object") return "";
  // Synthetic/ignored parts are harness-injected, not the user's words: MiMo
  // puts recall blocks, reminders and auto-continue prompts there. This is the
  // MiMo analogue of the Kimi port dropping `origin.kind === "injection"`, and
  // it is the outer half of the anti-feedback guarantee — `sanitizeCapturedText`
  // below is the inner half, catching an injected block that a non-synthetic
  // part happens to quote.
  if (part.synthetic || part.ignored) return "";
  const type = String(part.type || "").toLowerCase();
  if (SKIPPED_PART_TYPES.has(type)) return "";
  const toolMaxChars = Number(cfg.captureToolMaxChars) || DEFAULT_TOOL_MAX_CHARS;

  if (type === "text") {
    return typeof part.text === "string" ? part.text : "";
  }

  if (type === "tool") {
    const name = oneLine(part.tool) || "unknown";
    const state = part.state && typeof part.state === "object" ? part.state : {};
    const lines = [`[tool-call ${name}] ${compact(state.input ?? {}, toolMaxChars)}`];
    const status = oneLine(state.status);
    const output = state.output ?? state.error;
    if (output !== undefined && output !== null && compact(output, toolMaxChars)) {
      lines.push(`[tool-result${status && status !== "completed" ? ` ${status}` : ""}] ${compact(output, toolMaxChars)}`);
    } else if (status === "error") {
      lines.push(`[tool-result error] ${compact(state.error ?? "failed", toolMaxChars)}`);
    }
    return lines.join("\n");
  }

  // Any future part type that already looks like a text carrier still counts.
  if (typeof part.text === "string") return part.text;
  return "";
}

/**
 * Convert a MiMo trajectory into `[{role, content, turnId}]` capture turns.
 *
 * Consecutive lines from the same message are joined into one turn, which is
 * what the OV add-message contract expects: a single assistant turn that ran
 * three tools is one message with three rendered lines, not three messages.
 */
export function trajectoryToTurns(trajectory, cfg = {}) {
  const turns = [];
  // The shared runtime's config carries no capture knobs (unlike the Claude /
  // Codex ports), so assistant capture has to default to on here. Turning it
  // off by accident would silently store only one half of every exchange.
  const captureAssistant = cfg.captureAssistantTurns !== false;
  for (const message of Array.isArray(trajectory) ? trajectory : []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "";
    if (!role) continue;
    if (role === "assistant" && !captureAssistant) continue;

    const lines = [];
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      const rendered = renderTrajectoryPart(part, cfg);
      if (rendered && rendered.trim()) lines.push(rendered);
    }
    if (lines.length === 0) continue;

    const content = sanitizeCapturedText(lines.join("\n\n"));
    if (!content) continue;
    turns.push({ role, content, turnId: String(message.id || "") });
  }
  return turns;
}

/**
 * Dedup key for one turn. The trajectory has stable message ids, but a turn
 * can legitimately be re-emitted (a retried run loop replays the slice), so
 * the key is id + role + content identity rather than the id alone.
 */
export function turnDedupKey(turn, hash) {
  return `${turn.turnId || ""}\u0000${turn.role}\u0000${hash(turn.content)}`;
}

/**
 * Build the capture plan: which turns to send, and their request payloads.
 * `shouldCaptureText` drops slash commands, acknowledgements and injected-only
 * bodies; `capturedKeys` (persisted in hook state) drops what OV already acked.
 */
export function planCapture(turns, state = {}, cfg = {}, hash) {
  const capturedKeys = new Set(Array.isArray(state.capturedKeys) ? state.capturedKeys : []);
  const candidates = [];
  for (const turn of turns) {
    const decision = shouldCaptureText(turn.content, turn.role, cfg);
    if (!decision.shouldCapture) continue;
    candidates.push({
      dedupKey: turnDedupKey(turn, hash),
      turn,
      content: decision.text,
    });
  }
  const toSend = candidates.filter((item) => !capturedKeys.has(item.dedupKey));
  const payloads = toSend.map(({ turn, content }) => ({
    role: turn.role,
    content,
    ...(turn.turnId ? { turn_id: turn.turnId } : {}),
  }));
  return { candidates, toSend, payloads };
}

/**
 * Fold an add-messages result back into hook state.
 *
 * Only what the server acknowledged — sent, or durably queued for replay — is
 * marked captured, so a partial failure retries the remainder on the next
 * `session.post` rather than silently losing those turns.
 */
export function finalizeCaptureResult(state, plan, result) {
  const captured = Math.min(
    plan.toSend.length,
    Math.max(0, Number(result?.sent || 0) + Number(result?.queued || 0)),
  );
  if (captured <= 0) return { ...state, captured: 0 };

  const capturedKeys = new Set(Array.isArray(state.capturedKeys) ? state.capturedKeys : []);
  for (const item of plan.toSend.slice(0, captured)) capturedKeys.add(item.dedupKey);

  return {
    ...state,
    capturedKeys: [...capturedKeys].slice(-2000),
    captured,
  };
}
