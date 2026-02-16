import type { Session, LaunchableRepo } from "../sessions.ts";
import { escapeHtml, statusDot, relativeTime, formatTokens } from "./components.ts";

export function renderSidebar(
  sessions: Session[],
  repos: LaunchableRepo[],
  activeSessionId?: string
): string {
  // Group sessions by repo
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const existing = groups.get(session.repoName) ?? [];
    existing.push(session);
    groups.set(session.repoName, existing);
  }

  let html = "";

  // Session groups
  for (const [repoName, repoSessions] of groups) {
    html += `<div class="repo-group">
      <div class="repo-group-header">${escapeHtml(repoName)}</div>`;

    for (const session of repoSessions) {
      const isActive = session.id === activeSessionId;
      const slug = session.slug || session.id.slice(0, 8);
      const preview = session.lastMessagePreview || "No messages yet";
      const branch = session.gitBranch ? `${escapeHtml(session.gitBranch)}` : "";

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
          <span class="session-card-time">${relativeTime(session.lastActivity)}</span>
        </div>
        <div class="session-card-preview">${escapeHtml(preview)}</div>
        <div class="session-card-meta">
          ${branch ? `<span class="branch">${branch}</span>` : ""}
          <span class="tokens">${formatTokens(session.totalTokens)}</span>
        </div>
      </div>`;
    }

    html += `</div>`;
  }

  // Launch section
  if (repos.length > 0) {
    html += `<div class="launch-section">
      <div class="launch-section-header">Launch</div>`;

    for (const repo of repos.slice(0, 20)) {
      html += `<button class="launch-item"
        hx-post="/launch"
        hx-vals='${JSON.stringify({ path: repo.path })}'
        hx-swap="none">
        <span>${escapeHtml(repo.name)}</span>
        <span class="launch-item-action">+</span>
      </button>`;
    }

    html += `</div>`;
  }

  // Empty state
  if (sessions.length === 0 && repos.length === 0) {
    html += `<div class="sidebar-empty">No active sessions</div>`;
  }

  return html;
}
