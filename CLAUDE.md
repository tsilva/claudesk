# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

claudesk is a real-time monitoring dashboard for Claude Code agent sessions. It discovers active Claude Code instances via file system watchers (lock files and session registry), tails their JSONL conversation files, and streams updates to a web UI over Server-Sent Events (SSE).

## Commands

- `bun run dev` — Start dev server with file watching (port 3456)
- `bun run start` — Start production server

No test or lint commands are configured.

## Architecture

**Stack**: Bun + Hono server, HTMX + SSE frontend, no build step.

### Core Modules

- **`src/server.ts`** — Hono HTTP server, SSE client management, route handlers. Broadcasts events to connected browsers filtered by active session ID.
- **`src/sessions.ts`** (~865 lines) — Contains two key classes:
  - `SessionManager` — Discovers sessions via a two-phase approach: (1) registry files from claude-wrapper (`~/.claude/ide/sessions/*.json`), (2) fallback to lock files (`~/.claude/ide/*.lock`). Validates PIDs, matches sessions to JSONL files, runs discovery every 3 seconds.
  - `JsonlTailer` — Tails JSONL conversation files using `fs.watch` with 500ms polling fallback. Parses Claude Code message format (user, assistant, tool_use, tool_result, progress, system). Debounces progress messages at 200ms.
- **`src/templates/`** — Server-rendered HTML string templates (no template engine):
  - `layout.ts` — Full page shell
  - `sidebar.ts` — Session list grouped by repo, launch panel for available repos
  - `session-detail.ts` — Conversation view with message stream
  - `components.ts` — Shared helpers: `renderMessage()`, `escapeHtml()`, `statusDot()`, `relativeTime()`, `formatTokens()`

### Data Flow

```
JSONL file change → JsonlTailer (fs.watch + poll)
  → parseRawMessage() → SessionManager.handleMessage()
    → Update session state (status, tokens, branch)
    → Server.onMessage() → renderMessage() → SSE broadcast
      → Browser: HTMX swaps (stream-append, sidebar, session-stats)
```

### Client Side

- **`static/app.js`** — Vanilla JS for session switching, SSE reconnection, desktop notifications, connection status indicator
- **`static/style.css`** — Dark theme CSS
- **`static/htmx.min.js` + `htmx-sse.js`** — HTMX with SSE extension for real-time partial page updates

### Session Discovery

Sessions are identified through two mechanisms with priorities:
1. **Registry-backed** (authoritative): claude-wrapper writes `~/.claude/ide/sessions/{pid}.json` with PID, cwd, startedAt. JSONL matched by birthtime within 30s window.
2. **Lock-file fallback**: Reads `~/.claude/ide/*.lock` for workspaces without registry entries. Finds JSONLs modified in last 5 minutes.

### External Integration Points

- Reads from: `~/.claude/ide/` (locks, registry), `~/.claude/projects/` (JSONL files)
- `scripts/claude-wrapper` — Bash wrapper for Claude CLI that creates session registry entries
- `POST /api/hook` — Webhook endpoint for Claude Code permission/stop events
- Window focus via `~/.claude/focus-window.sh` (AeroSpace)
- Repo launching via `cursor` CLI

### SSE Event Types

- `stream-append` — New message HTML (prepended to conversation)
- `stream-progress` — Progress indicator update
- `session-stats` — Token/turn count update
- `sidebar` — Full sidebar re-render
- `notify` — Browser notification trigger

## Conventions

- HTML templates use string interpolation with `escapeHtml()` at every insertion point
- Session status values: `streaming`, `idle`, `needs_permission`, `died`
- All content blocks rendered through `renderContentBlock()` dispatcher (text, thinking, tool_use, tool_result)
- README.md must be kept up to date with any significant project changes
