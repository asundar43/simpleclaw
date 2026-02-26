import type { SimpleClawPluginApi } from "simpleclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "simpleclaw/plugin-sdk";
import { createDiagnosticsOtelService } from "./src/service.js";

const plugin = {
  id: "diagnostics-otel",
  name: "Diagnostics OpenTelemetry",
  description: "Export diagnostics events to OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api: SimpleClawPluginApi) {
    api.registerService(createDiagnosticsOtelService());
  },
};

export default plugin;
