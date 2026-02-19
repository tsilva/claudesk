import type { AgentSession, AgentStatus, AgentMessage, ContentBlock, PendingPermission, PendingQuestion, PermissionMode } from "../types.ts";
import { renderMarkdown } from "../markdown.ts";

// --- Permission Mode ---

const MODE_ORDER: PermissionMode[] = ['plan', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk'];
const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Plan',  // legacy sessions display as Plan
  plan: 'Plan',
  acceptEdits: 'Accept Edits',
  bypassPermissions: 'Bypass',
  delegate: 'Delegate',
  dontAsk: "Don't Ask",
};
const MODE_TOOLTIPS: Record<string, string> = {
  default: 'Agent creates a plan for approval before making changes',
  plan: 'Agent creates a plan for approval before making changes',
  acceptEdits: 'Agent can read and edit files freely, asks before running commands',
  bypassPermissions: 'Agent runs all tools without asking — use with caution',
  delegate: 'Agent works independently, notifies you only on completion',
  dontAsk: 'Agent remembers your choices and stops asking for repeated tools',
};

export function modeLabel(mode: PermissionMode): string {
  return MODE_LABELS[mode] || MODE_LABELS.plan;
}

export function modeTooltip(mode: PermissionMode): string {
  return MODE_TOOLTIPS[mode] || MODE_TOOLTIPS.plan;
}

export function nextMode(mode: PermissionMode): PermissionMode {
  const idx = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? 'plan';
}

