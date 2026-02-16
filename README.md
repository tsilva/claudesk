<div align="center">
  <img src="logo.png" alt="claudesk" width="512"/>

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1.svg?logo=bun)](https://bun.sh)
  [![HTMX](https://img.shields.io/badge/HTMX-SSE-3366cc.svg)](https://htmx.org)

  🖥️ **Real-time monitoring dashboard for Claude Code agent sessions** ⚡

  [GitHub](https://github.com/tsilva/claudesk)
</div>

---

## 🔍 Overview

**The pain:** Running multiple Claude Code sessions across different projects means constantly switching terminals to check status, missing permission prompts, and losing track of token usage.

**The solution:** claudesk auto-discovers every active Claude Code instance on your machine, tails their conversation logs in real time, and streams updates to a single browser dashboard over SSE — no polling, no manual setup.

**The result:** One glance tells you which sessions are streaming, which need permission, and what each agent is working on — with desktop notifications so you never miss a prompt.

### ✨ Features

- 🔄 **Auto-discovery** — finds sessions via registry files and lock file fallback, no config needed
- 📡 **Real-time streaming** — JSONL file tailing with `fs.watch` + polling fallback, debounced at 200ms
- 🔔 **Desktop notifications** — instant alerts when a session needs permission or stops
- 🚀 **Session launching** — spin up new Claude Code sessions from the dashboard
- 📊 **Token tracking** — live token counts and turn stats per session
- 🪟 **Window focus** — jump to any session's editor with one click
- 🎨 **Dark theme** — purpose-built UI with session grouping by repo

### 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Server | [Hono](https://hono.dev) |
| Frontend | [HTMX](https://htmx.org) + SSE |
| Styling | Vanilla CSS (dark theme) |
| Build step | None |

---

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)

### Install & Run

```bash
git clone https://github.com/tsilva/claudesk.git
cd claudesk
bun install
bun run dev
```

Open **http://localhost:3456** — any active Claude Code sessions are discovered automatically.

### 🔧 Enhanced Session Discovery (Optional)

For more reliable session tracking, install the `claude-wrapper` script that registers sessions on startup:

```bash
mkdir -p ~/.claude/bin
ln -sf "$(pwd)/scripts/claude-wrapper" ~/.claude/bin/claude
```

Add to your `~/.zshrc` (before any other PATH additions):

```bash
export PATH="$HOME/.claude/bin:$PATH"
```

This creates registry entries at `~/.claude/ide/sessions/{pid}.json` for authoritative session matching.

---

## 🏗️ Architecture

### Data Flow

```
JSONL file change → JsonlTailer (fs.watch + poll)
  → parseRawMessage() → SessionManager.handleMessage()
    → Update session state (status, tokens, branch)
    → Server.onMessage() → renderMessage() → SSE broadcast
      → Browser: HTMX swaps (stream-append, sidebar, session-stats)
```

### Session Discovery

Sessions are identified through two mechanisms:

1. **Registry-backed** (authoritative) — `claude-wrapper` writes `~/.claude/ide/sessions/{pid}.json` with PID, cwd, and start time. JSONL matched by birthtime within a 30s window.
2. **Lock-file fallback** — reads `~/.claude/ide/*.lock` for workspaces without registry entries. Finds JSONLs modified in the last 5 minutes.

Discovery runs every 3 seconds with PID validation to detect dead sessions.

### Core Modules

| Module | Purpose |
|--------|---------|
| `src/server.ts` | Hono HTTP server, SSE client management, route handlers |
| `src/sessions.ts` | `SessionManager` (discovery, state) + `JsonlTailer` (file watching) |
| `src/templates/` | Server-rendered HTML string templates (layout, sidebar, session detail, components) |
| `static/app.js` | Session switching, SSE reconnection, notifications |

---

## 📡 API Reference

### Pages

| Route | Description |
|-------|-------------|
| `GET /` | Full dashboard page |
| `GET /sessions/:id/detail` | Session detail fragment (HTMX partial) |

### API Endpoints

| Route | Description |
|-------|-------------|
| `GET /events?session=<id>` | SSE stream filtered by session |
| `POST /api/hook` | Webhook for Claude Code permission/stop events |
| `POST /sessions/:id/focus` | Focus the session's editor window |
| `POST /launch` | Launch a new Claude Code session in Cursor |

### SSE Event Types

| Event | Payload | Purpose |
|-------|---------|---------|
| `stream-append` | Message HTML | New conversation message |
| `stream-progress` | Progress HTML | Streaming progress indicator |
| `session-stats` | Stats HTML | Token/turn count update |
| `sidebar` | Sidebar HTML | Full sidebar re-render |
| `notify` | JSON | Browser notification trigger |

### Webhook Integration

Configure a Claude Code hook to send permission and stop events:

```json
{
  "hooks": {
    "Permission": [{ "command": "curl -s -X POST http://localhost:3456/api/hook -H 'Content-Type: application/json' -d '{\"event\":\"permission\",\"project\":\"$PROJECT\"}'" }],
    "Stop": [{ "command": "curl -s -X POST http://localhost:3456/api/hook -H 'Content-Type: application/json' -d '{\"event\":\"stop\",\"project\":\"$PROJECT\"}'" }]
  }
}
```

---

## 🤝 Contributing

Contributions are welcome! This project uses a simple setup:

```bash
bun install
bun run dev    # Dev server with file watching on port 3456
```

There's no build step, test suite, or linter configured — the server runs TypeScript directly via Bun.

---

## 📄 License

[MIT](LICENSE)
