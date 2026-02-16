import type { Session, SessionStatus, ParsedMessage, ContentBlock } from "../sessions.ts";

// --- Escaping ---

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- Status ---

export function statusDot(status: SessionStatus): string {
  return `<span class="status-dot ${status}"></span>`;
}

export function statusBadge(status: SessionStatus): string {
  const labels: Record<SessionStatus, string> = {
    streaming: "Streaming",
    idle: "Idle",
    needs_permission: "Permission",
    died: "Ended",
  };
  return `<span class="status-badge ${status}">${labels[status]}</span>`;
}

// --- Formatting ---

export function relativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatTokens(tokens: number): string {
  if (tokens === 0) return "";
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k tok`;
  return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// --- Session Stats ---

export function renderSessionStats(session: Session): string {
  return `<div class="stats-row">
    <span class="stat">${formatTokens(session.totalTokens)}</span>
    <span class="stat-sep">·</span>
    <span class="stat">${session.turnCount} turn${session.turnCount !== 1 ? "s" : ""}</span>
    ${session.gitBranch ? `<span class="stat-sep">·</span><span class="stat">${escapeHtml(session.gitBranch)}</span>` : ""}
  </div>`;
}

// --- Message Rendering ---

export function renderMessage(msg: ParsedMessage): string | null {
  switch (msg.type) {
    case "user":
      return renderUserMessage(msg);
    case "assistant":
      return renderAssistantMessage(msg);
    case "progress":
      return renderProgressMessage(msg);
    case "system":
      return renderSystemMessage(msg);
    case "tool_use":
    case "tool_result":
      return renderToolMessage(msg);
    default:
      return null;
  }
}

function renderUserMessage(msg: ParsedMessage): string {
  const text = msg.text ?? "";
  if (!text.trim()) return "";

  return `<div class="message message--user" data-uuid="${msg.uuid}">
    <div class="message-role">User</div>
    <div class="message-content">${escapeHtml(text)}</div>
  </div>`;
}

function renderAssistantMessage(msg: ParsedMessage): string {
  if (!msg.contentBlocks?.length) return "";

  let html = `<div class="message message--assistant" data-uuid="${msg.uuid}">
    <div class="message-role">Assistant</div>
    <div class="message-content">`;

  for (const block of msg.contentBlocks) {
    html += renderContentBlock(block);
  }

  html += `</div></div>`;
  return html;
}

function renderContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text": {
      const text = block.text ?? "";
      if (!text.trim()) return "";
      return `<div class="content-block content-block--text">${escapeHtml(text)}</div>`;
    }

    case "thinking": {
      const text = block.text ?? "";
      if (!text.trim()) return "";
      const preview = text.slice(0, 100).replace(/\n/g, " ");
      return `<details class="thinking-block">
        <summary>Thinking: ${escapeHtml(preview)}${text.length > 100 ? "..." : ""}</summary>
        <div class="thinking-block-content">${escapeHtml(text)}</div>
      </details>`;
    }

    case "tool_use": {
      const name = block.toolName ?? "Unknown tool";
      const input = block.toolInput
        ? JSON.stringify(block.toolInput, null, 2)
        : "";
      // Truncate long inputs
      const displayInput = input.length > 500
        ? input.slice(0, 500) + "\n..."
        : input;

      return `<details class="tool-block">
        <summary class="tool-summary">
          <span class="tool-icon">$</span>
          <span class="tool-name">${escapeHtml(name)}</span>
        </summary>
        ${displayInput ? `<pre class="tool-input">${escapeHtml(displayInput)}</pre>` : ""}
      </details>`;
    }

    case "tool_result": {
      const content = block.content ?? "";
      const isError = block.isError ?? false;
      const displayContent = content.length > 1000
        ? content.slice(0, 1000) + "\n..."
        : content;

      return `<div class="tool-result${isError ? " tool-result--error" : ""}">
        <pre class="tool-result-content">${escapeHtml(displayContent)}</pre>
      </div>`;
    }

    default:
      return "";
  }
}

function renderProgressMessage(msg: ParsedMessage): string {
  const text = msg.progressMessage ?? "";
  if (!text.trim()) return "";

  // Agent progress shows as a small status line
  if (msg.progressType === "agent_progress") {
    const preview = text.slice(0, 120);
    return `<div class="message message--progress" data-progress-type="agent">
      <span class="progress-label">Agent</span> ${escapeHtml(preview)}${text.length > 120 ? "..." : ""}
    </div>`;
  }

  return `<div class="message message--progress">
    ${escapeHtml(text.slice(0, 200))}
  </div>`;
}

function renderSystemMessage(msg: ParsedMessage): string {
  if (msg.systemSubtype === "stop_hook_summary") {
    return `<div class="message message--system">
      <div class="message-role">System</div>
      <div class="message-content">Session stopped — waiting for input</div>
    </div>`;
  }

  if (msg.durationMs) {
    return `<div class="message message--system">
      <div class="message-role">System</div>
      <div class="message-content">Turn completed in ${formatDuration(msg.durationMs)}</div>
    </div>`;
  }

  return "";
}

function renderToolMessage(msg: ParsedMessage): string {
  if (msg.type === "tool_use") {
    return `<details class="message message--tool">
      <summary>
        <span class="tool-icon">$</span>
        ${escapeHtml(msg.toolName ?? "Tool")}
      </summary>
      ${msg.toolInput ? `<pre class="tool-input">${escapeHtml(msg.toolInput)}</pre>` : ""}
    </details>`;
  }
  return "";
}
