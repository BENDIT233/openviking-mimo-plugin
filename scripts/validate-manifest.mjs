/**
 * Validate `mimo-plugin.json` against MiMo Desktop's own manifest rules.
 *
 * The desktop validates a plugin manifest with a set of hand-written checks
 * inside its main bundle (`app.asar/out/main/index.mjs`). Getting one wrong
 * makes the Plugins page reject the manifest with a Chinese error string and no
 * further detail, so this script ports those checks verbatim and runs the repo
 * manifest through them.
 *
 * Ported rules (function names below are the bundle's own, kept so a future
 * diff against a new bundle is mechanical):
 *   Ga()   id / kebab-case
 *   wEe()  semver
 *   Z7/SEe()  kind ∈ {skill, connector, composite}
 *   _Ee()  path traversal (leading / \ or drive letter, or any `..` segment)
 *   kEe()  components.skills[]
 *   EEe()  components.mcp[]  (local needs command, remote needs url)
 *   IEe()  auth[]            (kind ∈ {apikey, oauth}, no clientSecret in oauth)
 *   Wi()   the whole manifest, returning the normalized shape the desktop uses
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" \
 *     scripts/validate-manifest.mjs [path/to/mimo-plugin.json]
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const KINDS = ["skill", "connector", "composite"];
const PATH_SEPARATOR_RE = /[/\\]/;

const Ga = (value) => typeof value === "string" && KEBAB_RE.test(value);
const wEe = (value) => typeof value === "string" && SEMVER_RE.test(value);
const SEe = (value) => typeof value === "string" && KINDS.includes(value);

/** True when the path is unsafe: absolute, drive-qualified, or contains `..`. */
const _Ee = (value) => {
  const text = String(value || "");
  if (!text) return false;
  if (text.startsWith("/") || text.startsWith("\\") || /^[A-Za-z]:/.test(text)) return true;
  return text.split(PATH_SEPARATOR_RE).some((part) => part === "..");
};

const kr = (value, fallback = "") => (typeof value === "string" ? value : fallback);

function parseComponentsSkills(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const id = kr(entry?.id).trim();
    if (!Ga(id)) throw new Error(`components.skills[${index}].id illegal (needs kebab-case): ${JSON.stringify(entry?.id)}`);
    const path = kr(entry?.path).trim();
    if (!path) throw new Error(`components.skills[${index}].path must not be empty`);
    if (_Ee(path)) throw new Error(`components.skills[${index}].path illegal (looks like traversal): ${JSON.stringify(path)}`);
    return { id, path };
  });
}

function parseComponentsMcp(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const id = kr(entry?.id).trim();
    if (!Ga(id)) throw new Error(`components.mcp[${index}].id illegal (needs kebab-case): ${JSON.stringify(entry?.id)}`);
    const type = entry?.type === "remote" ? "remote" : entry?.type === "local" ? "local" : null;
    if (!type) throw new Error(`components.mcp[${index}].type must be "local" or "remote"`);
    const out = { id, type };
    if (type === "local") {
      const command = Array.isArray(entry?.command) ? entry.command.map((part) => kr(part)).filter(Boolean) : [];
      if (!command.length) throw new Error(`components.mcp[${index}] local needs a non-empty command`);
      out.command = command;
    } else {
      const url = kr(entry?.url).trim();
      if (!url) throw new Error(`components.mcp[${index}] remote needs a url`);
      out.url = url;
      if (entry?.oauth !== undefined) {
        if (!entry.oauth || typeof entry.oauth !== "object" || Array.isArray(entry.oauth)) {
          throw new Error(`components.mcp[${index}].oauth must be an object`);
        }
        if ("clientSecret" in entry.oauth) {
          throw new Error(`components.mcp[${index}].oauth must not declare clientSecret`);
        }
        const oauth = {};
        const clientId = kr(entry.oauth.clientId).trim();
        const clientIdEnv = kr(entry.oauth.clientIdEnv).trim();
        const scope = kr(entry.oauth.scope).trim();
        const redirectUri = kr(entry.oauth.redirectUri).trim();
        if (clientId) oauth.clientId = clientId;
        if (clientIdEnv) oauth.clientIdEnv = clientIdEnv;
        if (scope) oauth.scope = scope;
        if (redirectUri) oauth.redirectUri = redirectUri;
        if (clientId && clientIdEnv) {
          throw new Error(`components.mcp[${index}].oauth may declare only one of clientId/clientIdEnv`);
        }
        out.oauth = oauth;
      }
    }
    if (entry?.env && typeof entry.env === "object" && !Array.isArray(entry.env)) {
      const env = {};
      for (const [key, item] of Object.entries(entry.env)) env[key] = kr(item);
      out.env = env;
    }
    if (entry?.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
      const headers = {};
      for (const [key, item] of Object.entries(entry.headers)) headers[key] = kr(item);
      if (Object.keys(headers).length) out.headers = headers;
    }
    return out;
  });
}

function parseAuth(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const key = kr(entry?.key).trim();
    if (!key) throw new Error(`auth[${index}].key must not be empty`);
    const kind = entry?.kind === "oauth" ? "oauth" : entry?.kind === "apikey" ? "apikey" : null;
    if (!kind) throw new Error(`auth[${index}].kind must be "apikey" or "oauth"`);
    return { key, kind, provider: kr(entry?.provider).trim(), label: kr(entry?.label).trim() || key };
  });
}

/** The desktop's `Wi()`: validate and normalize a manifest. Throws on rejection. */
export function normalizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest is not an object");
  }
  if (!Ga(value.id)) throw new Error(`manifest.id illegal (needs kebab-case): ${JSON.stringify(value.id)}`);
  if (!wEe(value.version)) throw new Error(`manifest.version is not semver: ${JSON.stringify(value.version)}`);
  if (!SEe(value.kind)) throw new Error(`manifest.kind must be one of ${KINDS.join("/")}`);
  const components = value.components && typeof value.components === "object"
    && !Array.isArray(value.components) ? value.components : {};
  return {
    id: value.id,
    name: kr(value.name).trim() || value.id,
    icon: kr(value.icon).trim() || "🧩",
    version: value.version,
    author: kr(value.author).trim() || "MiMo 官方",
    summary: kr(value.summary).trim(),
    homepage: kr(value.homepage).trim(),
    privacy: kr(value.privacy).trim(),
    terms: kr(value.terms).trim(),
    kind: value.kind,
    components: {
      skills: parseComponentsSkills(components.skills),
      mcp: parseComponentsMcp(components.mcp),
    },
    auth: parseAuth(value.auth),
    permissions: Array.isArray(value.permissions)
      ? value.permissions.map((item) => kr(item)).filter(Boolean)
      : [],
  };
}

function main() {
  const target = process.argv[2]
    ? resolve(process.argv[2])
    : join(REPO_ROOT, "mimo-plugin.json");
  const raw = JSON.parse(readFileSync(target, "utf8"));
  const normalized = normalizeManifest(raw);
  process.stdout.write(`VALID: ${target}\n${JSON.stringify(normalized, null, 2)}\n`);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`INVALID: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
