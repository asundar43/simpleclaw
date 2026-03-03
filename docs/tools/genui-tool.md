---
summary: "GenUI tool for proactive rendering of generative UI components"
read_when:
  - Using the genui tool to render UI components proactively
  - Understanding render, update, and dismiss actions
  - Building frontend handling for agent-initiated GenUI events
title: "GenUI Tool"
---

# GenUI tool

The `genui` tool lets the agent **proactively** render generative UI components on connected
frontends, even when not triggered by another tool call.

While the [judge hook](/tools/genui) automatically intercepts tool calls and renders matching
components, the `genui` tool gives the agent direct control over when and what to render.

## When is it used

The judge hook handles the common case: tool X fires, matching component renders. The `genui`
tool handles the case where there is **no tool call** but the agent wants to show a rich UI:

- User says "show me my schedule" — agent calls `genui` with `action: "render"` and
  `componentId: "calendar-view"`
- Agent wants to show a summary card after a conversation — no tool involved
- Agent dismisses a previously rendered component that is no longer relevant

## Parameters

| Parameter     | Type                                    | Required           | Description                                 |
| ------------- | --------------------------------------- | ------------------ | ------------------------------------------- |
| `action`      | `"render"` \| `"update"` \| `"dismiss"` | Yes                | What to do                                  |
| `componentId` | `string`                                | Yes                | The GenUI component to target               |
| `params`      | `Record<string, unknown>`               | No                 | Data to pass to the component               |
| `renderId`    | `string`                                | For update/dismiss | The render ID from a previous render action |

## Actions

### `render`

Show a new UI component on connected frontends.

Broadcasts a `genui.render` WebSocket event with a new unique render ID. The response
includes the `renderId` so the agent can later update or dismiss the component.

```
Agent calls: genui { action: "render", componentId: "calendar-view", params: { date: "2026-03-15" } }
Response:    { ok: true, renderId: "a1b2c3d4-...", componentId: "calendar-view" }
```

### `update`

Update an existing component with new data.

Requires the `renderId` from a previous render. Broadcasts a `genui.update` event.

```
Agent calls: genui { action: "update", componentId: "calendar-view", renderId: "a1b2c3d4-...", params: { events: [...] } }
Response:    { ok: true, renderId: "a1b2c3d4-..." }
```

### `dismiss`

Hide a previously rendered component.

Requires the `renderId`. Broadcasts a `genui.update` event with `dismissed: true`.

```
Agent calls: genui { action: "dismiss", componentId: "calendar-view", renderId: "a1b2c3d4-..." }
Response:    { ok: true, renderId: "a1b2c3d4-...", dismissed: true }
```

## Error handling

| Condition                             | Response                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| No frontend connected                 | `{ ok: false, error: "No frontend connected for GenUI rendering." }` |
| Missing `renderId` for update/dismiss | `{ ok: false, error: "renderId is required for update action." }`    |
| Unknown action                        | `{ ok: false, error: "Unknown action: ..." }`                        |

## WebSocket events

The `genui` tool broadcasts the same events as the [judge hook](/tools/genui#websocket-events):

- **`genui.render`** — for `render` actions
- **`genui.update`** — for `update` and `dismiss` actions

Frontends handle these identically regardless of whether they came from the judge hook or the
`genui` tool. The `toolName` field in `genui.render` payloads is set to `"genui"` when
originating from this tool.

## Availability

The `genui` tool is available to all agents when included in the tool list. It does not
require the judge hook to be enabled — it works independently as long as a frontend is
connected with the `operator.genui` WebSocket scope.

However, the judge hook and the `genui` tool are complementary:

- **Judge hook**: automatic — intercepts existing tool calls and renders matching components
- **GenUI tool**: manual — agent decides when to render, update, or dismiss

## Example conversation

```
User:  Show me my schedule for next week
Agent: [calls genui tool]
       action: "render"
       componentId: "calendar-view"
       params: { startDate: "2026-03-02", endDate: "2026-03-08", view: "week" }

→ Frontend renders a calendar week view

Agent: Here's your schedule for next week. You have 3 meetings on Monday
       and a dentist appointment on Wednesday.

User:  Cancel the dentist appointment
Agent: [calls cancel_appointment tool — judge hook renders confirmation card]
Agent: Done! I've cancelled your Wednesday dentist appointment.

→ Frontend shows confirmation via genui.update from the judge hook

Agent: [calls genui tool]
       action: "update"
       componentId: "calendar-view"
       renderId: "a1b2c3d4-..."
       params: { startDate: "2026-03-02", endDate: "2026-03-08", view: "week" }

→ Frontend refreshes the calendar view without the cancelled appointment
```

Related:

- [Generative UI (GenUI)](/tools/genui) — architecture, judge hook, and registry
- [Hooks](/automation/hooks)
