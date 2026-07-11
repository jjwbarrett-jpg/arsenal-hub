# Arsenal Hub — Agent Onboarding

## What this is

Arsenal Hub is an **agent extension** — not a browser, not a container. It's a shared visual surface that any agent framework talks to via REST APIs. The Hub runs as a local web app. Agents live wherever the user wants (Cursor, Antigravity, Grok, Jules, Hermes, Gemini, any terminal-based CLI agent).

**The Hub is the shared dashboard. You are one of the agents that feeds it.**

## Architecture

```
Any agent ──REST──▶ kanban_server.py :9121  ← the real API
                    server.py :5000          ← Flask shell + proxy (optional)
                    chainlit_app.py :8000     ← Hub Chat (Hermes identity)

Browser ──http──▶  http://<WSL2_IP>:9121     ← user's dashboard (kanban_server serves static files)
```

Three servers, one origin. `kanban_server.py` is the workhorse — it serves the HTML/CSS/JS **and** all REST APIs. `server.py` is a Flask wrapper that proxies some endpoints but `kanban_server.py` is the source of truth.

**Startup command:** `bash ~/.hermes/scripts/arsenal-hub-start.sh`

## How to connect

The Hub runs in WSL2. The IP changes on every reboot. Discover it:

```bash
# From WSL2
ip addr show eth0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1
```

Typical IPs: `172.21.40.227`, `172.20.x.x`. All endpoints below use `<HUB>` as placeholder — replace with the actual IP.

**Health check:**
```bash
curl http://<HUB>:9121/api/memory/context
# returns {"status":"ok","context":"=== QUICK RECALL ===..."}
```

## API Reference

All endpoints on port **9121** unless noted. All responses are JSON.

### Clipboard (Scratch)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/clipboard` | Full clipboard state (panels, sessionId, timestamps) |
| `POST` | `/api/clipboard` | Full sync (browser overwrites state — trusted user channel) |
| `POST` | `/api/clipboard/agent` | Agent actions: `create-panel`, `add-grab`, `set-body`, `set-title` |
| `GET` | `/api/clipboard/sessions` | List saved sessions (`?project=` filter). Returns `{sessions, projects}` |
| `GET` | `/api/clipboard/sessions/{id}` | Load a saved session and make it active (`?project=` optional) |
| `POST` | `/api/clipboard/save` | Name+persist current session: `{name, project}` → `{id}` |
| `POST` | `/api/clipboard/new` | Archive current (auto-saved), start empty session: `{project?}` |
| `POST` | `/api/scribe/ingest` | **Universal ingest** — the primary agent integration surface (see below) |

Clipboard state auto-saves on every mutation to `.files/clipboard-session.json` and mirrors under `.files/sessions/<project>/<sessionId>.json`.

### Kanban

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/tasks` | All active tasks. Query: `?board=<name>` (default: "default") |
| `GET` | `/api/tasks/{id}` | Single task |
| `POST` | `/api/tasks` | Create task. Body: `{title, status, assignee, body, priority, ...}` |
| `PATCH` | `/api/tasks/{id}` | Update task. Body: `{status, title, body, assignee, priority}` |
| `DELETE` | `/api/tasks/{id}` | Delete task + related data (runs, links, comments) |
| `GET` | `/api/kanban/state` | Summarized kanban state (for tab agents). Query: `?board=<name>` |
| `GET` | `/api/boards` | List board names |

**Columns:** `triage`, `todo`, `ready`, `in_progress`, `blocked`, `done`  
**Assignee:** Any string — use your agent name (e.g., `cursor-ws-b`, `antigravity-ws-a`, `grok-build`, `jules`)

### Memory

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/memory/context` | Quick Recall — fact summary across all projects |

### Skills

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/skills` | All installed skills grouped by category |

### Hub State (Tab Agents)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/state` | Current HubState (kanban, clipboard, tools, blueprints, activeTab) |
| `POST` | `/api/state` | Browser pushes state every 5s — **agents should not write this** |

### Chat (Hermes Gateway Proxy)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/chat` | Proxy to Hermes gateway. Body: `{messages: [{role, content}, ...], max_tokens}` |

### Flask Server (port 5000)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/tools` | Tool catalog |
| `GET` | `/api/config` | Current config |
| `GET` | `/api/blueprints` | List blueprints |
| `POST` | `/api/blueprints` | Create blueprint |
| `DELETE` | `/api/blueprints/{name}` | Delete blueprint |

## Universal Scribe Ingest — Your Primary Integration

Every agent should push notes to the Hub Clipboard whenever something notable happens. Do NOT wait until session end — scribe in real time.

```
POST http://<HUB>:9121/api/scribe/ingest
Content-Type: application/json

{
  "agent": "<your-agent-name>",
  "session": "<optional-session-id>",
  "items": [
    {"type": "decision", "text": "Switched auth from JWT to API keys"},
    {"type": "discovery", "text": "The WSL2 IP changes on every reboot — use `ip addr show`"},
    {"type": "action", "text": "Refactor kanban_server.py error handling by Friday"},
    {"type": "note", "text": "User prefers dark charcoal (#121418) background everywhere"}
  ]
}
```

