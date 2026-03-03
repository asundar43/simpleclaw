---
summary: "Generative UI (GenUI): judge hook, component registry, and WebSocket rendering events"
read_when:
  - Setting up generative UI rendering for connected frontends
  - Configuring the judge hook for tool interception
  - Registering GenUI components via Firebase RTDB or static config
  - Understanding genui.render and genui.update WebSocket events
title: "Generative UI"
---

# Generative UI (GenUI)

Generative UI lets the agent render **rich interactive components** on connected frontends
instead of plain text. When the agent calls a tool, the **judge hook** intercepts the call,
looks up a matching GenUI component, validates parameters, and broadcasts a WebSocket event
that tells the frontend what to render.

Examples: calendar cards, task lists, charts, payment forms, order summaries.

## Architecture overview

```
                       ┌──────────────────────────┐
                       │   Firebase RTDB           │
                       │                           │
                       │  /genui-components/{id}   │
                       │    componentId             │
                       │    toolMappings[]          │
                       │    requiredParams[]        │
                       │    schema                  │
                       └─────┬─────────────┬───────┘
                             │             │
                    reads +  │             │  writes on
                    subscribes             │  admin / frontend
                       ┌─────▼───┐    ┌────▼──────────┐
                       │ Gateway  │    │   Frontend    │
                       │ (judge)  │    │ (React Native │
                       └─────┬────┘    │  or web)      │
                             │         └────▲──────────┘
                       WS: genui.render ────┘
                       WS: genui.update ────┘
```

The system has four layers:

1. **GenUI Component Registry** — maps tool names to UI component definitions. Sourced from Firebase RTDB (dynamic) and/or static config (fallback).
2. **Judge Hook** — a `before_tool_call` + `after_tool_call` hook pair that intercepts tool execution, validates parameters, and broadcasts WebSocket events.
3. **WebSocket Events** — `genui.render` and `genui.update` events delivered to connected frontends.
4. **GenUI Tool** — an optional proactive tool that lets the agent render components even when not triggered by another tool call.

## How it works

```
LLM decides to call a tool (e.g. "add_calendar_event")
  │
  ▼
before_tool_call hook intercepts
  │
  ├─ Lookup toolName in GenUI registry
  │
  ├─ NOT in registry → pass through (tool executes normally, text only)
  │
  └─ IN registry → matching GenUI component found:
      │
      ├─ Validate params against component's requiredParams
      │
      ├─ Params MISSING:
      │   → Block tool call
      │   → Return: "Ask the user for: X, Y. Then try again."
      │   → LLM asks user for missing info, retries later
      │
      └─ Params COMPLETE:
          → Broadcast "genui.render" with { componentId, params, schema }
          → Frontend renders the rich UI component
          → Tool proceeds normally (NOT blocked)
          → After tool executes → broadcast "genui.update" with result
```

Key behavior: when all required parameters are present, the tool is **not blocked**. It
executes normally while the frontend renders a rich visualization. The tool is only blocked
when required parameters are missing, because the frontend cannot render meaningful UI
without the data.

## Configuration

Enable the judge hook in your gateway config (`~/.openclaw/openclaw.json`):

```json5
{
  agents: {
    defaults: {
      judge: {
        enabled: true,

        // Dynamic registry from Firebase RTDB (recommended)
        firebase: {
          url: "https://your-project.firebaseio.com",
          collection: "genui-components", // default
        },

        // Static fallback registry (used when Firebase is not configured
        // or as supplement to Firebase data)
        registry: {
          calendar: {
            componentId: "calendar-event-card",
            toolMappings: ["add_calendar_event", "update_calendar_event"],
            requiredParams: ["title", "date"],
            optionalParams: ["time", "location"],
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                date: { type: "string", format: "date" },
              },
            },
          },
          payment: {
            componentId: "payment-form",
            toolMappings: ["send_payment"],
            requiredParams: ["recipient", "amount"],
          },
        },

        // Optional: LLM fallback for ambiguous mappings
        llmFallback: {
          enabled: false,
          model: "claude-haiku-4-5-20251001",
        },
      },
    },
  },
}
```

### Config reference

