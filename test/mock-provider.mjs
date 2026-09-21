/**
 * Local OpenAI-compatible mock provider for the verification harness.
 *
 * A plain `node:http` server that speaks the two endpoints the engine needs —
 * `POST /v1/chat/completions` (streaming) and `/v1/models` — and, critically,
 * *records the exact request body* it received. Recall injection is only
 * considered proven when the marker shows up in that recorded body, not when a
 * hook log says it ran, so this recorder is the source of truth for those
 * assertions.
 *
 * The SSE frame shape mirrors what the engine's own openai-compatible adapter
 * consumes: `data: {chat.completion.chunk}` objects terminated by `data: [DONE]`.
 */

import { createServer } from "node:http";

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export function createMockProvider({ models = ["mock-model"] } = {}) {
  /** Every request body the engine sent, newest last. */
  const requests = [];
  let script = [];
  let scriptIndex = 0;

  function setScript(entries) {
    script = entries;
    scriptIndex = 0;
  }

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (buf) => { raw += buf; });
    req.on("end", () => {
      const url = req.url || "";
      if (url.endsWith("/models")) {
        json(res, 200, {
          object: "list",
          data: models.map((id) => ({ id, object: "model", owned_by: "mock" })),
        });
        return;
      }
      if (!url.includes("/chat/completions")) {
        json(res, 404, { error: { message: `no route ${url}` } });
        return;
      }

      let body = {};
      try { body = JSON.parse(raw); } catch { /* recorded as {} */ }
      requests.push({ url, body, headers: req.headers, at: Date.now() });

      // One scripted reply per request; the last entry repeats so a run loop
      // with more steps than scripted turns still terminates.
      const entry = script[Math.min(scriptIndex, script.length - 1)] || { text: "ok" };
      scriptIndex += 1;
      const finishReason = entry.toolCalls ? "tool_calls" : "stop";
      const delta = entry.toolCalls
        ? { role: "assistant", tool_calls: entry.toolCalls }
        : { role: "assistant", content: entry.text ?? "ok" };

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
      res.write(`data: ${JSON.stringify({
        ...chunk({}, finishReason),
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return {
    requests,
    setScript,
    /** Requests that carry the system prompt, i.e. every LLM completion call. */
    completionRequests: () => requests.filter((r) => r.url.includes("/chat/completions")),
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      return { port: address.port, baseUrl: `http://127.0.0.1:${address.port}/v1` };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
