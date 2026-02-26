import { vi } from "vitest";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";

const chromeUserDataDir = { dir: "/tmp/simpleclaw" };
installChromeUserDataDirHooks(chromeUserDataDir);

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchSimpleClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveSimpleClawUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopSimpleClawChrome: vi.fn(async () => {}),
}));
