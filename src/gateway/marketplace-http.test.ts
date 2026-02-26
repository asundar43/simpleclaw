import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";

// ── Mocks ───────────────────────────────────────────────────

let configSnapshot: Record<string, unknown> = {};

vi.mock("../config/config.js", () => ({
  loadConfig: () => configSnapshot,
  writeConfigFile: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../plugins/marketplace.js", () => ({
  fetchCatalogWithAuth: vi.fn().mockResolvedValue({
    version: 1,
    updatedAt: "2026-02-26T00:00:00.000Z",
    registry: "https://us-central1-npm.pkg.dev/jarvis-486806/simpleclaw-npm",
    plugins: [
      {
        id: "msteams",
        name: "msteams",
        description: "Microsoft Teams channel",
        npmSpec: "@simpleclaw/msteams",
        version: "1.0.0",
        kind: "channel",
        tags: [],
      },
    ],
    skills: [
      {
        name: "web-search",
        description: "Web search skill",
        archiveUrl: "gs://simpleclaw-marketplace/skills/web-search-1.0.0.tar.gz",
        version: "1.0.0",
        tags: ["bundled"],
      },
    ],
  }),
}));

vi.mock("../plugins/skill-install.js", () => ({
  installSkillFromArchiveUrl: vi.fn().mockResolvedValue({
    ok: true,
    skillName: "web-search",
    targetDir: "/home/user/.simpleclaw/skills/web-search",
  }),
  recordSkillInstall: vi.fn().mockImplementation((cfg: Record<string, unknown>) => ({
    ...cfg,
    skills: { installs: { "web-search": { source: "marketplace", version: "1.0.0" } } },
  })),
  removeSkillInstall: vi.fn().mockImplementation((cfg: Record<string, unknown>) => ({
    ...cfg,
    skills: {},
  })),
}));

vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec: vi.fn().mockResolvedValue({
    ok: true,
    pluginId: "msteams",
    targetDir: "/home/user/.simpleclaw/plugins/msteams",
    version: "1.0.0",
    npmResolution: undefined,
  }),
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: vi.fn().mockImplementation((cfg: Record<string, unknown>) => ({
    config: cfg,
  })),
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: vi.fn().mockImplementation((cfg: Record<string, unknown>) => cfg),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: vi.fn(),
}));

vi.mock("../plugins/registry-auth.js", () => ({
  resolveRegistryAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: vi.fn().mockImplementation(({ config }: { config: unknown }) => ({
    config,
    warnings: [],
  })),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: vi.fn().mockReturnValue({ plugins: [] }),
}));

vi.mock("../plugins/uninstall.js", () => ({
  uninstallPlugin: vi.fn().mockResolvedValue({
    ok: true,
    config: {},
    pluginId: "msteams",
    actions: {},
    warnings: [],
  }),
}));

vi.mock("../plugins/update.js", () => ({
  updateNpmInstalledPlugins: vi.fn().mockResolvedValue({
    config: {},
    changed: false,
    outcomes: [],
  }),
}));

vi.mock("../infra/gcloud-auth.js", () => ({
  resolveGarAuthToken: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("../cli/npm-resolution.js", () => ({
  buildNpmInstallRecordFields: vi.fn().mockReturnValue({
    source: "npm",
    spec: "@simpleclaw/msteams",
    installPath: "/home/user/.simpleclaw/plugins/msteams",
  }),
}));

const { handleMarketplaceHttpRequest } = await import("./marketplace-http.js");
const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { writeConfigFile } = await import("../config/config.js");

// ── Helpers ─────────────────────────────────────────────────

function makeReq(opts: { url: string; method: string; body?: unknown }): IncomingMessage {
  return {
    url: opts.url,
    method: opts.method,
    headers: { host: "localhost", "content-type": "application/json" },
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn().mockImplementation(function (
      this: { _status: number; _body: unknown; statusCode: number },
      data?: string,
    ) {
      this._status = this.statusCode;
      if (data) {
        try {
          this._body = JSON.parse(data);
        } catch {
          this._body = data;
        }
      }
    }),
  } as unknown as ServerResponse & { _status: number; _body: unknown };
  return res;
}

const defaultOpts = {
  auth: {} as ResolvedGatewayAuth,
};

// ── readJsonBody mock: simulate body parsing ────────────────
// The real readJsonBodyOrError reads from the request stream.
// We need to mock http-common to provide bodies for POST handlers.
vi.mock("./http-common.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http-common.js")>();
  return {
    ...original,
    readJsonBodyOrError: vi.fn().mockResolvedValue({}),
  };
});

const { readJsonBodyOrError } = await import("./http-common.js");

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  configSnapshot = {
    plugins: {
      registry: {
        catalogUrl: "https://simpleclaw-marketplace-625948851089.us-central1.run.app/api/catalog",
        authMethod: "gcloud-adc",
      },
    },
  };
});

