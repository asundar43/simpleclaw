import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSkillInstall, removeSkillInstall } from "./skill-install.js";

// Mock the external dependencies used by installSkillFromArchiveUrl
vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../infra/archive.js", () => ({
  extractArchive: vi.fn(),
}));

describe("recordSkillInstall", () => {
  it("stores install metadata for the skill name", () => {
    const next = recordSkillInstall(
      {},
      {
        skillName: "my-skill",
        source: "marketplace",
        version: "1.0.0",
        archiveUrl: "gs://bucket/skills/my-skill-1.0.0.tar.gz",
      },
    );
    expect(next.skills?.installs?.["my-skill"]).toMatchObject({
      source: "marketplace",
      version: "1.0.0",
      archiveUrl: "gs://bucket/skills/my-skill-1.0.0.tar.gz",
    });
    expect(typeof next.skills?.installs?.["my-skill"]?.installedAt).toBe("string");
  });

  it("preserves existing config fields", () => {
    const existing = {
      skills: {
        allowBundled: ["github"],
        entries: { github: { enabled: true } },
      },
    };
    const next = recordSkillInstall(existing, {
      skillName: "custom",
      source: "marketplace",
      version: "2.0.0",
    });
    expect(next.skills?.allowBundled).toEqual(["github"]);
    expect(next.skills?.entries?.github).toEqual({ enabled: true });
    expect(next.skills?.installs?.custom?.source).toBe("marketplace");
  });

  it("preserves other skill install records when adding a new one", () => {
    const existing = {
      skills: {
        installs: {
          "existing-skill": {
            source: "marketplace" as const,
            version: "1.0.0",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    };
    const next = recordSkillInstall(existing, {
      skillName: "new-skill",
      source: "archive",
      version: "3.0.0",
    });
    expect(next.skills?.installs?.["existing-skill"]?.version).toBe("1.0.0");
    expect(next.skills?.installs?.["new-skill"]?.version).toBe("3.0.0");
  });

  it("updates existing install record for same skill", () => {
    const existing = {
      skills: {
        installs: {
          "my-skill": {
            source: "marketplace" as const,
            version: "1.0.0",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    };
    const next = recordSkillInstall(existing, {
      skillName: "my-skill",
      source: "marketplace",
      version: "2.0.0",
      archiveUrl: "gs://bucket/skills/my-skill-2.0.0.tar.gz",
    });
    expect(next.skills?.installs?.["my-skill"]?.version).toBe("2.0.0");
    expect(next.skills?.installs?.["my-skill"]?.archiveUrl).toContain("2.0.0");
  });
});

describe("removeSkillInstall", () => {
  it("removes a skill install record", () => {
    const existing = {
      skills: {
        installs: {
          "my-skill": {
            source: "marketplace" as const,
            version: "1.0.0",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
          "other-skill": {
            source: "archive" as const,
            version: "2.0.0",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    };
    const next = removeSkillInstall(existing, "my-skill");
    expect(next.skills?.installs?.["my-skill"]).toBeUndefined();
    expect(next.skills?.installs?.["other-skill"]).toBeDefined();
  });

  it("sets installs to undefined when last record is removed", () => {
    const existing = {
      skills: {
        installs: {
          "only-skill": {
            source: "marketplace" as const,
            version: "1.0.0",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    };
    const next = removeSkillInstall(existing, "only-skill");
    expect(next.skills?.installs).toBeUndefined();
  });
});

describe("installSkillFromArchiveUrl", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-install-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects skill names with path traversal", async () => {
    // Import dynamically to use mocked dependencies
    const { installSkillFromArchiveUrl } = await import("./skill-install.js");

    const result = await installSkillFromArchiveUrl({
      name: "../escape",
      archiveUrl: "https://example.com/skill.tar.gz",
      managedSkillsDir: tmpDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid skill name");
    }
  });

  it("rejects skill names starting with a dot", async () => {
    const { installSkillFromArchiveUrl } = await import("./skill-install.js");

    const result = await installSkillFromArchiveUrl({
      name: ".hidden",
      archiveUrl: "https://example.com/skill.tar.gz",
      managedSkillsDir: tmpDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cannot start with a dot");
    }
  });

  it("returns error when download fails", async () => {
    const { fetchWithSsrFGuard } = await import("../infra/net/fetch-guard.js");
    const mockFetch = vi.mocked(fetchWithSsrFGuard);
    mockFetch.mockResolvedValueOnce({
      response: new Response(null, { status: 404, statusText: "Not Found" }),
      finalUrl: "https://example.com/skill.tar.gz",
      release: vi.fn().mockResolvedValue(undefined),
    });

    const { installSkillFromArchiveUrl } = await import("./skill-install.js");

    const result = await installSkillFromArchiveUrl({
      name: "test-skill",
      archiveUrl: "https://example.com/skill.tar.gz",
      managedSkillsDir: tmpDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
    }
  });

  it("returns error when archive has no SKILL.md", async () => {
    const { fetchWithSsrFGuard } = await import("../infra/net/fetch-guard.js");
    const { extractArchive } = await import("../infra/archive.js");
    const mockFetch = vi.mocked(fetchWithSsrFGuard);
    const mockExtract = vi.mocked(extractArchive);

    // Simulate a successful download
    mockFetch.mockResolvedValueOnce({
      response: new Response(Buffer.from("fake-archive")),
      finalUrl: "https://example.com/skill.tar.gz",
      release: vi.fn().mockResolvedValue(undefined),
    });

    // Simulate extraction that creates an empty directory (no SKILL.md)
    mockExtract.mockImplementation(async (params) => {
      await fs.mkdir(params.destDir, { recursive: true });
    });

    const { installSkillFromArchiveUrl } = await import("./skill-install.js");

    const result = await installSkillFromArchiveUrl({
      name: "bad-skill",
      archiveUrl: "https://example.com/skill.tar.gz",
      managedSkillsDir: tmpDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("SKILL.md");
    }
  });

  it("installs successfully when archive contains SKILL.md", async () => {
    const { fetchWithSsrFGuard } = await import("../infra/net/fetch-guard.js");
    const { extractArchive } = await import("../infra/archive.js");
    const mockFetch = vi.mocked(fetchWithSsrFGuard);
    const mockExtract = vi.mocked(extractArchive);

    mockFetch.mockResolvedValueOnce({
      response: new Response(Buffer.from("fake-archive")),
      finalUrl: "https://example.com/skill.tar.gz",
      release: vi.fn().mockResolvedValue(undefined),
    });

    // Simulate extraction that creates SKILL.md
    mockExtract.mockImplementation(async (params) => {
      await fs.mkdir(params.destDir, { recursive: true });
      await fs.writeFile(
        path.join(params.destDir, "SKILL.md"),
        "---\nname: good-skill\n---\n# Good Skill",
      );
    });

    const { installSkillFromArchiveUrl } = await import("./skill-install.js");

    const result = await installSkillFromArchiveUrl({
      name: "good-skill",
      archiveUrl: "gs://bucket/skills/good-skill-1.0.0.tar.gz",
      managedSkillsDir: tmpDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skillName).toBe("good-skill");
      expect(result.targetDir).toBe(path.join(tmpDir, "good-skill"));
    }

    // Verify the skill was copied to the target directory
    const skillMd = await fs.readFile(path.join(tmpDir, "good-skill", "SKILL.md"), "utf-8");
    expect(skillMd).toContain("good-skill");
  });
});
