import type { AgentSession, LaunchableRepo, RepoGitStatus } from "../types.ts";
import { escapeHtml, escapeJs, statusDot, relativeTime, formatTokens } from "./components.ts";

function renderGitBadges(status: RepoGitStatus | undefined): string {
  if (!status) return "";
  const parts: string[] = [];
  if (status.uncommitted > 0)
    parts.push(`<span class="git-badge git-badge--uncommitted" title="${status.uncommitted} uncommitted change${status.uncommitted !== 1 ? "s" : ""}">~${status.uncommitted}</span>`);
  if (status.unpulled > 0)
    parts.push(`<span class="git-badge git-badge--unpulled" title="${status.unpulled} unpulled commit${status.unpulled !== 1 ? "s" : ""}">&#8595;${status.unpulled}</span>`);
  if (status.unpushed > 0)
    parts.push(`<span class="git-badge git-badge--unpushed" title="${status.unpushed} unpushed commit${status.unpushed !== 1 ? "s" : ""}">&#8593;${status.unpushed}</span>`);
  return parts.join("");
}

export function renderSidebar(
  sessions: AgentSession[],
  repos: LaunchableRepo[],
  activeSessionId?: string,
  pendingCounts?: Map<string, RepoGitStatus>
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
    const groupStatus = pendingCounts?.get(cwd);
    html += `<div class="repo-group" data-repo="${escapeHtml(repoName)}">
      <div class="repo-group-header">
        <span class="star-btn" onclick="event.stopPropagation(); toggleStar('${escapeJs(repoName)}')">&#9734;</span>
        <span>${escapeHtml(repoName)}</span>
        ${renderGitBadges(groupStatus)}
        <span class="launch-item-action" onclick="event.stopPropagation(); createSession('${escapeJs(cwd)}')" style="cursor:pointer">+</span>
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
          <span class="session-card-tokens">${formatTokens(totalTokens)}</span>
          <span class="session-card-time"
                data-last-activity="${((['streaming', 'starting'].includes(session.status)) && session.turnStartedAt ? session.turnStartedAt : session.lastActivity).toISOString()}"
                data-status="${session.status}">${relativeTime(session.lastActivity)}</span>
          <button class="dismiss-btn" onclick="event.stopPropagation(); dismissSession('${session.id}')" title="Dismiss session">&times;</button>
        </div>
        <div class="session-card-preview">${escapeHtml(preview)}</div>
      </div>`;
    }

    html += `</div>`;
  }

  // Launch section — only repos without active sessions
  const reposWithSessions = new Set(groups.keys());
  const launchRepos = repos.filter(repo => !reposWithSessions.has(repo.name));

  if (launchRepos.length > 0) {
    html += `<div class="launch-section">
      <div class="launch-section-header">
        <span>Launch</span>
        <button class="refresh-btn" hx-post="/api/repos/refresh" hx-swap="none" title="Refresh repo status">
          &#x21bb;
        </button>
      </div>`;

    for (const repo of launchRepos) {
      html += `<button class="launch-item" data-repo="${escapeHtml(repo.name)}" onclick="createSession('${escapeJs(repo.path)}')">
        <span class="star-btn" onclick="event.stopPropagation(); toggleStar('${escapeJs(repo.name)}')">&#9734;</span>
        <span>${escapeHtml(repo.name)}</span>
        ${renderGitBadges(repo.gitStatus)}
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
