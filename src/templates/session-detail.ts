import type { AgentSession, AgentMessage } from "../types.ts";
import { escapeHtml, renderSessionHeaderStatus, renderSessionStats, renderMessage, renderTurnCompleteFooter, modeLabel, modeTooltip } from "./components.ts";

export function renderSessionDetail(session: AgentSession, messages: AgentMessage[] = []): string {
  // Find non-error result message to fold into last assistant message
  const resultMsg = messages.find((msg) => msg.type === "result" && !msg.isError);
  const footerHtml = resultMsg ? renderTurnCompleteFooter(resultMsg) : "";

  // Render initial messages, injecting footer into the last assistant message
  const reversed = messages.slice().reverse();
  let footerInjected = false;
  const messagesHtml = reversed
    .map((msg) => {
      const html = renderMessage(msg);
      if (!html) return null;
      // Inject footer into the first (newest) assistant message
      if (!footerInjected && footerHtml && msg.type === "assistant" && html) {
        footerInjected = true;
        return html.replace(/<\/div><\/div>$/, footerHtml + "</div></div>");
      }
      return html;
    })
    .filter(Boolean)
    .join("\n");

  return `<div class="session-detail" data-session-id="${session.id}">
    <div class="session-header">
      <span class="session-header-repo">${escapeHtml(session.repoName)}</span>
      <span class="session-header-slug">${escapeHtml(session.id.slice(0, 8))}</span>
      <div id="session-header-status" sse-swap="session-status" hx-swap="innerHTML">
        ${renderSessionHeaderStatus(session)}
      </div>
    </div>
    <div class="conversation-stream" id="conversation-stream" sse-swap="stream-append" hx-swap="afterbegin">
      ${messagesHtml || '<div class="empty-conversation-hint">Type a message to start</div>'}
    </div>
    <div class="message-input-area">
      <form id="message-form" onsubmit="sendMessage(event, '${session.id}')">
        <input type="text" name="text" class="message-input"
          placeholder="Send a message..." autocomplete="off"
          ${session.status === "streaming" || session.status === "starting" ? "disabled" : ""}>
        <button type="button" class="mode-cycle-btn mode--${session.permissionMode === 'default' ? 'plan' : session.permissionMode}"
          onclick="cycleMode('${session.id}')"
          title="${escapeHtml(modeTooltip(session.permissionMode))}">${escapeHtml(modeLabel(session.permissionMode))} &#x21bb;</button>
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