describe("handleMarketplaceHttpRequest", () => {
  it("returns false for non-marketplace paths", async () => {
    const req = makeReq({ url: "/api/something-else", method: "GET" });
    const res = makeRes();
    const result = await handleMarketplaceHttpRequest(req, res, defaultOpts);
    expect(result).toBe(false);
  });

  it("returns 401 when auth fails", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      ok: false,
      reason: "unauthorized",
    } as never);
    const req = makeReq({ url: "/api/marketplace/installed", method: "GET" });
    const res = makeRes();
    const result = await handleMarketplaceHttpRequest(req, res, defaultOpts);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/marketplace/installed", () => {
  it("returns installed plugins and skills", async () => {
    configSnapshot = {
      plugins: {
        registry: { catalogUrl: "gs://test/catalog.json" },
        installs: {
          msteams: {
            source: "npm",
            spec: "@simpleclaw/msteams",
            resolvedVersion: "1.0.0",
            installedAt: "2026-02-26T00:00:00.000Z",
          },
        },
      },
      skills: {
        installs: {
          "web-search": {
            source: "marketplace",
            version: "1.0.0",
            installedAt: "2026-02-26T00:00:00.000Z",
          },
        },
      },
    };

    const req = makeReq({ url: "/api/marketplace/installed", method: "GET" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(200);
    const body = res._body as { plugins: unknown[]; skills: unknown[] };
    expect(body.plugins).toHaveLength(1);
    expect(body.skills).toHaveLength(1);
    expect(body.plugins[0]).toMatchObject({ id: "msteams", type: "plugin" });
    expect(body.skills[0]).toMatchObject({ name: "web-search", type: "skill" });
  });

  it("returns empty lists when nothing is installed", async () => {
    configSnapshot = {};
    const req = makeReq({ url: "/api/marketplace/installed", method: "GET" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(200);
    const body = res._body as { plugins: unknown[]; skills: unknown[] };
    expect(body.plugins).toHaveLength(0);
    expect(body.skills).toHaveLength(0);
  });

  it("rejects non-GET methods", async () => {
    const req = makeReq({ url: "/api/marketplace/installed", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);
    expect(res._status).toBe(405);
  });
});

describe("POST /api/marketplace/install", () => {
  it("installs a skill from the catalog", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({ id: "web-search", type: "skill" });

    const req = makeReq({ url: "/api/marketplace/install", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; id: string; type: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("web-search");
    expect(body.type).toBe("skill");
    expect(writeConfigFile).toHaveBeenCalled();
  });

  it("installs a plugin from the catalog", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({ id: "msteams", type: "plugin" });

    const req = makeReq({ url: "/api/marketplace/install", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; id: string; type: string; restartRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("msteams");
    expect(body.type).toBe("plugin");
    expect(body.restartRequired).toBe(true);
  });

  it("returns 404 for unknown ID", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({ id: "nonexistent" });

    const req = makeReq({ url: "/api/marketplace/install", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(404);
    const body = res._body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("nonexistent");
  });

  it("returns 400 when id is missing", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({});

    const req = makeReq({ url: "/api/marketplace/install", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(400);
  });

  it("rejects non-POST methods", async () => {
    const req = makeReq({ url: "/api/marketplace/install", method: "GET" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);
    expect(res._status).toBe(405);
  });
});

describe("POST /api/marketplace/uninstall", () => {
  it("uninstalls a skill", async () => {
    configSnapshot = {
      plugins: { registry: { catalogUrl: "gs://test/catalog.json" } },
      skills: {
        installs: {
          "web-search": {
            source: "marketplace",
            version: "1.0.0",
            installedAt: "2026-02-26T00:00:00.000Z",
          },
        },
      },
    };
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({ id: "web-search", type: "skill" });

    const req = makeReq({ url: "/api/marketplace/uninstall", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; id: string; type: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("web-search");
    expect(body.type).toBe("skill");
  });

  it("uninstalls a plugin", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({ id: "msteams", type: "plugin" });

    const req = makeReq({ url: "/api/marketplace/uninstall", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; type: string; restartRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.type).toBe("plugin");
    expect(body.restartRequired).toBe(true);
  });

  it("returns 404 for uninstalled skill", async () => {
    configSnapshot = {};
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({ id: "unknown", type: "skill" });

    const req = makeReq({ url: "/api/marketplace/uninstall", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(404);
  });

  it("returns 400 when type is missing", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({ id: "something" });

    const req = makeReq({ url: "/api/marketplace/uninstall", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(400);
  });
});

describe("POST /api/marketplace/sync", () => {
  it("returns sync results", async () => {
    vi.mocked(readJsonBodyOrError).mockResolvedValueOnce({});

    const req = makeReq({ url: "/api/marketplace/sync", method: "POST" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);

    expect(res._status).toBe(200);
    const body = res._body as { ok: boolean; changed: boolean; results: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("rejects non-POST methods", async () => {
    const req = makeReq({ url: "/api/marketplace/sync", method: "GET" });
    const res = makeRes();
    await handleMarketplaceHttpRequest(req, res, defaultOpts);
    expect(res._status).toBe(405);
  });
});
