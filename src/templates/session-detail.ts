import type { AgentSession, AgentMessage } from "../types.ts";
import { escapeHtml, renderSessionHeaderStatus, renderSessionStats, renderMessage, renderTurnCompleteFooter, modeLabel, modeTooltip } from "./components.ts";

export function renderSessionDetail(session: AgentSession, messages: AgentMessage[] = []): string {
  // Find the most recent non-error result message to fold into last assistant message
  const resultMsg = messages.findLast((msg) => msg.type === "result" && !msg.isError);
  const footerHtml = resultMsg ? renderTurnCompleteFooter(resultMsg) : "";

  // Render initial messages in chronological order, injecting footer into first assistant message (visual order reversed via CSS)
  let footerInjected = false;
  const messagesHtml = messages
    .map((msg, _i, arr) => {
      const html = renderMessage(msg);
      if (!html) return null;
      // Inject footer into the first (newest) assistant message (array is reversed for display)
      if (!footerInjected && footerHtml && msg.type === "assistant") {
        // Check if this is the first assistant message in the array (newest when reversed)
        const firstAssistantIndex = arr.findIndex((m) => m.type === "assistant");
        if (_i === firstAssistantIndex) {
          footerInjected = true;
          return html.replace(/<\/div><\/div>$/, footerHtml + "</div></div>");
        }
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
        <textarea name="text" class="message-input" rows="1"
          placeholder="Send a message... (Enter to send, Shift+Enter for newline)"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
          onkeydown="handleMessageKeydown(event, '${session.id}')"
          ${session.status === "streaming" || session.status === "starting" ? "disabled" : ""}></textarea>
      </form>
    </div>
    <div class="session-footer" id="session-stats" sse-swap="session-stats" hx-swap="innerHTML">
      ${renderSessionStats(session)}
    </div>
  </div>`;
}

export function renderEmptyDetail(repoCount = 0): string {
  if (repoCount === 0) {
    return `<div class="empty-state">
      <div class="empty-state-icon">&#9673;</div>
      <div class="empty-state-text">No git repos found</div>
      <div class="empty-state-hint">No git repos found in your configured directory.<br>Run <code>claudesk --setup</code> to reconfigure.</div>
    </div>`;
  }
  return `<div class="empty-state">
    <div class="empty-state-icon">&#9673;</div>
    <div class="empty-state-text">Pick a repo and choose a model to start</div>
    <div class="empty-state-hint">Select a repo from the sidebar to launch a new agent session</div>
  </div>`;
}
