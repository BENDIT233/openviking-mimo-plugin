/**
 * Install (or refresh) the OpenViking MiMo plugin into a MiMoCode config dir.
 *
 * MiMo loads in-process ESM plugins, so "installing" is just placing files
 * where the engine's own module resolution can find them plus one config entry:
 *
 *   <configDir>/plugin/openviking.js   <- repo plugin/  (entry; resolved by the
 *                                                 loader's plugin/*.js glob or
 *                                                 by an explicit `plugin` entry)
 *   <configDir>/lib/                   <- repo lib/     (the vendored shared runtime)
 *   <configDir>/skills/openviking-memory/  <- repo skills/openviking-memory/
 *
 * `plugin/openviking.js` imports `../lib/agent-hook-runtime.mjs`, so the two
 * directories must be siblings exactly as they are inside the repo — that is
 * why lib/ is copied next to plugin/ rather than referenced in place.
 *
 * The config file is NOT touched unless `--write-config` is passed: this
 * project never edits a user's real mimocode.jsonc on its own. Without the
 * flag the required snippet is printed for the user to paste.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" \
 *     scripts/install.mjs [--config-dir DIR] [--write-config] [--copy]
 *
 * Defaults: --config-dir from MIMOCODE_CONFIG_DIR, else ~/.config/mimocode.
 * Links are created when the platform allows it (mklink /J on Windows, symlink
 * elsewhere); pass --copy for a plain recursive copy instead.
 */

import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const PLUGIN_ENTRY_REL = "plugin/openviking.js";

