import type { Skill } from "@mariozechner/pi-coding-agent";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import {
  getFrontmatterString,
  normalizeStringList,
  parseSimpleClawManifestInstallBase,
  parseFrontmatterBool,
  resolveSimpleClawManifestBlock,
  resolveSimpleClawManifestInstall,
  resolveSimpleClawManifestOs,
  resolveSimpleClawManifestRequires,
} from "../../shared/frontmatter.js";
import type {
  SimpleClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
  SkillWatchEntry,
} from "./types.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  const parsed = parseSimpleClawManifestInstallBase(input, [
    "brew",
    "node",
    "go",
    "uv",
    "download",
    "script",
  ]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec: SkillInstallSpec = {
    kind: parsed.kind as SkillInstallSpec["kind"],
  };

  if (parsed.id) {
    spec.id = parsed.id;
  }
  if (parsed.label) {
    spec.label = parsed.label;
  }
  if (parsed.bins) {
    spec.bins = parsed.bins;
  }
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  const formula = typeof raw.formula === "string" ? raw.formula.trim() : "";
  if (formula) {
    spec.formula = formula;
  }
  const cask = typeof raw.cask === "string" ? raw.cask.trim() : "";
  if (!spec.formula && cask) {
    spec.formula = cask;
  }
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.module === "string") {
    spec.module = raw.module;
  }
  if (typeof raw.url === "string") {
    spec.url = raw.url;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }
  const cmd = typeof raw.cmd === "string" ? raw.cmd.trim() : "";
  if (cmd) {
    spec.cmd = cmd;
  }

  return spec;
}

/** Characters not allowed in hookPath to prevent path traversal. */
const UNSAFE_HOOK_PATH_RE = /[/\\]|\.\./;

function parseWatchEntry(input: unknown): SkillWatchEntry | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return undefined;
  }

  const command = normalizeStringList(raw.command);
  if (command.length === 0) {
    return undefined;
  }

  const hookPath = typeof raw.hookPath === "string" ? raw.hookPath.trim() : "";
  if (!hookPath || UNSAFE_HOOK_PATH_RE.test(hookPath)) {
    return undefined;
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return undefined;
  }

  const entry: SkillWatchEntry = { id, command, hookPath, name };

  if (typeof raw.messageTemplate === "string" && raw.messageTemplate.trim()) {
    entry.messageTemplate = raw.messageTemplate.trim();
  }
  if (typeof raw.sessionKey === "string" && raw.sessionKey.trim()) {
    entry.sessionKey = raw.sessionKey.trim();
  }
  if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof v === "string") {
        env[k] = v;
      }
    }
    if (Object.keys(env).length > 0) {
      entry.env = env;
    }
  }

  return entry;
}

function parseWatchEntries(metadataObj: Record<string, unknown>): SkillWatchEntry[] | undefined {
  const watchRaw = metadataObj.watch;
  if (!watchRaw) {
    return undefined;
  }
  const items = Array.isArray(watchRaw) ? (watchRaw as unknown[]) : [watchRaw];
  const entries = items
    .map((item) => parseWatchEntry(item))
    .filter((entry): entry is SkillWatchEntry => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
}

export function resolveSimpleClawMetadata(
  frontmatter: ParsedSkillFrontmatter,
): SimpleClawSkillMetadata | undefined {
  const metadataObj = resolveSimpleClawManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveSimpleClawManifestRequires(metadataObj);
  const install = resolveSimpleClawManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveSimpleClawManifestOs(metadataObj);
  const watch = parseWatchEntries(metadataObj);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : undefined,
    homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : undefined,
    skillKey: typeof metadataObj.skillKey === "string" ? metadataObj.skillKey : undefined,
    primaryEnv: typeof metadataObj.primaryEnv === "string" ? metadataObj.primaryEnv : undefined,
    os: osRaw.length > 0 ? osRaw : undefined,
    requires: requires,
    install: install.length > 0 ? install : undefined,
    watch,
  };
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterString(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}