**Response:** `{"status": "ok", "ingested": 4}`

Each item becomes a Proposed panel in the user's Clipboard. The user reviews and Grabs what matters. Err on the side of capturing — Proposed cards are cheap, lost knowledge is expensive.

**Item types:**
- `decision` — A choice was made that affects future work
- `discovery` — Something was learned or uncovered
- `action` — A task was created that needs follow-up
- `note` — General durable information worth remembering

**When to scribe:**
- A decision was made (architecture, tool choice, approach)
- Something was discovered or learned (bug root cause, tool quirk, environment fact)
- An action item was created (even if also added to Kanban)
- The user stated a preference, convention, or personal rule
- An error was encountered and resolved (root cause + solution)
- A file was created, renamed, or deleted that affects project structure

**Agent naming convention:** Use a consistent identifier. Examples:
- `cursor-ws-b` — Cursor working copy B
- `antigravity-ws-a` — Antigravity working copy A
- `grok-build` — Grok Build/Composer
- `jules` — Jules (Google async agent)
- `hermes-tui` — Hermes TUI session
- `hermes-discord` — Hermes Discord session

## File System Conventions

```
C:\Core-User\
├── projects\                       ← CANONICAL (source of truth)
│   ├── aidailine\                  ← Hermes edits this directly
│   ├── arsenal-hub\                ← Hermes edits this directly
│   └── games\godot\<game>\
├── agent-workspaces\               ← Agent working copies
│   ├── cursor\<project>-ws-<N>\    ← Cursor edits here (not canonical)
│   ├── antigravity\<project>-ws-<N>\
│   ├── jules\<project>-ws-<N>\
│   └── hermes\                     ← reserved for parallel Hermes sessions
├── mailbox\                        ← Manager↔Worker handoffs
│   ├── specs\                      ← Hermes writes specs here
│   ├── results\                    ← Worker output
│   └── harvests\                   ← Auto Scribe drops harvest files here
├── hermes-vault\                   ← Obsidian vault (Hermes writes Memory/ here)
└── 00-project-backup\              ← READ-ONLY backups (never edit)
```

**Critical rules:**
- **Canonical** (`projects/<name>/`) is the source of truth. Only Hermes edits it.
- **Agent workspaces** are where you work. You own your workspace copy.
- **Backups** (`00-project-backup/`) are read-only. Never write there.
- **Mailbox** is the handoff protocol — specs go in, results come out.

## Architecture Rules (Hard)

1. **Hermes is the merger.** When multiple agents produce changes, Hermes merges into canonical. Workers edit their own copies.
2. **Never touch colors or visual design.** The user handles ALL CSS, layout, and visual polish. Your job is logic, data, APIs.
3. **Verify, don't trust.** If another agent claims something is done, check the actual files before merging. Workers lie about completion.
4. **The Hub is the shared surface.** Don't build agent-specific features into it. The Hub works for any agent — keep it generic.
5. **Edits to `kanban_server.py`:** Run `python3 -m py_compile kanban_server.py` before considering it done.
6. **New endpoints:** Respond with structured JSON. Include a `source` field for attribution where relevant.
7. **Pre-built over custom.** Before writing new code, check if a library, existing tool, or GitHub repo already does it.
8. **The `AGENTS.md` you're reading** lives in the repo root. It's the single onboarding doc — don't create competing docs.

## Verifying Your Integration

After integrating with the Hub, run these checks:

```bash
# 1. Can you reach the Hub?
curl http://<HUB>:9121/api/memory/context
# Expect: {"status":"ok","context":"=== QUICK RECALL ===..."}

# 2. Can you scribe?
curl -X POST http://<HUB>:9121/api/scribe/ingest \
  -H "Content-Type: application/json" \
  -d '{"agent":"test","items":[{"type":"note","text":"Integration test passed"}]}'
# Expect: {"status":"ok","ingested":1}

# 3. Can you read the Clipboard?
curl http://<HUB>:9121/api/clipboard
# Expect: sessionId + panels array (should include your test note)

# 4. Can you read/create Kanban tasks?
curl http://<HUB>:9121/api/tasks
curl -X POST http://<HUB>:9121/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test from <your-agent>","status":"triage","assignee":"<your-agent>"}'
```

If all four pass, you're integrated.

## Quick Reference Card

```
Hub URL:       http://<WSL2_IP>:9121
Ingest:        POST /api/scribe/ingest  {agent, items: [{type, text}]}
Clipboard:     GET  /api/clipboard
Kanban:        GET/POST /api/tasks
Memory:        GET  /api/memory/context
Health:        GET  /api/memory/context  (returns 200 = alive)
Startup:       bash ~/.hermes/scripts/arsenal-hub-start.sh
WSL2 IP:       ip addr show eth0 | grep 'inet '
GitHub:        https://github.com/jjwbarrett-jpg/arsenal-hub
```

---

*This doc lives in the repo root. Every agent reads it on startup. If something is wrong, missing, or outdated, tell Hermes — don't create a competing doc.*
