import type { AgentSession, AgentStatus, AgentMessage, ContentBlock, PendingPermission, PendingQuestion } from "../types.ts";
import { renderMarkdown } from "../markdown.ts";

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

export function statusDot(status: AgentStatus): string {
  return `<span class="status-dot ${status}"></span>`;
}

export function statusBadge(status: AgentStatus): string {
  const labels: Record<AgentStatus, string> = {
    starting: "Starting",
    streaming: "Streaming",
    idle: "Idle",
    needs_input: "Input",
    error: "Error",
    stopped: "Stopped",
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

function formatCost(usd: number): string {
  if (usd === 0) return "";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function truncatePreview(str: string, max = 80): string {
  const collapsed = str.replace(/\n/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max) + "...";
}

function getToolPreview(toolName: string, toolInput: Record<string, any> | null | undefined): string {
  if (!toolInput) return "";
  const inp = toolInput;

  switch (toolName) {
    case "Bash":
      return truncatePreview(inp.command ?? inp.description ?? "");
    case "Read":
      return truncatePreview(
        (inp.file_path ?? "") +
        (inp.offset ? ` L${inp.offset}` : "") +
        (inp.limit ? ` +${inp.limit}` : "")
      );
    case "Grep":
      return truncatePreview(
        (inp.pattern ?? "") +
        (inp.path ? ` in ${inp.path}` : "") +
        (inp.glob ? ` (${inp.glob})` : "")
      );
    case "Glob":
      return truncatePreview(
        (inp.pattern ?? "") +
        (inp.path ? ` in ${inp.path}` : "")
      );
    case "Edit":
    case "Write":
      return truncatePreview(inp.file_path ?? "");
    case "WebFetch":
      return truncatePreview(inp.url ?? "");
    case "WebSearch":
      return truncatePreview(inp.query ?? "");
    case "Task":
      return truncatePreview(inp.description ?? "");
    case "NotebookEdit":
      return truncatePreview(inp.notebook_path ?? "");
    default: {
      const fallbackKeys = ["command", "file_path", "path", "pattern", "query", "url", "description"];
      for (const key of fallbackKeys) {
        if (inp[key] && typeof inp[key] === "string") {
          return truncatePreview(inp[key]);
        }
      }
      return "";
    }
  }
}

// --- Session Header Status ---

export function renderSessionHeaderStatus(session: AgentSession): string {
  const isActive = session.status === "streaming" || session.status === "starting";
  return `${statusBadge(session.status)}
    <span class="elapsed-timer"
          data-last-activity="${session.lastActivity.toISOString()}"
          data-status="${session.status}"></span>
    <span class="session-header-spacer"></span>
    <button class="btn btn--ghost" onclick="focusEditor('${session.id}')" title="Open in editor">Editor</button>
    ${isActive ? `<button class="btn btn--ghost" onclick="stopAgent('${session.id}')" title="Stop agent">Stop</button>` : ""}`;
}

// --- Session Stats ---

export function renderSessionStats(session: AgentSession): string {
  const totalTokens = session.inputTokens + session.outputTokens;
  const cost = formatCost(session.totalCostUsd);
  return `<div class="stats-row">
    <span class="stat">${formatTokens(totalTokens)}</span>
    <span class="stat-sep">·</span>
    <span class="stat">${session.turnCount} turn${session.turnCount !== 1 ? "s" : ""}</span>
    ${cost ? `<span class="stat-sep">·</span><span class="stat">${cost}</span>` : ""}
    ${session.model ? `<span class="stat-sep">·</span><span class="stat">${escapeHtml(session.model)}</span>` : ""}
  </div>`;
}

// --- Permission Prompt ---

export function renderPermissionPrompt(permission: PendingPermission, sessionId: string): string {
  const inputPreview = JSON.stringify(permission.toolInput, null, 2);
  const displayInput = inputPreview.length > 500
    ? inputPreview.slice(0, 500) + "\n..."
    : inputPreview;
  const preview = getToolPreview(permission.toolName, permission.toolInput);

  return `<div class="permission-prompt">
    <div class="permission-prompt-header">
      <span class="permission-prompt-icon">?</span>
      <span class="permission-prompt-title">Permission Required</span>
    </div>
    <div class="permission-prompt-tool">
      <span class="tool-icon">$</span>
      <span class="tool-name">${escapeHtml(permission.toolName)}</span>
      ${preview ? `<span class="tool-preview">${escapeHtml(preview)}</span>` : ""}
    </div>
    <pre class="permission-prompt-input">${escapeHtml(displayInput)}</pre>
    <div class="permission-prompt-actions">
      <button class="btn btn--primary" onclick="approvePermission('${sessionId}')">Allow</button>
      <button class="btn" onclick="denyPermission('${sessionId}')">Deny</button>
    </div>
  </div>`;
}

// --- Question Prompt ---

export function renderQuestionPrompt(pending: PendingQuestion, sessionId: string): string {
  const singleQuestionSingleSelect = pending.questions.length === 1 && !pending.questions[0].multiSelect;

  let questionsHtml = "";
  for (let i = 0; i < pending.questions.length; i++) {
    const q = pending.questions[i];
    const qIndex = i;

    let optionsHtml = "";
    for (const opt of q.options) {
      const dataAttrs = `data-session="${escapeHtml(sessionId)}" data-question="${escapeHtml(q.question)}" data-label="${escapeHtml(opt.label)}" data-index="${qIndex}"`;
      if (q.multiSelect) {
        optionsHtml += `<button type="button" class="question-option" ${dataAttrs} onclick="toggleQuestionOption(this)">
          <span class="question-option-label">${escapeHtml(opt.label)}</span>
          ${opt.description ? `<span class="question-option-desc">${escapeHtml(opt.description)}</span>` : ""}
        </button>`;
      } else {
        optionsHtml += `<button type="button" class="question-option" ${dataAttrs} onclick="selectQuestionOption(this)">
          <span class="question-option-label">${escapeHtml(opt.label)}</span>
          ${opt.description ? `<span class="question-option-desc">${escapeHtml(opt.description)}</span>` : ""}
        </button>`;
      }
    }

    // "Other" free-text input (always rendered per SDK spec)
    const otherHtml = `<div class="question-other">
      <input type="text" class="question-other-input" placeholder="Other..."
        data-session="${escapeHtml(sessionId)}" data-question="${escapeHtml(q.question)}" data-index="${qIndex}"
        onkeydown="if(event.key==='Enter'){event.preventDefault();selectQuestionOther(this)}">
    </div>`;

    questionsHtml += `<div class="question-block" data-index="${qIndex}">
      ${q.header ? `<span class="question-header-chip">${escapeHtml(q.header)}</span>` : ""}
      <div class="question-text">${escapeHtml(q.question)}</div>
      <div class="question-options">${optionsHtml}</div>
      ${otherHtml}
    </div>`;
  }

  const submitBtn = singleQuestionSingleSelect
    ? ""
    : `<div class="question-actions">
        <button type="button" class="btn btn--question" onclick="submitQuestionAnswers('${escapeHtml(sessionId)}')">Submit</button>
      </div>`;

  return `<div class="question-prompt">
    <div class="question-prompt-header">
      <span class="question-prompt-icon">?</span>
      <span class="question-prompt-title">Question</span>
    </div>
    ${questionsHtml}
    ${submitBtn}
  </div>`;
}

// --- Message Rendering ---

export function renderMessage(msg: AgentMessage): string | null {
  switch (msg.type) {
    case "user":
      return renderUserMessage(msg);
    case "assistant":
      return renderAssistantMessage(msg);
    case "result":
      return renderResultMessage(msg);
    case "system":
      return renderSystemMessage(msg);
    default:
      return null;
  }
}

function renderUserMessage(msg: AgentMessage): string {
  const text = msg.userText ?? msg.text ?? "";
  if (!text.trim()) return "";

  return `<div class="message message--user" data-id="${msg.id}" title="User">
    <div class="message-content">${escapeHtml(text)}</div>
  </div>`;
}

function renderAssistantMessage(msg: AgentMessage): string {
  if (!msg.contentBlocks?.length) return "";

  let html = `<div class="message message--assistant" data-id="${msg.id}" title="Assistant">
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
      return `<div class="content-block content-block--text markdown-body">${renderMarkdown(text)}</div>`;
    }

    case "thinking": {
      const text = block.text ?? "";
      if (!text.trim()) return "";
      const preview = text.slice(0, 100).replace(/\n/g, " ");
      return `<details class="thinking-block">
        <summary>Thinking: ${escapeHtml(preview)}${text.length > 100 ? "..." : ""}</summary>
        <div class="thinking-block-content markdown-body">${renderMarkdown(text)}</div>
      </details>`;
    }

    case "tool_use": {
      const name = block.toolName ?? "Unknown tool";
      const input = block.toolInput
        ? JSON.stringify(block.toolInput, null, 2)
        : "";
      const displayInput = input.length > 500
        ? input.slice(0, 500) + "\n..."
        : input;
      const preview = getToolPreview(name, block.toolInput as Record<string, any>);

      return `<details class="tool-block">
        <summary class="tool-summary">
          <span class="tool-icon">$</span>
          <span class="tool-name">${escapeHtml(name)}</span>
          ${preview ? `<span class="tool-preview">${escapeHtml(preview)}</span>` : ""}
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

function renderResultMessage(msg: AgentMessage): string {
  if (msg.isError) {
    return `<div class="message message--system message--error" data-id="${msg.id}" title="Error">
      <div class="message-content">${escapeHtml(msg.text ?? "Agent error")}</div>
    </div>`;
  }

  const parts: string[] = [];
  if (msg.durationMs) parts.push(`Completed in ${formatDuration(msg.durationMs)}`);
  if (msg.costUsd) parts.push(formatCost(msg.costUsd));
  if (msg.numTurns) parts.push(`${msg.numTurns} turns`);

  const summary = parts.length > 0 ? parts.join(" · ") : "Done";

  return `<div class="message message--system" data-id="${msg.id}" title="Result">
    <div class="message-content">${escapeHtml(summary)}</div>
  </div>`;
}

function renderSystemMessage(msg: AgentMessage): string {
  if (!msg.text) return "";

  return `<div class="message message--system" data-id="${msg.id}" title="System">
    <div class="message-content">${escapeHtml(msg.text)}</div>
  </div>`;
}