| Key                         | Type                                | Default              | Description                                         |
| --------------------------- | ----------------------------------- | -------------------- | --------------------------------------------------- |
| `judge.enabled`             | `boolean`                           | `false`              | Enable the judge hook                               |
| `judge.firebase.url`        | `string`                            | —                    | Firebase RTDB URL                                   |
| `judge.firebase.collection` | `string`                            | `"genui-components"` | RTDB path for component definitions                 |
| `judge.llmFallback.enabled` | `boolean`                           | `false`              | Enable LLM for ambiguous tool-to-component mappings |
| `judge.llmFallback.model`   | `string`                            | —                    | Model ID for LLM fallback calls                     |
| `judge.registry`            | `Record<string, GenUiComponentDef>` | —                    | Static component definitions                        |

## GenUI Component Registry

The registry maintains a mapping of **tool names to UI component definitions**. When the
judge hook intercepts a tool call, it looks up the tool name in this registry to decide
whether a GenUI component should be rendered.

### Component definition

Each component is a `GenUiComponentDef`:

```typescript
type GenUiComponentDef = {
  componentId: string; // unique ID matching the frontend component
  toolMappings: string[]; // tool names that trigger this component
  requiredParams: string[]; // params that must be present to render
  optionalParams?: string[]; // additional optional params
  schema?: Record<string, unknown>; // JSON Schema for the component
  displayName?: string; // human-readable name
};
```

### Data sources

The registry loads from two sources, in order:

1. **Firebase RTDB** (dynamic) — the gateway fetches component definitions from
   `{firebase.url}/{collection}.json` on startup and polls for updates every 30 seconds.
   This lets you add, update, or remove GenUI components from an admin UI without
   restarting the gateway.

2. **Static config** (fallback) — definitions under `agents.defaults.judge.registry` in
   `openclaw.json`. Used when Firebase is not configured, or as a supplement that fills gaps
   not covered by Firebase.

When both are configured, Firebase data takes precedence. Static entries are merged in only
for component IDs that Firebase did not provide.

### Firebase RTDB structure

Store component definitions at the configured collection path:

```
/genui-components
  /calendar
    componentId: "calendar-event-card"
    toolMappings: ["add_calendar_event", "update_calendar_event"]
    requiredParams: ["title", "date"]
    optionalParams: ["time", "location"]
    schema: { ... }
  /payment
    componentId: "payment-form"
    toolMappings: ["send_payment"]
    requiredParams: ["recipient", "amount"]
```

The key names (e.g. `calendar`, `payment`) are arbitrary — only the inner fields matter.

### Multiple components per tool

A single tool can map to multiple GenUI components. For example, you might have both a
`simple-calendar` and a `detailed-calendar` for `add_calendar_event`. When multiple
components match, the judge currently picks the first match. LLM fallback (when enabled)
can resolve ambiguous cases.

### Parameter validation

Before rendering, the judge validates the tool call parameters against the component's
`requiredParams`. Values of `undefined`, `null`, and empty string `""` are treated as
missing. Values of `0` and `false` are valid.

If any required parameters are missing, the tool call is **blocked** with a descriptive
reason telling the LLM what to ask the user for:

```
Cannot render rich UI — missing required information.
Ask the user for: date, location. Then try this tool call again with all parameters.
```

## Judge Hook

The judge registers two hooks on the plugin system:

### `before_tool_call`

Runs before every tool execution. The handler:

1. Looks up `event.toolName` in the GenUI registry
2. If no match: returns `undefined` (pass through, tool executes normally)
3. If match found: validates parameters against `requiredParams`
   - **Missing params**: returns `{ block: true, blockReason: "..." }` — tool is blocked
   - **Params complete**: broadcasts `genui.render` event, returns `undefined` — tool proceeds

### `after_tool_call`

Runs after a tool completes execution. If a `genui.render` was broadcast for this tool
call, the handler broadcasts `genui.update` with the tool's result so the frontend can
update the component (e.g., show a confirmation ID, status badge, or error state).

### Hook registration

The judge hooks are registered as `"builtin:judge"` with priority `100` (high priority,
runs before other hooks). Registration happens automatically during plugin loading when
`agents.defaults.judge.enabled` is `true`.

## WebSocket events

The judge broadcasts two event types over the gateway WebSocket:

