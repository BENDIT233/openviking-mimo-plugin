/**
 * URI-guard behaviour matrix.
 *
 * The guard has two failure modes with very different costs, and both are
 * covered here explicitly:
 *
 *   - A MISS lets a `viking://` URI reach a filesystem tool, which fails
 *     confusingly and teaches the model that OV paths are files.
 *   - A FALSE POSITIVE blocks a legitimate local operation. The dangerous cases
 *     are a `write` whose *document body* mentions a URI (blocking it means the
 *     file is never created) and a shell command that merely echoes one.
 *
 * This runs the real `evaluateMimoUriGuard`; `test/verify.mjs` covers the
 * end-to-end path (a blocked tool call whose cancelReason reaches the model).
 *
 * Run from the repo root — the script stages its own scratch copy under
 * `.tmp-test/` because the guard imports the vendored shared runtime, and a
 * bare module path cannot be linked out of the repo:
 *
 *   ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" \
 *     test/guard-matrix.mjs
 */

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Stage `lib/` + `plugin/` in `.tmp-test/` and return the guard module from
 * there. Staging is what lets `@mimo-ai/plugin` and `zod` resolve: a module's
 * imports are looked up from its own realpath, so the guard must be loaded from
 * a tree that has a `node_modules` beside it (see AGENTS.md).
 */
async function loadGuard() {
  const stage = join(REPO_ROOT, ".tmp-test");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(REPO_ROOT, "lib"), join(stage, "lib"), { recursive: true });
  cpSync(join(REPO_ROOT, "plugin"), join(stage, "plugin"), { recursive: true });
  const modules = join(stage, "node_modules");
  const source = join(homedir(), ".config", "mimocode", "node_modules");
  if (existsSync(source)) {
    try { symlinkSync(source, modules, "junction"); } catch { cpSync(source, modules, { recursive: true }); }
  }
  return import(pathToFileURL(join(stage, "plugin", "uri-guard.mjs")).href);
}

const { evaluateMimoUriGuard } = await loadGuard();

const URI = "viking://user/bendit/memories/profile.md";

/** [tool, args, shouldBlock, label] */
const CASES = [
  // --- file tools: a URI in a path argument must be blocked ----------------
  ["read", { filePath: URI }, true, "read: filePath"],
  ["read", { file_path: URI }, true, "read: file_path (snake_case)"],
  ["read", { path: URI }, true, "read: bare path key"],
  ["view_image", { filePath: URI }, true, "view_image: filePath"],
  ["glob", { pattern: "**/*.md", path: URI }, true, "glob: path"],
  ["glob", { pattern: URI }, true, "glob: pattern is a URI"],
  ["grep", { pattern: "x", path: URI }, true, "grep: path"],
  ["edit", { filePath: URI, old_string: "a", new_string: "b" }, true, "edit: filePath"],
  ["write", { filePath: URI, content: "x" }, true, "write: filePath"],
  ["read", { uris: [URI] }, true, "read: URI inside an array argument"],
  ["read", { options: { target: { filePath: URI } } }, true, "read: URI nested in an object"],

  // --- file tools: a URI that is NOT a path must pass ----------------------
  ["write", { filePath: "/tmp/a.md", content: `see ${URI} for details` }, false,
    "write: document BODY mentions a URI (must not block)"],
  ["write", { filePath: "/tmp/a.md", content: URI }, false,
    "write: content IS a URI (must not block)"],
  ["edit", { filePath: "/tmp/a.md", old_string: `a ${URI}`, new_string: "b" }, false,
    "edit: old_string mentions a URI (must not block)"],
  ["read", { filePath: "/local/path.md" }, false, "read: plain local path"],
  ["glob", { pattern: "**/*.md" }, false, "glob: no URI at all"],

  // --- bash: path use blocked, mere mention allowed ------------------------
  ["bash", { command: `cat ${URI}` }, true, "bash: cat <uri>"],
  ["bash", { command: `ls ${URI}/events` }, true, "bash: ls <uri>/sub"],
  ["bash", { command: `grep needle ${URI}` }, true, "bash: grep path argument"],
  ["bash", { command: `echo hi > ${URI}` }, true, "bash: redirect target"],
  ["bash", { command: `cat > ${URI}` }, true, "bash: heredoc/redirect target"],
  ["bash", { command: `cat --file ${URI}` }, true, "bash: --file flag"],
  ["bash", { command: `cat -f ${URI}` }, true, "bash: -f flag"],
  ["bash", { command: `${URI} | cat` }, true, "bash: URI opens the pipeline"],
  ["bash", { command: `echo "see ${URI} for docs"` }, false,
    "bash: quoted mention only (must not block)"],
  ["bash", { command: `printf '%s' '${URI}'` }, false, "bash: URI as a literal argument"],
  ["bash", { command: "ls -la /tmp" }, false, "bash: no URI"],
  ["exec", { command: `cat ${URI}` }, true, "exec: same rules as bash"],
  ["shell", { command: `cat ${URI}` }, true, "shell: same rules as bash"],

  // --- non-filesystem tools are never touched ------------------------------
  ["webfetch", { url: URI }, false, "webfetch: not a filesystem tool"],
  ["apply_patch", { filePath: URI }, false, "apply_patch: not in the guarded set"],
  ["ov_read", { uris: [URI] }, false, "ov_read: the OV tool itself must pass"],
  ["ov_list", { uri: URI }, false, "ov_list: the OV tool itself must pass"],
];

let failures = 0;
for (const [tool, args, shouldBlock, label] of CASES) {
  const decision = evaluateMimoUriGuard(tool, args);
  const blocked = Boolean(decision);
  const ok = blocked === shouldBlock;
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"}  ${label.padEnd(58)} blocked=${String(blocked).padEnd(5)} expected=${shouldBlock}\n`,
  );
  if (ok && blocked) {
    // Every block must explain itself and name an OV tool to use instead.
    if (!decision.reason.includes("ov_")) {
      failures += 1;
      process.stdout.write(`      ^ FAIL: reason does not name an ov_* tool\n`);
    }
  }
}

process.stdout.write(`\n${CASES.length - failures}/${CASES.length} guard cases correct\n`);
process.exit(failures > 0 ? 1 : 0);