function parseArgs(argv) {
  const out = { writeConfig: false, link: false, configDir: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config-dir" && argv[i + 1]) out.configDir = resolve(argv[++i]);
    else if (arg === "--write-config") out.writeConfig = true;
    else if (arg === "--link") out.link = true;
  }
  if (!out.configDir) {
    out.configDir = resolve(process.env.MIMOCODE_CONFIG_DIR || join(homedir(), ".config", "mimocode"));
  }
  return out;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Place one repo directory at `<configDir>/<name>`, replacing whatever is there.
 *
 * Copy is the default and a symlink is opt-in (`--link`), because linking
 * silently breaks the plugin: Node resolves `@mimo-ai/plugin` from a module's
 * *realpath*, so a linked `plugin/` living under the repo looks for
 * `node_modules` beside the repo rather than beside the config dir. Verified —
 * a junctioned install registers 0 tools where a copied one registers all 15.
 * The link is kept as an option for a config dir on the same volume as a
 * checkout that already has its own `node_modules`.
 */
async function placeDirectory(source, target, { link }) {
  await mkdir(dirname(target), { recursive: true });
  if (await exists(target)) await rm(target, { recursive: true, force: true });

  if (link) {
    for (const type of ["junction", "dir"]) {
      try {
        await symlink(source, target, type);
        return `linked (${type})`;
      } catch { /* try the next link type, then fall back to a copy */ }
    }
  }
  await cp(source, target, { recursive: true });
  return link ? "copied (link unavailable)" : "copied";
}

/**
 * MiMo plugin entries are `.js`, and Node parses a `.js` file as CommonJS first
 * unless a package.json declares `"type": "module"`. Without this the engine
 * emits a MODULE_TYPELESS_PACKAGE_JSON warning and pays a reparse on every
 * start. The file is created only if absent so a user's own package.json (used
 * for `@mimo-ai/plugin` resolution, per the MiMo docs) is never clobbered.
 */
async function ensureModuleType(configDir) {
  const path = join(configDir, "package.json");
  if (existsSync(path)) return "left as-is";
  await writeFile(path, `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`, "utf8");
  return "created";
}

/**
 * Insert the plugin entry into the `plugin` array of the config file
 * (mimocode.jsonc or mimocode.json) without rewriting the file: a JSONC config
 * may carry comments, and a JSON round-trip would destroy them. The insertion
 * is textual and idempotent.
 */
async function writeConfigEntry(configDir, entrySpec) {
  const candidates = ["mimocode.jsonc", "mimocode.json"]
    .map((name) => join(configDir, name))
    .filter((path) => existsSync(path));
  const path = candidates[0] || join(configDir, "mimocode.jsonc");

  if (!existsSync(path)) {
    await writeFile(
      path,
      `${JSON.stringify({ $schema: "https://mimo.xiaomi.com/mimocode/config.json", plugin: [entrySpec] }, null, 2)}\n`,
      "utf8",
    );
    return { path, action: "created" };
  }

  const original = await readFile(path, "utf8");
  if (original.includes(entrySpec)) return { path, action: "already-present" };

  const arrayMatch = original.match(/"plugin"\s*:\s*\[([\s\S]*?)\]/);
  let next;
  if (arrayMatch) {
    const inner = arrayMatch[1].trim();
    const replacement = inner
      ? `"plugin": [${arrayMatch[1].replace(/\s*$/, "")}, ${JSON.stringify(entrySpec)}]`
      : `"plugin": [${JSON.stringify(entrySpec)}]`;
    next = original.replace(arrayMatch[0], replacement);
  } else if (original.trim() === "{}" || /^\s*\{\s*\}\s*$/.test(original)) {
    next = `{\n  "plugin": [${JSON.stringify(entrySpec)}]\n}\n`;
  } else {
    // Insert before the final closing brace, keeping any trailing newline.
    const at = original.lastIndexOf("}");
    if (at === -1) throw new Error(`cannot find an object to extend in ${path}`);
    const head = original.slice(0, at).replace(/\s*$/, "");
    const tail = original.slice(at);
    const separator = head.endsWith("{") ? "\n  " : ",\n  ";
    next = `${head}${separator}"plugin": [${JSON.stringify(entrySpec)}]\n${tail}`;
  }
  await writeFile(path, next, "utf8");
  return { path, action: "updated" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDir = args.configDir;
  await mkdir(configDir, { recursive: true });

  const results = [];
  for (const [name, source] of [
    ["lib", join(REPO_ROOT, "lib")],
    ["plugin", join(REPO_ROOT, "plugin")],
  ]) {
    results.push([name, await placeDirectory(source, join(configDir, name), { link: args.link })]);
  }

  const skillsSource = join(REPO_ROOT, "skills", "openviking-memory");
  const skillsTarget = join(configDir, "skills", "openviking-memory");
  await mkdir(dirname(skillsTarget), { recursive: true });
  if (await exists(skillsTarget)) await rm(skillsTarget, { recursive: true, force: true });
  await cp(skillsSource, skillsTarget, { recursive: true });
  results.push(["skills/openviking-memory", "copied"]);

  const entrySpec = `./${PLUGIN_ENTRY_REL.replace(/\\/g, "/")}`;
  results.push(["package.json", await ensureModuleType(configDir)]);

  process.stdout.write(`config dir: ${configDir}\n`);
  for (const [name, how] of results) process.stdout.write(`  ${name.padEnd(24)} ${how}\n`);

  if (args.writeConfig) {
    const applied = await writeConfigEntry(configDir, entrySpec);
    process.stdout.write(`config:     ${applied.path} (${applied.action})\n`);
  } else {
    process.stdout.write(
      "\nAdd this entry to the \"plugin\" array in "
      + `${join(configDir, "mimocode.jsonc")}:\n\n`
      + `  { "plugin": [${JSON.stringify(entrySpec)}] }\n\n`
      + "Then restart MiMo (plugins load per process). Re-run with --write-config "
      + "to have this script make the edit for you.\n",
    );
  }
  process.stdout.write(
    `plugin entry: ${join(configDir, PLUGIN_ENTRY_REL)}\n`
    + "Diagnostics: ~/.openviking/logs/mimo-hooks.log (set OPENVIKING_DEBUG=1)\n",
  );

  // The plugin imports `@mimo-ai/plugin` and `zod`. They must be resolvable
  // from the config dir's own node_modules — Node walks up from the plugin's
  // realpath, so a checkout elsewhere does not satisfy it.
  const modules = join(configDir, "node_modules", "@mimo-ai", "plugin");
  if (!existsSync(modules)) {
    process.stdout.write(
      "\nWARNING: @mimo-ai/plugin does not resolve from this config dir.\n"
      + `  Expected: ${modules}\n`
      + "  MiMo Desktop normally installs it for you. If the plugin registers no\n"
      + "  tools, run inside the config dir:\n"
      + "    npm install @mimo-ai/plugin@0.1.14\n",
    );
  }
  process.stdout.write("Restart MiMo for the plugin list to reload.\n");
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
