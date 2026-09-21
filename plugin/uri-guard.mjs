/**
 * `viking://` URI guard for MiMo's built-in filesystem tools.
 *
 * MiMo's file tools take a single `filePath` (`read`/`edit`/`write`), a
 * `path`/`pattern` pair (`glob`/`grep`), or a `command` string (`bash`), and
 * `tool.execute.before` exposes them as `output.args`. That is a different
 * shape from the Claude/Kimi hook payloads `lib/agent-uri-guard.mjs` is keyed
 * on, so the sweep and the per-tool hints live here; URI/text detection itself
 * is the shared, already-hardened `lib/uri-guard.mjs`.
 *
 * Two behaviours are load-bearing and were findings, not preferences:
 *
 *  - Only *file* tools are cancelled by an argument URI. A local `write` call
 *    whose document body merely mentions `viking://...` must still create the
 *    file; `uri-guard.mjs` skips content keys by name at any depth for exactly
 *    that reason.
 *  - `bash` is cancelled only when the URI is used as a path argument, never
 *    when it merely appears in the command text (`echo "see viking://x"`,
 *    `grep viking:// README.md`). Bash has no schema, so this is a judgement
 *    call: a command whose viking:// token is preceded by a path-consuming
 *    verb, or that starts with one, is treated as a path use.
 */

import { buildGuardMessage, findVikingUri, normalizeToolName } from "../lib/uri-guard.mjs";

/** MiMo tool ids that address the local filesystem, and their OV replacement. */
const FILE_TOOL_HINTS = {
  read: {
    tool: "ov_read",
    example: (uri) => `ov_read(uris=["${uri}"])`,
  },
  view_image: {
    tool: "ov_read",
    example: (uri) => `ov_read(uris=["${uri}"])`,
  },
  glob: {
    tool: "ov_glob",
    example: (uri, args = {}) => `ov_glob(uri="${uri}", pattern="${esc(String(args.pattern ?? "**/*"))}")`,
  },
  grep: {
    tool: "ov_grep",
    example: (uri, args = {}) => `ov_grep(uri="${uri}", pattern=["${esc(String(args.pattern ?? ""))}"])`,
  },
  edit: {
    tool: "ov_edit",
    example: (uri) => `ov_edit(uri="${uri}", old_string="...", new_string="...")`,
  },
  write: {
    tool: "ov_write",
    example: (uri) => `ov_write(uri="${uri}", content="...")`,
  },
};

/** Bash verbs that consume the following token as a path. */
const PATH_VERBS = [
  "cat", "bat", "less", "more", "head", "tail", "open", "ls", "dir", "stat", "file",
  "wc", "readlink", "realpath", "du", "tree", "grep", "rg", "ag", "find", "sed",
  "awk", "cut", "sort", "uniq", "diff", "cp", "mv", "rm", "mkdir", "rmdir",
  "touch", "chmod", "chown", "vi", "vim", "nano", "notepad", "type", "get-content",
  "get-item", "select-string", "test-path", "code", "start",
];

function esc(value) {
  return String(value ?? "").replaceAll('"', '\\"');
}

/**
 * Is the `viking://` token in this shell command being used as a path?
 *
 * Bash has no schema, so this is a heuristic over the words around the URI —
 * the command cannot be parsed reliably without a shell. The rule is "is a
 * command reading or writing this token as a file": the URI opening the command
 * or a pipeline stage, following a path verb, following a path flag, or sitting
 * on either side of a redirect. A token that is merely *mentioned* (inside
 * quotes, after `printf`, in a comment) is not a path use and must pass — the
 * false-positive cost there is blocking a perfectly good command.
 */
export function bashUsesVikingUriAsPath(command) {
  const text = String(command || "");
  const match = text.match(/\bviking:\/\/[^\s"'`<>)|;&]*/i);
  if (!match) return null;
  const uri = match[0];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + uri.length);

  // The URI is the command's first token: `viking://x | cat`, `viking://x`,
  // or after a leading pipe. A command cannot *begin* with a quoted mention, so
  // this is a path use regardless of what follows.
  if (!before.trim() || /[|;&]\s*$/.test(before)) return uri;

  const words = before.trim().split(/[\s|;&()]+/).filter(Boolean);
  const lastWord = (words[words.length - 1] || "").toLowerCase();
  if (PATH_VERBS.includes(lastWord)) return uri;
  const firstWord = (words[0] || "").toLowerCase();
  if (PATH_VERBS.includes(firstWord)) return uri;
  // Flags that take a path: `--file viking://x`, `-f viking://x`.
  if (/^-{1,2}[a-z]*f(ile)?$/i.test(lastWord)) return uri;
  // A redirect target is unambiguously a path: `... > viking://x`.
  if (/[>]\s*$/.test(before)) return uri;
  // `cat < viking://x`
  if (/<\s*$/.test(before)) return uri;
  // Trailing shell punctuation after a lone URI argument still counts.
  if (!after.trim()) return uri;
  return null;
}

/**
 * Decide whether a MiMo tool call must be blocked.
 *
 * @returns {null | {uri: string, reason: string}}
 */
export function evaluateMimoUriGuard(toolName, args) {
  const name = normalizeToolName(toolName);
  if (!args || typeof args !== "object") return null;

  if (name === "bash" || name === "exec" || name === "shell") {
    const command = args.command ?? args.cmd ?? args.script ?? "";
    const uri = bashUsesVikingUriAsPath(command);
    if (!uri) return null;
    return {
      uri,
      reason: buildGuardMessage(uri, {
        tool: "the OpenViking tools (ov_read / ov_list / ov_search)",
        example: `ov_read(uris=["${uri}"])`,
      }),
    };
  }

  const hint = FILE_TOOL_HINTS[name];
  if (!hint) return null;
  const uri = findVikingUri(args);
  if (!uri) return null;
  return {
    uri,
    reason: buildGuardMessage(uri, {
      tool: hint.tool,
      example: hint.example(uri, args),
    }),
  };
}