// --- Escaping ---

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Escape a string for safe embedding inside a single-quoted JS string literal in an HTML attribute. */
export function escapeJs(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

// --- Task Tool Detection ---

const TASK_TOOL_NAMES = new Set([
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
]);

function isTaskTool(name: string | undefined): boolean {
  return !!name && TASK_TOOL_NAMES.has(name);
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
    case "TodoWrite": {
      const todos = Array.isArray(inp.todos) ? inp.todos : [];
      const done = todos.filter((t: any) => t.status === "completed").length;
      return `${done}/${todos.length} tasks`;
    }
    case "TaskCreate":
      return truncatePreview(inp.subject ?? "");
    case "TaskUpdate":
      return `#${inp.taskId ?? "?"}${inp.status ? ` → ${inp.status}` : ""}`;
    case "TaskList":
      return "listing tasks";
    case "TaskGet":
      return `#${inp.taskId ?? "?"}`;
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
  const timerTs = (isActive && session.turnStartedAt ? session.turnStartedAt : session.lastActivity).toISOString();
  return `${statusBadge(session.status)}
    <span class="elapsed-timer"
          data-last-activity="${timerTs}"
          data-status="${session.status}"></span>
    <span class="session-header-spacer"></span>
    <button class="btn btn--ghost" onclick="focusEditor('${session.id}')" title="Open in editor">Editor</button>
    ${isActive ? `<button class="btn btn--ghost" onclick="stopAgent('${session.id}')" title="Stop agent">Stop</button>` : ""}`;
}

// --- Model Names ---

function friendlyModelName(model: string): string {
  if (model.startsWith('claude-opus-4')) return 'Opus 4.6';
  if (model.startsWith('claude-sonnet-4')) return 'Sonnet 4.6';
  if (model.startsWith('claude-haiku')) return 'Haiku';
  return model;
}

// --- Session Stats ---

export function renderSessionStats(session: AgentSession): string {
  const totalTokens = session.inputTokens + session.outputTokens;
  const cost = formatCost(session.totalCostUsd);
  const currentMode = session.permissionMode === 'default' ? 'plan' : (session.permissionMode || 'plan');
  const modelLabelText = session.model ? friendlyModelName(session.model) : "";
  const hasMessages = session.messages.length > 0;
  // Model is clickable only before first message is sent
  const modelClass = hasMessages ? "stat" : "stat model-stat--interactive";
  const modelDataAttrs = hasMessages ? "" : `data-session-id="${session.id}" data-action="show-model-picker"`;
  const modelTitle = hasMessages ? "" : "Click to change model (before first message)";
  return `<div class="stats-row">
    <span class="stat mode-stat mode-stat--${currentMode} mode-stat--interactive"
      onclick="cycleMode('${session.id}')"
      title="${escapeHtml(modeTooltip(session.permissionMode))} (shift+tab)">${escapeHtml(modeLabel(session.permissionMode))}</span>
    <span class="stat-sep">·</span>
    <span class="stat">${formatTokens(totalTokens)}</span>
    <span class="stat-sep">·</span>
    <span class="stat">${session.turnCount} turn${session.turnCount !== 1 ? "s" : ""}</span>
    ${cost ? `<span class="stat-sep">·</span><span class="stat">${cost}</span>` : ""}
    ${modelLabelText ? `<span class="stat-sep">·</span><span class="${modelClass}" ${modelDataAttrs} title="${modelTitle}">${escapeHtml(modelLabelText)}</span>` : ""}
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
      <button class="btn btn--primary" onclick="approvePermission('${sessionId}', '${escapeHtml(permission.toolUseId)}')">Allow</button>
      <button class="btn" onclick="denyPermission('${sessionId}', '${escapeHtml(permission.toolUseId)}')">Deny</button>
    </div>
  </div>`;
}

// --- Question Prompt ---

export function renderQuestionPrompt(pending: PendingQuestion, sessionId: string, msgId?: string): string {
  const singleQuestionSingleSelect = pending.questions.length === 1 && !pending.questions[0].multiSelect;

  let questionsHtml = "";
  for (let i = 0; i < pending.questions.length; i++) {
    const q = pending.questions[i];
    const qIndex = i;

    let optionsHtml = "";
    const msgIdAttr = msgId ? ` data-msg-id="${escapeHtml(msgId)}"` : "";
    for (const opt of q.options) {
      const dataAttrs = `data-session="${escapeHtml(sessionId)}" data-question="${escapeHtml(q.question)}" data-label="${escapeHtml(opt.label)}" data-index="${qIndex}"${msgIdAttr}`;
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
        data-session="${escapeHtml(sessionId)}" data-question="${escapeHtml(q.question)}" data-index="${qIndex}"${msgIdAttr}
        onkeydown="if(event.key==='Enter'){event.preventDefault();selectQuestionOther(this)}">
    </div>`;

    questionsHtml += `<div class="question-block" data-index="${qIndex}">
      ${q.header ? `<span class="question-header-chip">${escapeHtml(q.header)}</span>` : ""}
      <div class="question-text">${escapeHtml(q.question)}</div>
      <div class="question-options">${optionsHtml}</div>
      ${otherHtml}
    </div>`;
  }

  const msgIdJs = msgId ? `, '${escapeJs(msgId)}'` : "";
  const submitBtn = singleQuestionSingleSelect
    ? ""
    : `<div class="question-actions">
        <button type="button" class="btn btn--question" onclick="submitQuestionAnswers('${escapeJs(sessionId)}'${msgIdJs})">Submit</button>
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
  if (msg.permissionData) return renderPermissionMessage(msg);
  if (msg.questionData) return renderQuestionMessage(msg);
  if (msg.planApprovalData) return renderPlanApprovalMessage(msg);

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

function renderPermissionMessage(msg: AgentMessage): string {
  const pd = msg.permissionData!;
  const sid = msg.sessionId ?? "";
  const toolUseId = pd.toolUseId ?? "";

  if (pd.resolved) {
    // Compact resolved badge
    const preview = getToolPreview(pd.toolName, pd.toolInput as Record<string, any>);
    const badgeClass = pd.resolved === "allowed" ? "permission-badge--allowed"
      : pd.resolved === "denied" ? "permission-badge--denied"
      : "permission-badge--timeout";
    const label = pd.resolved === "allowed" ? "Allowed"
      : pd.resolved === "denied" ? "Denied"
      : "Timed Out";

    return `<div class="message message--system" id="${msg.id}" data-id="${msg.id}">
      <div class="message-content permission-resolved">
        <span class="tool-icon">$</span>
        <span class="tool-name">${escapeHtml(pd.toolName)}</span>
        ${preview ? `<span class="tool-preview">${escapeHtml(preview)}</span>` : ""}
        <span class="permission-badge ${badgeClass}">${label}</span>
      </div>
    </div>`;
  }

  // Pending: full permission prompt inline
  const inputPreview = JSON.stringify(pd.toolInput, null, 2);
  const displayInput = inputPreview.length > 500
    ? inputPreview.slice(0, 500) + "\n..."
    : inputPreview;
  const preview = getToolPreview(pd.toolName, pd.toolInput as Record<string, any>);

  return `<div class="message message--permission" id="${msg.id}" data-id="${msg.id}">
    <div class="message-content">
      <div class="permission-prompt permission-prompt--inline">
        <div class="permission-prompt-header">
          <span class="permission-prompt-icon">?</span>
          <span class="permission-prompt-title">Permission Required</span>
        </div>
        <div class="permission-prompt-tool">
          <span class="tool-icon">$</span>
          <span class="tool-name">${escapeHtml(pd.toolName)}</span>
          ${preview ? `<span class="tool-preview">${escapeHtml(preview)}</span>` : ""}
        </div>
        <pre class="permission-prompt-input">${escapeHtml(displayInput)}</pre>
        <div class="permission-prompt-actions">
          <button class="btn btn--primary" onclick="approvePermission('${escapeHtml(sid)}', '${escapeHtml(toolUseId)}')">Allow</button>
          <button class="btn" onclick="showDenyInput('${escapeHtml(sid)}', '${escapeHtml(toolUseId)}', this)">Deny</button>
        </div>
        <div class="deny-input-row" id="deny-row-${escapeHtml(toolUseId)}" style="display:none">
          <input type="text" class="deny-reason-input" placeholder="Denial reason (optional)..."
            onkeydown="if(event.key==='Enter'){event.preventDefault();confirmDeny('${escapeHtml(sid)}','${escapeHtml(toolUseId)}',this)}">
          <button class="btn" onclick="confirmDeny('${escapeHtml(sid)}','${escapeHtml(toolUseId)}',this.previousElementSibling)">Confirm Deny</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderQuestionMessage(msg: AgentMessage): string {
  const qd = msg.questionData!;
  const sid = msg.sessionId ?? "";

  if (qd.resolved) {
    const label = qd.resolved === "answered" ? "Answered" : "Timed Out";
    const badgeClass = qd.resolved === "answered" ? "question-badge--answered" : "question-badge--timeout";
    const summary = qd.answerSummary ? `: ${qd.answerSummary}` : "";
    const firstQ = qd.questions[0]?.question ?? "Question";

    // Build expanded content showing answers sent to agent
    let expandedContent = "";
    if (qd.resolved === "answered" && qd.answers && Object.keys(qd.answers).length > 0) {
      for (const [question, answer] of Object.entries(qd.answers)) {
        if (answer) {
          expandedContent += `<div class="question-detail-block">
            <div class="question-detail-answer">${escapeHtml(answer)}</div>
          </div>`;
        }
      }
    }

    return `<div class="message message--system" id="${msg.id}" data-id="${msg.id}">
      <div class="message-content">
        <details class="question-resolved-details">
          <summary class="question-resolved-summary">
            <span class="question-prompt-icon" style="width:16px;height:16px;font-size:10px;">?</span>
            <span class="question-resolved-text">${escapeHtml(firstQ)}</span>
            <span class="question-badge ${badgeClass}">${escapeHtml(label + summary)}</span>
          </summary>
          ${expandedContent ? `<div class="question-resolved-content">${expandedContent}</div>` : ""}
        </details>
      </div>
    </div>`;
  }

  // Pending: full question prompt inline — reuse renderQuestionPrompt logic
  const pending = {
    toolUseId: "",
    questions: qd.questions,
    originalInput: qd.originalInput,
    resolve: () => {},
    timeoutId: 0 as any,
  };
  const promptHtml = renderQuestionPrompt(pending as any, sid, msg.id);

  return `<div class="message message--question" id="${msg.id}" data-id="${msg.id}">
    <div class="message-content">
      ${promptHtml}
    </div>
  </div>`;
}

function renderPlanApprovalMessage(msg: AgentMessage): string {
  const pd = msg.planApprovalData!;
  const sid = msg.sessionId ?? "";

  if (pd.resolved) {
    const badgeClass = pd.resolved === "accepted" ? "plan-badge--accepted"
      : pd.resolved === "revised" ? "plan-badge--revised"
      : "plan-badge--timeout";
    const label = pd.resolved === "accepted" ? "Accepted"
      : pd.resolved === "revised" ? "Revised"
      : "Timed Out";
    const feedback = pd.resolved === "revised" && pd.reviseFeedback
      ? `: ${pd.reviseFeedback}`
      : "";

    return `<div class="message message--system" id="${msg.id}" data-id="${msg.id}">
      <div class="message-content plan-approval-resolved">
        <span class="plan-approval-icon-sm">P</span>
        <span class="plan-approval-resolved-text">Plan Review</span>
        <span class="plan-badge ${badgeClass}">${escapeHtml(label + feedback)}</span>
      </div>
    </div>`;
  }

  // Pending: full plan approval prompt inline
  let promptsHtml = "";
  if (pd.allowedPrompts.length > 0) {
    promptsHtml = `<div class="plan-prompts-list">`;
    for (const p of pd.allowedPrompts) {
      promptsHtml += `<div class="plan-prompt-item">${escapeHtml(p.prompt)}</div>`;
    }
    promptsHtml += `</div>`;
  }

  const planBodyHtml = pd.planContent
    ? `<div class="plan-approval-body markdown-body">${renderMarkdown(pd.planContent)}</div>`
    : "";

  return `<div class="message message--plan-approval" id="${msg.id}" data-id="${msg.id}">
    <div class="message-content">
      <div class="plan-approval-prompt">
        <div class="plan-approval-header">
          <span class="plan-approval-icon">P</span>
          <span class="plan-approval-title">Plan Ready for Review</span>
        </div>
        ${planBodyHtml}
        ${promptsHtml ? `<div class="plan-approval-section-label">Requested permissions:</div>${promptsHtml}` : ""}
        <div class="plan-approval-actions">
          <button class="btn btn--plan-accept" onclick="acceptPlan('${escapeHtml(sid)}')">Accept</button>
          <input type="text" class="plan-revise-input" id="plan-revise-input-${escapeHtml(pd.toolUseId)}" placeholder="Revision feedback..." onkeydown="if(event.key==='Enter'){event.preventDefault();revisePlan('${escapeHtml(sid)}')}">
          <button class="btn btn--plan-revise" onclick="revisePlan('${escapeHtml(sid)}')">Revise</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderUserMessage(msg: AgentMessage): string {
  const text = msg.userText ?? msg.text ?? "";
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  if (!text.trim() && !hasAttachments) return "";

  let attachmentsHtml = "";
  if (hasAttachments) {
    attachmentsHtml = `<div class="message-attachments">`;
    for (const att of msg.attachments!) {
      if (att.type.startsWith("image/")) {
        attachmentsHtml += `<div class="attachment attachment--image" onclick="openImageLightbox('${escapeHtml(att.data)}')">
          <img src="data:${escapeHtml(att.type)};base64,${escapeHtml(att.data)}" alt="${escapeHtml(att.name)}">
        </div>`;
      } else if (att.type === "application/pdf") {
        const sizeKb = Math.round(att.size / 1024);
        attachmentsHtml += `<div class="attachment attachment--file attachment--pdf">
          <span class="attachment-file-icon">📑</span>
          <span class="attachment-file-name">${escapeHtml(att.name)}</span>
          <span class="attachment-file-size">${sizeKb} KB</span>
        </div>`;
      } else {
        const sizeKb = Math.round(att.size / 1024);
        attachmentsHtml += `<div class="attachment attachment--file">
          <span class="attachment-file-icon">📄</span>
          <span class="attachment-file-name">${escapeHtml(att.name)}</span>
          <span class="attachment-file-size">${sizeKb} KB</span>
        </div>`;
      }
    }
    attachmentsHtml += `</div>`;
  }

  const trimmedText = text.trim();
  return `<div class="message message--user" data-id="${msg.id}" title="User">
    <div class="message-content">${trimmedText ? escapeHtml(trimmedText) : ""}${attachmentsHtml}</div>
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
      const rawJson = block.toolInput
        ? JSON.stringify(block.toolInput, null, 2)
        : "";

      if (isTaskTool(name)) {
        return renderTaskToolUse(name, block.toolInput as Record<string, any>, rawJson);
      }

      const displayInput = rawJson.length > 500
        ? rawJson.slice(0, 500) + "\n..."
        : rawJson;
      const preview = getToolPreview(name, block.toolInput as Record<string, any>);

      // Special handling for AskUserQuestion to show question preview inline
      if (name === "AskUserQuestion" && block.toolInput) {
        const input = block.toolInput as Record<string, any>;
        const questions = Array.isArray(input.questions) ? input.questions : [];
        const firstQuestion = questions[0]?.question ?? "";
        const questionPreview = firstQuestion ? truncatePreview(firstQuestion) : "";

        return `<details class="tool-block">
          <summary class="tool-summary">
            <span class="tool-icon">$</span>
            <span class="tool-name">${escapeHtml(name)}</span>
            ${questionPreview ? `<span class="tool-preview">${escapeHtml(questionPreview)}</span>` : ""}
          </summary>
          ${displayInput ? `<pre class="tool-input">${escapeHtml(displayInput)}</pre>` : ""}
        </details>`;
      }

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

      if (!isError && isTaskTool(block.toolName)) {
        return renderTaskToolResult(block.toolName!, content);
      }

      const displayContent = content.length > 1000
        ? content.slice(0, 1000) + "\n..."
        : content;

      return `<div class="tool-result${isError ? " tool-result--error" : ""}">
        <pre class="tool-result-content">${escapeHtml(displayContent)}</pre>
      </div>`;
    }

    case "image": {
      if (!block.source?.data) return "";
      const mediaType = block.source.media_type || "image/png";
      return `<div class="content-block content-block--image">
        <img src="data:${escapeHtml(mediaType)};base64,${escapeHtml(block.source.data)}" alt="Generated image" onclick="openImageLightbox('${escapeHtml(block.source.data)}', '${escapeHtml(mediaType)}')">
      </div>`;
    }

    default:
      return "";
  }
}

// --- Task Tool Rendering ---

function taskStatusIcon(status: string): { char: string; cls: string } {
  switch (status) {
    case "completed":
      return { char: "\u2713", cls: "task-status--completed" };
    case "in_progress":
      return { char: "\u25CF", cls: "task-status--in-progress" };
    default:
      return { char: "\u25CB", cls: "task-status--pending" };
  }
}

function renderTaskItem(subject: string, status: string, activeForm?: string, desc?: string): string {
  const icon = taskStatusIcon(status);
  const subjectCls = status === "completed" ? " task-item-subject--done" : "";
  const activeLabel = status === "in_progress" && activeForm
    ? `<span class="task-item-active">${escapeHtml(activeForm)}</span>`
    : "";

  return `<div class="task-item">
    <span class="task-status ${icon.cls}">${icon.char}</span>
    <span class="task-item-subject${subjectCls}">${escapeHtml(subject)}</span>
    ${activeLabel}
  </div>`;
}

function renderTodoWriteUse(input: Record<string, any>): string {
  const todos: any[] = Array.isArray(input.todos) ? input.todos : [];
  const done = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  let items = "";
  for (const t of todos) {
    items += renderTaskItem(
      t.content ?? t.subject ?? "Untitled",
      t.status ?? "pending",
      t.activeForm,
      undefined,
    );
  }

  return `<div class="task-list-header">
    <span class="task-list-icon">\u2611</span>
    <span class="task-list-title">Tasks</span>
    <span class="task-list-count">${done}/${total}</span>
  </div>
  <div class="task-items">${items}</div>`;
}

function renderTaskCreateUse(input: Record<string, any>): string {
  return `<div class="task-list-header">
    <span class="task-list-icon">+</span>
    <span class="task-list-title">New Task</span>
  </div>
  <div class="task-items">${renderTaskItem(
    input.subject ?? "Untitled",
    "pending",
    input.activeForm,
    input.description,
  )}</div>`;
}

function renderTaskUpdateUse(input: Record<string, any>): string {
  const parts: string[] = [];
  if (input.status) parts.push(input.status);
  if (input.subject) parts.push(`"${input.subject}"`);
  const summary = parts.length ? parts.join(" — ") : "updating";

  return `<div class="task-list-header">
    <span class="task-list-icon">\u270E</span>
    <span class="task-list-title">Update #${escapeHtml(String(input.taskId ?? "?"))}</span>
    <span class="task-list-count">${escapeHtml(summary)}</span>
  </div>`;
}

function renderTaskListUse(): string {
  return `<div class="task-list-header">
    <span class="task-list-icon">\u2630</span>
    <span class="task-list-title">Listing tasks</span>
  </div>`;
}

function renderTaskGetUse(input: Record<string, any>): string {
  return `<div class="task-list-header">
    <span class="task-list-icon">\u2630</span>
    <span class="task-list-title">Getting task #${escapeHtml(String(input.taskId ?? "?"))}</span>
  </div>`;
}

function renderTaskToolUse(name: string, input: Record<string, any> | null | undefined, rawJson: string): string {
  const inp = input ?? {};
  let body = "";

  switch (name) {
    case "TodoWrite":
      body = renderTodoWriteUse(inp);
      break;
    case "TaskCreate":
      body = renderTaskCreateUse(inp);
      break;
    case "TaskUpdate":
      body = renderTaskUpdateUse(inp);
      break;
    case "TaskList":
      body = renderTaskListUse();
      break;
    case "TaskGet":
      body = renderTaskGetUse(inp);
      break;
    default:
      body = `<div class="task-list-header"><span class="task-list-title">${escapeHtml(name)}</span></div>`;
  }

  const displayRaw = rawJson.length > 500
    ? rawJson.slice(0, 500) + "\n..."
    : rawJson;

  return `<div class="task-tool-block">
    ${body}
    ${rawJson ? `<details class="task-tool-raw"><summary>JSON</summary><pre class="tool-input">${escapeHtml(displayRaw)}</pre></details>` : ""}
  </div>`;
}

function renderTaskToolResult(toolName: string, content: string): string {
  if (!content.trim()) return "";

  // Try to parse structured results for TaskList/TaskGet
  if (toolName === "TaskList" || toolName === "TaskGet") {
    try {
      const parsed = JSON.parse(content);

      // TaskList returns an array of tasks
      if (Array.isArray(parsed) && parsed.length > 0) {
        const done = parsed.filter((t: any) => t.status === "completed").length;
        let items = "";
        for (const t of parsed) {
          items += renderTaskItem(
            t.subject ?? `#${t.id ?? "?"}`,
            t.status ?? "pending",
            t.activeForm,
          );
        }
        return `<div class="task-tool-block">
          <div class="task-list-header">
            <span class="task-list-icon">\u2611</span>
            <span class="task-list-title">Tasks</span>
            <span class="task-list-count">${done}/${parsed.length}</span>
          </div>
          <div class="task-items">${items}</div>
        </div>`;
      }

      // TaskGet returns a single task object
      if (parsed && typeof parsed === "object" && parsed.subject) {
        return `<div class="task-tool-block">
          <div class="task-items">${renderTaskItem(
            parsed.subject,
            parsed.status ?? "pending",
            parsed.activeForm,
            parsed.description,
          )}</div>
        </div>`;
      }
    } catch {
      // Fall through to default
    }
  }

  // Default: compact result for task tools (suppress verbose output)
  const displayContent = content.length > 300
    ? content.slice(0, 300) + "..."
    : content;
  return `<div class="tool-result">
    <pre class="tool-result-content">${escapeHtml(displayContent)}</pre>
  </div>`;
}

function renderResultMessage(msg: AgentMessage): string {
  if (msg.isError) {
    return `<div class="message message--system message--error" data-id="${msg.id}" title="Error">
      <div class="message-content">${escapeHtml(msg.text ?? "Agent error")}</div>
    </div>`;
  }

  // Non-error results are rendered as turn-complete footers, not standalone messages
  return "";
}

export function renderTurnCompleteFooter(msg: AgentMessage): string {
  const parts: string[] = [];
  if (msg.durationMs) parts.push(`Completed in ${formatDuration(msg.durationMs)}`);
  if (msg.costUsd) parts.push(formatCost(msg.costUsd));
  if (msg.numTurns) parts.push(`${msg.numTurns} turns`);

  const summary = parts.length > 0 ? parts.join(" · ") : "Done";

  return `<div class="turn-complete-footer">${escapeHtml(summary)}</div>`;
}

function renderSystemMessage(msg: AgentMessage): string {
  if (!msg.text) return "";

  return `<div class="message message--system" data-id="${msg.id}" title="System">
    <div class="message-content">${escapeHtml(msg.text)}</div>
  </div>`;
}
