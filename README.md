<div align="center">
  <img src="logo.png" alt="claudesk" width="512"/>

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1.svg?logo=bun)](https://bun.sh)
  [![HTMX](https://img.shields.io/badge/HTMX-SSE-3366cc.svg)](https://htmx.org)
  [![Claude SDK](https://img.shields.io/badge/Claude-Agents_SDK-d97757.svg)](https://docs.anthropic.com)

  🖥️ **Interactive dashboard for launching and managing Claude Code agents** ⚡

  [GitHub](https://github.com/tsilva/claudesk)
</div>

---

## 🔍 Overview

**The pain:** Running Claude Code agents across different repositories means juggling terminals, missing permission prompts, and having no central view of what your agents are doing.

**The solution:** claudesk uses the Claude Agents SDK to launch and manage coding agents directly from a web dashboard — start agents, send follow-up prompts, approve permissions, and monitor progress in real time.

**The result:** One browser tab to launch, interact with, and control all your Claude Code agents — with live streaming, permission handling, and desktop notifications.

### ✨ Features

- 🚀 **Launch agents** — start Claude Code agents on any git repo from the dashboard
- 💬 **Interactive conversations** — send follow-up prompts and get streaming responses
- 🔐 **Permission handling** — approve or deny tool permissions through the UI
- 📡 **Real-time streaming** — SDK message stream via SSE with HTMX partial updates
- 🔔 **Desktop notifications** — instant alerts when an agent needs input
- 📊 **Cost & token tracking** — live token counts, turn stats, and cost per session
- ⏹️ **Agent control** — stop running agents, dismiss completed sessions
- 🎨 **Dark theme** — purpose-built terminal-aesthetic UI with session grouping by repo

### 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Server | [Hono](https://hono.dev) |
| Agent SDK | [@anthropic-ai/claude-agent-sdk](https://docs.anthropic.com) |
| Frontend | [HTMX](https://htmx.org) + SSE |
| Styling | Vanilla CSS (dark theme) |
| Build step | None |

---

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- An Anthropic API key (set `ANTHROPIC_API_KEY` environment variable)

### Install & Run

```bash
git clone https://github.com/tsilva/claudesk.git
cd claudesk
bun install
bun run dev
```

Open **http://localhost:3456** — select a repo from the sidebar, enter a prompt, and launch an agent.

---

## 🏗️ Architecture

### Data Flow

```
User clicks "Launch" → POST /api/agents/launch { cwd, prompt }
  → AgentManager.launch() → SDK query({ prompt, options: { cwd, canUseTool } })
    → for await (msg of generator)
      → transform SDKMessage → AgentMessage → renderMessage() → SSE broadcast
        → Browser: HTMX swaps (stream-append, sidebar, session-stats)

User sends follow-up → POST /api/agents/:id/message { text }
  → query({ prompt: text, options: { resume: sessionId } })

Agent needs permission → canUseTool callback
  → Promise blocks SDK → SSE "permission-request" → UI renders approval
  → User clicks Allow/Deny → resolve() → SDK continues
```

### Core Modules

| Module | Purpose |
|--------|---------|
| `src/types.ts` | Shared type definitions (`AgentSession`, `AgentMessage`, `ContentBlock`, etc.) |
| `src/agents.ts` | `AgentManager` — launches SDK agents, consumes streams, handles permissions |
| `src/server.ts` | Hono HTTP server, SSE client management, REST API endpoints |
| `src/templates/` | Server-rendered HTML string templates (layout, sidebar, session detail, components) |
| `static/app.js` | Session switching, SSE reconnection, agent interaction, notifications |

---

## 📡 API Reference

### Pages

| Route | Description |
|-------|-------------|
| `GET /` | Full dashboard page |
| `GET /sessions/:id/detail` | Session detail fragment (HTMX partial) |

### Agent API

| Route | Body | Description |
|-------|------|-------------|
| `POST /api/agents/launch` | `{ cwd, prompt, model? }` | Launch a new agent |
| `POST /api/agents/:id/message` | `{ text }` | Send follow-up message |
| `POST /api/agents/:id/permission` | `{ allow, message? }` | Respond to permission request |
| `POST /api/agents/:id/answer` | `{ answers }` | Answer agent question |
| `POST /api/agents/:id/stop` | — | Stop a running agent |
| `DELETE /sessions/:id` | — | Dismiss a session |

### SSE Event Types

| Event | Payload | Purpose |
|-------|---------|---------|
| `stream-append` | Message HTML | New conversation message |
| `permission-request` | Permission UI HTML | Tool permission approval prompt |
| `session-stats` | Stats HTML | Token/turn/cost update |
| `sidebar` | Sidebar HTML | Full sidebar re-render |
| `notify` | JSON | Browser notification trigger |
| `ping` | — | Keep-alive |

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
