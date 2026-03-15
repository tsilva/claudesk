import type { AgentSession, LaunchableRepo, AgentMessage, RepoGitStatus } from "../types.ts";
import { renderSidebar } from "./sidebar.ts";
import { renderSessionDetail, renderEmptyDetail } from "./session-detail.ts";

export function renderLayout(
  sessions: AgentSession[],
  repos: LaunchableRepo[],
  activeSession: AgentSession | null,
  messages: AgentMessage[] = [],
  pendingCounts?: Map<string, RepoGitStatus>
): string {
  const sidebarHtml = renderSidebar(sessions, repos, activeSession?.id, pendingCounts);
  const detailHtml = activeSession
    ? renderSessionDetail(activeSession, messages)
    : renderEmptyDetail(repos.length);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>maestro</title>
  <link rel="icon" type="image/png" href="/static/favicon.png">
  <link rel="stylesheet" href="/static/style.css">
  <link rel="stylesheet" href="/static/hljs-theme.css">
  <script src="/static/htmx.min.js"></script>
  <script src="/static/htmx-sse.js"></script>
</head>
<body>
  <div class="app" hx-ext="sse" sse-connect="/events${activeSession ? `?session=${activeSession.id}` : ""}">
    <div hx-trigger="sse:notify" hx-swap="none" style="display:none"></div>
    <div hx-trigger="sse:turn-complete" hx-swap="none" style="display:none"></div>
    <div hx-trigger="sse:hook-status" hx-swap="none" style="display:none"></div>
    <header class="header">
      <div class="header-left">
        <span class="logo">maestro</span>
      </div>
      <div class="header-right">
        <span class="connection-dot" id="connection-dot" title="SSE Connected"></span>
        <button class="btn btn--ghost" id="notif-toggle" onclick="toggleNotifications()">
          Notifications: <span id="notif-status">Off</span>
        </button>
      </div>
    </header>
    <div class="main">
      <aside class="sidebar">
        <div class="sidebar-filter">
          <input type="text" id="sidebar-filter-input" class="sidebar-filter-input"
            placeholder="Filter..." autocomplete="off" spellcheck="false">
          <button class="needs-attention-btn hidden" id="needs-attention-btn"
            onclick="cycleNeedsInput()" title="Next session needing input" disabled>
            <span class="needs-attention-icon">!</span>
            <span class="needs-attention-badge" id="needs-attention-badge">0</span>
          </button>
        </div>
        <div class="sidebar-scroll" id="sidebar" sse-swap="sidebar" hx-swap="innerHTML">
          ${sidebarHtml}
        </div>
      </aside>
      <div class="content" id="session-detail">
        ${detailHtml}
      </div>
    </div>
  </div>
  <div id="notification-banner" class="notification-banner hidden"></div>
  <div id="model-modal" class="model-modal hidden" aria-hidden="true">
    <div class="model-modal-backdrop" data-action="dismiss-model-modal"></div>
    <div class="model-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="model-modal-title">
      <div class="model-modal-header">
        <div class="model-modal-heading">
          <div class="model-modal-eyebrow">Model Selection</div>
          <h2 id="model-modal-title" class="model-modal-title">Choose a model</h2>
          <p id="model-modal-subtitle" class="model-modal-subtitle">Pick the OpenCode model for this session before sending the first message.</p>
        </div>
        <button type="button" class="model-modal-close" data-action="dismiss-model-modal" aria-label="Close model selector">×</button>
      </div>
      <div class="model-modal-meta">
        <div id="model-modal-session" class="model-modal-session"></div>
        <div id="model-modal-current" class="model-modal-current"></div>
      </div>
      <div class="model-modal-toolbar">
        <input
          id="model-modal-search"
          class="model-modal-search"
          type="search"
          placeholder="Search models, providers, or IDs"
          autocomplete="off"
          spellcheck="false">
      </div>
      <div id="model-modal-content" class="model-modal-content">
        <div class="model-modal-note">Loading models...</div>
      </div>
    </div>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`;
}
