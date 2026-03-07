---
name: Google Workspace
description: Connect your Google account to access Gmail, Calendar, Drive, Contacts, Sheets, Docs, and Tasks.
metadata:
  {
    "openclaw":
      {
        "emoji": "\uD83D\uDD17",
        "requires": { "bins": ["gws"] },
        "install":
          [
            {
              "id": "bundled",
              "kind": "script",
              "cmd": 'ARCH=$(uname -m); OS=$(uname -s | tr A-Z a-z); case $ARCH in x86_64) ARCH=amd64;; aarch64) ARCH=arm64;; esac; BIN=bin/gws-${OS}-${ARCH}; [ -f "$BIN" ] && chmod +x "$BIN" && cp "$BIN" /usr/local/bin/gws',
              "bins": ["gws"],
              "label": "Install gws (bundled)",
            },
            {
              "id": "npm",
              "kind": "script",
              "cmd": "npm install -g @googleworkspace/cli",
              "bins": ["gws"],
              "label": "Install gws via npm (fallback)",
            },
          ],
        "watch":
          [
            {
              "id": "gws-gmail",
              "command":
                [
                  "gwsc",
                  "gmail",
                  "+watch",
                  "--project",
                  "jarvis-486806",
                  "--label-ids",
                  "INBOX",
                  "--format",
                  "full",
                ],
              "hookPath": "gws-gmail",
              "name": "Gmail",
              "messageTemplate": "New email received.\nFrom: {{from}}\nSubject: {{subject}}\nPreview: {{snippet}}\n\nEvaluate this email's importance. If it's marketing or automated, acknowledge briefly. If it requires action, summarize clearly.",
              "sessionKey": "hook:gws-gmail:{{messageId}}",
            },
            {
              "id": "gws-events",
              "command": ["gwsc", "events", "+subscribe", "--project", "jarvis-486806"],
              "hookPath": "gws-events",
              "name": "Workspace Events",
              "messageTemplate": "Google Workspace event: {{type}}\nDetails: {{payload}}\n\nSummarize what happened and whether I need to take action.",
              "sessionKey": "hook:gws-events:{{eventId}}",
            },
          ],
        "requiredConnections": ["google"],
      },
  }
---

# Google Workspace

Connect your Google account and access Gmail, Calendar, Drive, Contacts, Sheets, Docs, and Tasks.

## Setup

Before running any gwsc command, run:

```bash
bash ~/.openclaw/skills/google-workspace/setup.sh
```

This opens your browser to sign in with Google. Wait for it to complete before running commands.

If setup reports missing permissions, disconnect and reconnect your Google account at the marketplace, granting all permissions on the consent screen. If gwsc commands fail with auth errors, re-run setup.sh.

Do not tell users to create GCP projects, OAuth clients, or run `gws auth` commands. All auth is handled by setup.sh.

## After connecting

Once setup.sh completes successfully, immediately do the following without waiting for the user to ask:

1. Fetch recent unread emails:
   `gwsc gmail users messages list --params '{"userId":"me","q":"is:unread newer_than:1d","maxResults":5}'`
2. Fetch today's calendar events:
   `gwsc calendar events list --params '{"calendarId":"primary","timeMin":"<today>T00:00:00Z","timeMax":"<tomorrow>T00:00:00Z","singleEvents":true,"orderBy":"startTime"}'`
3. Present a brief, natural summary:
   - "Connected as you@gmail.com"
   - Unread email highlights (sender + subject, grouped if many)
   - Today's upcoming events
   - If inbox is empty / no events, say so briefly

Keep it concise — a quick glance, not a full report. If any command fails (e.g., missing Calendar scope), skip it silently and summarize what you could access.

## Commands (only use after setup.sh succeeds)

Always use `gwsc` (not `gws`) — the wrapper handles auth automatically. Output is JSON by default. Use `gws schema <method>` to discover parameters for any API method.

### Gmail

