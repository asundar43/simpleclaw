import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillWatchEntry } from "../agents/skills/types.js";
import {
  getRunningSkillWatcherIds,
  isSkillWatcherRunning,
  startSkillWatcher,
  stopAllSkillWatchers,
  stopSkillWatcher,
} from "./skill-watcher.js";

// Mock child_process.spawn to avoid actually running commands
const mockStdout = {
  on: vi.fn(),
  [Symbol.asyncIterator]: vi.fn(),
};
const mockStderr = { on: vi.fn() };
const mockChild = {
  stdout: mockStdout,
  stderr: mockStderr,
  on: vi.fn(),
  kill: vi.fn(),
  pid: 12345,
};

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const spawnMock = vi.mocked(spawn);

const hookConfig = {
  port: 18789,
  hooksBasePath: "/hooks",
  token: "test-token",
};

const baseEntry: SkillWatchEntry = {
  id: "test-watcher",
  command: ["echo", "test"],
  hookPath: "test-hook",
  name: "Test Watcher",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset on/kill handlers
  mockChild.on.mockImplementation(() => mockChild);
  mockChild.kill.mockImplementation(() => {});
});

afterEach(async () => {
  await stopAllSkillWatchers();
});

describe("startSkillWatcher", () => {
  it("starts a watcher and tracks it", () => {
    startSkillWatcher(baseEntry, hookConfig);
    expect(isSkillWatcherRunning("test-watcher")).toBe(true);
    expect(getRunningSkillWatcherIds()).toContain("test-watcher");
  });

  it("does not start a duplicate watcher", () => {
    startSkillWatcher(baseEntry, hookConfig);
    startSkillWatcher(baseEntry, hookConfig);
    // spawn is called only once for the same id
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("spawns the command from the entry", () => {
    const entry: SkillWatchEntry = {
      ...baseEntry,
      command: ["gws", "gmail", "+watch"],
    };
    startSkillWatcher(entry, hookConfig);
    expect(spawnMock).toHaveBeenCalledWith("gws", ["gmail", "+watch"], expect.any(Object));
  });

  it("passes env vars to the subprocess", () => {
    const entry: SkillWatchEntry = {
      ...baseEntry,
      id: "env-watcher",
      env: { FOO: "bar" },
    };
    startSkillWatcher(entry, hookConfig);
    const spawnCall = spawnMock.mock.calls.find(
      (call) => (call[2] as { env?: Record<string, string> })?.env?.FOO === "bar",
    );
    expect(spawnCall).toBeTruthy();
  });
});

describe("stopSkillWatcher", () => {
  it("stops a running watcher", async () => {
    // Simulate the exit event being emitted when SIGTERM is sent
    mockChild.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "exit") {
        setTimeout(() => cb(0, null), 10);
      }
      return mockChild;
    });

    startSkillWatcher(baseEntry, hookConfig);
    expect(isSkillWatcherRunning("test-watcher")).toBe(true);

    await stopSkillWatcher("test-watcher");
    expect(isSkillWatcherRunning("test-watcher")).toBe(false);
    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("is a no-op for unknown watcher id", async () => {
    await stopSkillWatcher("nonexistent");
    // Should not throw
  });
});

describe("stopAllSkillWatchers", () => {
  it("stops all running watchers", async () => {
    mockChild.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "exit") {
        setTimeout(() => cb(0, null), 10);
      }
      return mockChild;
    });

    startSkillWatcher({ ...baseEntry, id: "w1" }, hookConfig);
    startSkillWatcher({ ...baseEntry, id: "w2" }, hookConfig);

    expect(getRunningSkillWatcherIds()).toHaveLength(2);

    await stopAllSkillWatchers();
    expect(getRunningSkillWatcherIds()).toHaveLength(0);
  });
});
