import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { runCommandWithTimeout } from "../process/exec.js";

const LIVE =
  isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.SIMPLECLAW_LIVE_TEST);

const GAR_PROJECT = process.env.GAR_PROJECT ?? "jarvis-486806";
const GAR_REGION = process.env.GAR_REGION ?? "us-central1";
const GAR_VIRTUAL_REPO = process.env.GAR_VIRTUAL_REPO ?? "simpleclaw-virtual";
const GAR_LOCAL_REPO = process.env.GAR_LOCAL_REPO ?? "simpleclaw-npm";
const VIRTUAL_REGISTRY = `https://${GAR_REGION}-npm.pkg.dev/${GAR_PROJECT}/${GAR_VIRTUAL_REPO}/`;

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "simpleclaw-gar-smoke-"));
  tempDirs.push(dir);
  return dir;
}

async function resolveGcloudToken(): Promise<string | null> {
  try {
    const res = await runCommandWithTimeout(["gcloud", "auth", "print-access-token"], {
      timeoutMs: 10_000,
    });
    return res.code === 0 ? res.stdout.trim() : null;
  } catch {
    return null;
  }
}

function buildNpmrc(token: string): string {
  const garHost = `${GAR_REGION}-npm.pkg.dev/${GAR_PROJECT}`;
  return [
    `registry=${VIRTUAL_REGISTRY}`,
    `//${garHost}/${GAR_VIRTUAL_REPO}/:_authToken=${token}`,
    `//${garHost}/${GAR_LOCAL_REPO}/:_authToken=${token}`,
  ].join("\n");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

describe.runIf(LIVE)("GAR virtual repo install", () => {
  it("npm pack simpleclaw from virtual registry downloads a tarball", async () => {
    const token = await resolveGcloudToken();
    expect(token, "gcloud auth token required — run `gcloud auth login` first").toBeTruthy();

    const cwd = await createTempDir();

    await fs.writeFile(path.join(cwd, ".npmrc"), buildNpmrc(token!));

    // npm pack downloads the package tarball without resolving dependencies
    const packResult = await runCommandWithTimeout(
      ["npm", "pack", "simpleclaw", "--registry", VIRTUAL_REGISTRY],
      { timeoutMs: 60_000, cwd },
    );

    expect(packResult.code, `npm pack failed: ${packResult.stderr}`).toBe(0);

    const tarball = packResult.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    expect(tarball).toMatch(/^simpleclaw-.*\.tgz$/);

    const tarballPath = path.join(cwd, tarball!);
    const stat = await fs.stat(tarballPath);
    expect(stat.size).toBeGreaterThan(1000);
  }, 120_000);

  it("npm install from virtual registry resolves simpleclaw + all deps", async () => {
    const token = await resolveGcloudToken();
    expect(token, "gcloud auth token required").toBeTruthy();

    const cwd = await createTempDir();

    // Init a temp package and configure the virtual registry
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "gar-smoke", version: "1.0.0", private: true }),
    );
    await fs.writeFile(path.join(cwd, ".npmrc"), buildNpmrc(token!));

    // Full install — simpleclaw from GAR, deps proxied from npmjs
    const installResult = await runCommandWithTimeout(
      ["npm", "install", "simpleclaw", "--no-audit", "--no-fund"],
      { timeoutMs: 180_000, cwd },
    );

    expect(installResult.code, `npm install failed: ${installResult.stderr}`).toBe(0);

    // Verify core package is installed
    const pkgJsonPath = path.join(cwd, "node_modules", "simpleclaw", "package.json");
    const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));
    expect(pkgJson.name).toBe("simpleclaw");
    expect(pkgJson.version).toBeTruthy();

    // Verify a transitive dep resolved from npmjs (not from GAR)
    const commanderPath = path.join(cwd, "node_modules", "commander", "package.json");
    const commanderExists = await fs
      .stat(commanderPath)
      .then(() => true)
      .catch(() => false);
    expect(commanderExists, "transitive dep 'commander' should be installed from npmjs").toBe(true);
  }, 300_000);

  it("npm install @simpleclaw extension from virtual registry", async () => {
    const token = await resolveGcloudToken();
    expect(token, "gcloud auth token required").toBeTruthy();

    const cwd = await createTempDir();

    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "gar-ext-smoke", version: "1.0.0", private: true }),
    );
    await fs.writeFile(path.join(cwd, ".npmrc"), buildNpmrc(token!));

    const installResult = await runCommandWithTimeout(
      ["npm", "install", "@simpleclaw/discord", "--no-audit", "--no-fund"],
      { timeoutMs: 120_000, cwd },
    );

    expect(installResult.code, `npm install failed: ${installResult.stderr}`).toBe(0);

    const pkgJsonPath = path.join(cwd, "node_modules", "@simpleclaw", "discord", "package.json");
    const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));
    expect(pkgJson.name).toBe("@simpleclaw/discord");
  }, 180_000);
});