- `gwsc gmail users messages list --params '{"userId":"me","q":"newer_than:7d"}'` — search inbox
- `gwsc gmail +send --to user@example.com --subject "Hello" --body "Body"` — send email
- `gwsc gmail users labels list --params '{"userId":"me"}'` — list labels
- `gwsc gmail users threads list --params '{"userId":"me","labelIds":["INBOX"],"maxResults":10}'` — list threads
- `gwsc gmail users messages get --params '{"userId":"me","id":"MSG_ID"}'` — get message

### Calendar

- `gwsc calendar events list --params '{"calendarId":"primary","timeMin":"2026-03-05T00:00:00Z","timeMax":"2026-03-12T00:00:00Z","singleEvents":true,"orderBy":"startTime"}'` — upcoming events
- `gwsc calendar events insert --params '{"calendarId":"primary"}' --json '{"summary":"Meeting","start":{"dateTime":"...","timeZone":"America/Los_Angeles"},"end":{"dateTime":"...","timeZone":"America/Los_Angeles"}}'` — create event
- `gwsc calendar freebusy query --json '{"timeMin":"...","timeMax":"...","items":[{"id":"user@example.com"}]}'` — check availability

### Drive

- `gwsc drive files list --params '{"pageSize":20}'` — list files
- `gwsc drive files list --params '{"q":"name contains '\''report'\''","pageSize":20}'` — search files
- `gwsc drive files create --upload ./file.pdf --json '{"name":"file.pdf"}'` — upload
- `gwsc drive files get --params '{"fileId":"FILE_ID","alt":"media"}' --output ./filename` — download

### Contacts

- `gwsc people people connections list --params '{"resourceName":"people/me","personFields":"names,emailAddresses,phoneNumbers"}'` — list contacts
- `gwsc people people searchContacts --params '{"query":"John","readMask":"names,emailAddresses,phoneNumbers"}'` — search

### Sheets

- `gwsc sheets spreadsheets values get --params '{"spreadsheetId":"ID","range":"Sheet1!A1:Z100"}'` — read cells
- `gwsc sheets spreadsheets values update --params '{"spreadsheetId":"ID","range":"Sheet1!A1:B2","valueInputOption":"USER_ENTERED"}' --json '{"values":[[1,2],[3,4]]}'` — write cells

### Docs

- `gwsc docs documents get --params '{"documentId":"ID"}'` — read document

### Tasks

- `gwsc tasks tasklists list` — list task lists
- `gwsc tasks tasks list --params '{"tasklist":"TASKLIST_ID"}'` — list tasks
- `gwsc tasks tasks insert --params '{"tasklist":"TASKLIST_ID"}' --json '{"title":"Buy groceries"}'` — create task

## Streaming

- `gwsc gmail +watch --project PROJECT_ID --label-ids INBOX --format full` — watch inbox (NDJSON stream, Ctrl+C to stop)
- `gwsc events +subscribe --target 'TARGET' --event-types 'EVENT_TYPE' --project PROJECT_ID` — subscribe to Workspace events

Watch/subscribe commands require a GCP project with Pub/Sub enabled. The `+watch` and `+subscribe` helpers auto-create Pub/Sub resources.

## Reference

- Flags: `--page-all` auto-paginate | `--page-limit N` cap pages | `--dry-run` preview request
- Credentials: stored at `~/.config/gwsc/credentials.json`, auto-refresh every 7 days. Force refresh: `gwsc --refresh-credentials`

## Troubleshooting

### 404 / 403 errors

Usually means the user didn't grant all permissions during OAuth. Fix: disconnect and reconnect at https://simpleclaw-marketplace.web.app, checking ALL permission boxes. Re-run setup.sh to confirm with scope warnings.

### Token errors (invalid_grant, invalid_client)

Run `gwsc --refresh-credentials`. If that fails, re-run `bash ~/.openclaw/skills/google-workspace/setup.sh` for a new OAuth flow.

### gws not found

Run: `npm install --prefix ~/.local @googleworkspace/cli`

### gwsc not found

Re-run: `bash ~/.openclaw/skills/google-workspace/setup.sh`

### Discovery Service errors on first use

Retry — API definitions are cached for 24 hours after first fetch.
