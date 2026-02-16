import type { Session, ParsedMessage } from "../sessions.ts";
import { escapeHtml, statusBadge, renderSessionStats, renderMessage } from "./components.ts";

export function renderSessionDetail(session: Session, messages: ParsedMessage[] = []): string {
  const slug = session.slug || session.id.slice(0, 8);

  // Render initial messages inline
  const messagesHtml = messages
    .map((msg) => renderMessage(msg))
    .filter(Boolean)
    .join("\n");

  return `<div class="session-detail" data-session-id="${session.id}">
    <div class="session-header">
      <div>
        <span class="session-header-repo">${escapeHtml(session.repoName)}</span>
        <span class="session-header-slug">${escapeHtml(slug)}</span>
        ${statusBadge(session.status)}
      </div>
      <div class="session-header-spacer"></div>
      <div>
        <button class="btn btn--ghost"
          hx-post="/sessions/${session.id}/focus"
          hx-swap="none"
          title="Focus Cursor window">
          Focus Cursor
        </button>
      </div>
    </div>
    <div class="conversation-stream" id="conversation-stream" sse-swap="stream-append" hx-swap="beforeend scroll:bottom">
      ${messagesHtml}
    </div>
    <div class="session-footer" id="session-stats" sse-swap="session-stats" hx-swap="innerHTML">
      ${renderSessionStats(session)}
    </div>
  </div>`;
}

export function renderEmptyDetail(): string {
  return `<div class="empty-state">
    <div class="empty-state-icon">&#9673;</div>
    <div class="empty-state-text">Select a session to view its conversation</div>
    <div class="empty-state-hint">Sessions appear automatically when Claude Code is active in Cursor</div>
  </div>`;
}
