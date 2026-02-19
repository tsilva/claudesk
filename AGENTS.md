# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

claudesk is an interactive dashboard for launching and managing Claude Code agent sessions. It uses the Claude Agents SDK (`@anthropic-ai/claude-agent-sdk`) to run coding agents programmatically on git repositories, streaming messages to a web UI over Server-Sent Events (SSE). Users can launch agents, send follow-up prompts, approve/deny tool permissions, and stop agents — all through the browser.

## Commands

- `bun run dev` — Start dev server with file watching (port 3456)
- `bun run start` — Start production server

No test or lint commands are configured.

## Architecture

**Stack**: Bun + Hono server, HTMX + SSE frontend, Claude Agents SDK, no build step.

### Core Modules

- **`src/types.ts`** — Shared type definitions: `AgentSession`, `AgentMessage`, `AgentStatus`, `ContentBlock`, `PendingPermission`, `PendingQuestion`, `LaunchableRepo`
- **`src/agents.ts`** — `AgentManager` class: launches SDK agents via `query()`, consumes async generator streams, handles permission callbacks, manages session lifecycle. Public API: `launch()`, `sendMessage()`, `respondToPermission()`, `answerQuestion()`, `stopAgent()`, `dismissSession()`
- **`src/server.ts`** — Hono HTTP server, SSE client management, REST API endpoints. Broadcasts events to connected browsers filtered by active session ID.
- **`src/templates/`** — Server-rendered HTML string templates (no template engine):
  - `layout.ts` — Full page shell
  - `sidebar.ts` — Session list grouped by repo, launch panel for available repos
  - `session-detail.ts` — Conversation view with message stream, input box, permission prompt area
  - `components.ts` — Shared helpers: `renderMessage()`, `renderPermissionPrompt()`, `escapeHtml()`, `statusDot()`, `relativeTime()`, `formatTokens()`
- **`src/markdown.ts`** — Markdown rendering with highlight.js syntax highlighting

### Data Flow

```
User clicks "Launch" → POST /api/agents/launch { cwd, prompt }
  → AgentManager.launch() → SDK query({ prompt, options: { cwd, canUseTool } })
    → for await (msg of generator)
      → transform SDKMessage → AgentMessage → renderMessage() → SSE "stream-append"
    → on generator done → status = "idle"

User sends follow-up → POST /api/agents/:id/message { text }
  → AgentManager.sendMessage() → query({ prompt: text, options: { resume: sessionId } })

Agent needs permission → canUseTool callback fires
  → store Promise resolve on session → status = "needs_input"
  → SSE "permission-request" → renders approval UI in browser
  → User clicks Allow/Deny → POST /api/agents/:id/permission
    → calls stored resolve() → SDK unblocks
```

### API Endpoints

- `GET /` — Full page render
- `GET /events?session=:id` — SSE stream
- `GET /sessions/:id/detail` — Session detail fragment (HTMX)
- `DELETE /sessions/:id` — Dismiss session
- `POST /api/agents/launch` — Launch new agent (`{ cwd, prompt, model? }`)
- `POST /api/agents/:id/message` — Send follow-up (`{ text }`)
- `POST /api/agents/:id/permission` — Respond to permission (`{ allow, message? }`)
- `POST /api/agents/:id/answer` — Answer a question (`{ answers }`)
- `POST /api/agents/:id/stop` — Stop agent

### Client Side

- **`static/app.js`** — Vanilla JS for session switching, SSE reconnection, desktop notifications, agent interaction (launch, message, permission, stop)
- **`static/style.css`** — Dark theme CSS
- **`static/htmx.min.js` + `htmx-sse.js`** — HTMX with SSE extension for real-time partial page updates

### SSE Event Types

- `stream-append` — New message HTML (prepended to conversation)
- `permission-request` — Permission approval UI (or empty to clear)
- `session-stats` — Token/turn/cost update
- `sidebar` — Full sidebar re-render
- `notify` — Browser notification trigger
- `ping` — Keep-alive

## Conventions

- HTML templates use string interpolation with `escapeHtml()` at every insertion point
- Agent status values: `starting`, `streaming`, `idle`, `needs_input`, `error`, `stopped`
- All content blocks rendered through `renderContentBlock()` dispatcher (text, thinking, tool_use, tool_result)
- SDK messages are transformed to `AgentMessage` before rendering
- Permission flow uses Promise-based blocking: `canUseTool` returns a Promise that resolves when user responds via UI
- README.md must be kept up to date with any significant project changes
