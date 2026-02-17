import type { AgentSession, AgentMessage } from "../types.ts";
import { escapeHtml, statusBadge, renderSessionStats, renderMessage } from "./components.ts";

export function renderSessionDetail(session: AgentSession, messages: AgentMessage[] = []): string {
  const isActive = session.status === "streaming" || session.status === "starting";

  // Render initial messages inline
  const messagesHtml = messages
    .slice()
    .reverse()
    .map((msg) => renderMessage(msg))
    .filter(Boolean)
    .join("\n");

  return `<div class="session-detail" data-session-id="${session.id}">
    <div class="session-header">
      <div>
        <span class="session-header-repo">${escapeHtml(session.repoName)}</span>
        <span class="session-header-slug">${escapeHtml(session.id.slice(0, 8))}</span>
        ${statusBadge(session.status)}
        <span class="elapsed-timer"
              data-last-activity="${session.lastActivity.toISOString()}"
              data-status="${session.status}"></span>
      </div>
      <div class="session-header-spacer"></div>
      <div>
        ${isActive ? `<button class="btn btn--ghost" onclick="stopAgent('${session.id}')" title="Stop agent">Stop</button>` : ""}
      </div>
    </div>
    <div id="permission-prompt-area" sse-swap="permission-request" hx-swap="innerHTML"></div>
    <div class="conversation-stream" id="conversation-stream" sse-swap="stream-append" hx-swap="afterbegin">
      ${messagesHtml}
    </div>
    <div class="message-input-area">
      <form id="message-form" onsubmit="sendMessage(event, '${session.id}')">
        <input type="text" name="text" class="message-input"
          placeholder="Send a message..." autocomplete="off"
          ${session.status === "streaming" || session.status === "starting" ? "disabled" : ""}>
        <button type="submit" class="btn btn--primary message-send-btn"
          ${session.status === "streaming" || session.status === "starting" ? "disabled" : ""}>Send</button>
      </form>
    </div>
    <div class="session-footer" id="session-stats" sse-swap="session-stats" hx-swap="innerHTML">
      ${renderSessionStats(session)}
    </div>
  </div>`;
}

export function renderEmptyDetail(): string {
  return `<div class="empty-state">
    <div class="empty-state-icon">&#9673;</div>
    <div class="empty-state-text">Select a session or launch a new agent</div>
    <div class="empty-state-hint">Choose a repo from the sidebar and enter a prompt to get started</div>
  </div>`;
}
