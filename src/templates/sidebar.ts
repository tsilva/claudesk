import type { AgentSession, LaunchableRepo } from "../types.ts";
import { escapeHtml, statusDot, relativeTime, formatTokens } from "./components.ts";

export function renderSidebar(
  sessions: AgentSession[],
  repos: LaunchableRepo[],
  activeSessionId?: string
): string {
  // Group sessions by repo
  const groups = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const existing = groups.get(session.repoName) ?? [];
    existing.push(session);
    groups.set(session.repoName, existing);
  }

  let html = "";

  // Session groups
  for (const [repoName, repoSessions] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cwd = repoSessions[0]?.cwd ?? "";
    html += `<div class="repo-group">
      <div class="launch-item-wrapper">
        <div class="repo-group-header" onclick="toggleLaunchPrompt(this)" style="cursor:pointer">
          <span>${escapeHtml(repoName)}</span>
          <span class="launch-item-action">+</span>
        </div>
        <form class="launch-prompt-form hidden" onsubmit="launchAgent(event, '${escapeHtml(cwd)}')">
          <input type="text" name="prompt" class="launch-prompt-input"
            placeholder="Enter a prompt..."
            onkeydown="if(event.key==='Escape'){this.closest('.launch-prompt-form').classList.add('hidden')}"
            required>
          <button type="submit" class="btn btn--primary launch-prompt-go">Go</button>
        </form>
      </div>`;

    for (const session of repoSessions) {
      const isActive = session.id === activeSessionId;
      const slug = session.id.slice(0, 8);
      const preview = session.lastMessagePreview || "No messages yet";
      const totalTokens = session.inputTokens + session.outputTokens;

      html += `<div class="session-card${isActive ? " active" : ""}"
        hx-get="/sessions/${session.id}/detail"
        hx-target="#session-detail"
        hx-swap="innerHTML"
        onclick="switchSession('${session.id}')"
        role="button"
        tabindex="0">
        <div class="session-card-row">
          ${statusDot(session.status)}
          <span class="session-card-slug">${escapeHtml(slug)}</span>
          <span class="session-card-time"
                data-last-activity="${session.lastActivity.toISOString()}"
                data-status="${session.status}">${relativeTime(session.lastActivity)}</span>
          <button class="dismiss-btn" onclick="event.stopPropagation(); dismissSession('${session.id}')" title="Dismiss session">&times;</button>
        </div>
        <div class="session-card-preview">${escapeHtml(preview)}</div>
        <div class="session-card-meta">
          <span class="tokens">${formatTokens(totalTokens)}</span>
        </div>
      </div>`;
    }

    html += `</div>`;
  }

  // Launch section
  if (repos.length > 0) {
    html += `<div class="launch-section">
      <div class="launch-section-header">Launch</div>`;

    for (const repo of repos) {
      html += `<div class="launch-item-wrapper">
        <button class="launch-item" onclick="toggleLaunchPrompt(this)">
          <span>${escapeHtml(repo.name)}</span>
          <span class="launch-item-action">+</span>
        </button>
        <form class="launch-prompt-form hidden" onsubmit="launchAgent(event, '${escapeHtml(repo.path)}')">
          <input type="text" name="prompt" class="launch-prompt-input"
            placeholder="Enter a prompt..."
            onkeydown="if(event.key==='Escape'){this.closest('.launch-prompt-form').classList.add('hidden')}"
            required>
          <button type="submit" class="btn btn--primary launch-prompt-go">Go</button>
        </form>
      </div>`;
    }

    html += `</div>`;
  }

  // Empty state
  if (sessions.length === 0 && repos.length === 0) {
    html += `<div class="sidebar-empty">No active sessions</div>`;
  }

  return html;
}