### `genui.render`

Sent when a tool call has complete parameters and a matching GenUI component is found.

```typescript
{
  id: string;                      // unique render ID (UUID)
  sessionKey?: string;             // session that triggered the render
  componentId: string;             // which frontend component to render
  params: Record<string, unknown>; // data for the component
  schema?: Record<string, unknown>; // JSON Schema describing the component
  toolName: string;                // which tool triggered this
  ts: number;                      // timestamp
}
```

### `genui.update`

Sent after the tool executes, paired with the original render via the `id` field.

```typescript
{
  id: string;        // same render ID from genui.render
  toolResult: unknown; // the tool's execution result
  isError?: boolean;  // true if the tool errored
  ts: number;        // timestamp
}
```

### Scope guard

GenUI events are gated by the `operator.genui` WebSocket scope. Clients must have this
scope to receive `genui.render` and `genui.update` events.

## Frontend integration

To render GenUI components on your frontend:

1. **Connect** to the gateway WebSocket with the `operator.genui` scope.

2. **Listen** for `genui.render` events. When received:
   - Look up `componentId` in your local component map
   - Render the component with the provided `params` and `schema`
   - Store the `id` for pairing with updates

3. **Listen** for `genui.update` events. When received:
   - Match `id` to the previously rendered component
   - Update the component with `toolResult` data
   - Handle `isError: true` for error states
   - Handle `dismissed: true` for dismiss events

### Example (React Native)

```typescript
// Listen for GenUI events
ws.on("genui.render", (payload) => {
  const { id, componentId, params, schema } = payload;
  // Render the component
  renderGenUiComponent(id, componentId, params, schema);
});

ws.on("genui.update", (payload) => {
  const { id, toolResult, isError, dismissed } = payload;
  if (dismissed) {
    removeGenUiComponent(id);
  } else {
    updateGenUiComponent(id, toolResult, isError);
  }
});
```

## GenUI tool (proactive rendering)

In addition to the judge hook (which intercepts existing tool calls), the agent has access
to a dedicated `genui` tool that lets it **proactively** render components.

Use case: the user asks "show me my schedule" — no tool call is involved, but the agent
can call the `genui` tool to render a calendar view directly.

See [GenUI Tool](/tools/genui-tool) for the full tool reference.

## Lifecycle

```
Gateway starts
  │
  ├─ Plugin loader calls registerJudgeHook()
  │   ├─ Resolves config from agents.defaults.judge
  │   ├─ If disabled → skip
  │   └─ If enabled:
  │       ├─ Initialize GenUI registry
  │       │   ├─ Fetch from Firebase RTDB (if configured)
  │       │   ├─ Start 30s polling for updates
  │       │   └─ Load static config as fallback/supplement
  │       ├─ Register before_tool_call hook
  │       └─ Register after_tool_call hook
  │
  ├─ genui tool added to agent tool list
  │
  └─ Gateway broadcast function wired to judge module
```

The GenUI registry polls Firebase every 30 seconds, so component changes are picked up
without a gateway restart. The registry is cleaned up via `dispose()` on shutdown.

## Troubleshooting

**No GenUI events arriving on frontend:**

- Verify `agents.defaults.judge.enabled: true` in config
- Check that the WebSocket client has the `operator.genui` scope
- Look for `judge` subsystem logs (`judge disabled or not configured`)

**Tool blocked unexpectedly:**

- The judge blocks tool calls when required params are missing
- Check the component's `requiredParams` in Firebase or static config
- The block reason tells the LLM exactly which params to ask for

**Firebase not loading components:**

- Verify the `firebase.url` is accessible from the gateway host
- Check for `Firebase RTDB fetch failed` warnings in logs
- Ensure the RTDB path matches `collection` config (default: `genui-components`)
- Firebase RTDB rules must allow read access for the gateway

**Components not updating after Firebase changes:**

- The registry polls every 30 seconds — wait for the next poll cycle
- Check logs for `loaded N GenUI components from Firebase RTDB`

Related:

- [GenUI Tool](/tools/genui-tool)
- [Hooks](/automation/hooks)
- [Architecture](/concepts/architecture)
- [Gateway Configuration](/gateway/configuration)
