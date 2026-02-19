import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import type {
  AgentSession,
  AgentMessage,
  AgentStatus,
  ContentBlock,
  LaunchableRepo,
  RepoGitStatus,
  PendingPermission,
  PendingQuestion,
  PendingPlanApproval,
  QuestionItem,
  PermissionResult,
  PermissionMode,
  PermissionUpdate,
  ModelPreset,
  SDKThinkingBlock,
  SDKToolResultBlock,
  SDKSystemInitMessage,
  SDKSystemHookMessage,
  SDKResultErrorMessage,
} from "./types.ts";
import {
  ensureDataDir,
  saveSession,
  loadAllSessions,
  deleteSessionFile,
} from "./persistence.ts";
import { getReposDir } from "./config.ts";

// --- Constants ---

const ARCHIVED_MARKER = ".archived";
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MESSAGE_WINDOW_LIMIT = 100; // Maximum messages to keep in memory per session

// --- Git Helpers ---

async function gitCount(repoPath: string, args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoPath, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const count = parseInt(output.trim(), 10);
    return isNaN(count) ? 0 : count;
  } catch { return 0; }
}

async function getUncommittedCount(repoPath: string): Promise<number> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: repoPath, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim() ? output.trim().split("\n").length : 0;
  } catch { return 0; }
}

async function getUnpulledCount(repoPath: string): Promise<number> {
  return gitCount(repoPath, ["rev-list", "HEAD..@{upstream}", "--count"]);
}

async function getUnpushedCount(repoPath: string): Promise<number> {
  return gitCount(repoPath, ["rev-list", "@{upstream}..HEAD", "--count"]);
}

async function getRepoGitStatus(repoPath: string): Promise<RepoGitStatus> {
  const [uncommitted, unpulled, unpushed] = await Promise.all([
    getUncommittedCount(repoPath),
    getUnpulledCount(repoPath),
    getUnpushedCount(repoPath),
  ]);
  return { uncommitted, unpulled, unpushed };
}

// --- Callbacks ---

type MessageCallback = (msg: AgentMessage, session: AgentSession) => void | Promise<void>;
type SessionChangeCallback = (sessions: AgentSession[]) => void;

// --- Plan Mode Helpers ---

function buildExitPlanPermissions(suggestions?: PermissionUpdate[]): PermissionUpdate[] {
  const setModeDefault: PermissionUpdate = {
    type: 'setMode',
    mode: 'default',
    destination: 'session',
  };

  if (!suggestions || suggestions.length === 0) {
    return [setModeDefault];
  }

  if (suggestions.some((s) => s.type === 'setMode')) {
    return suggestions;
  }

  return [...suggestions, setModeDefault];
}

// --- Message Windowing Helper ---

/**
 * Trims message history to MESSAGE_WINDOW_LIMIT while preserving:
 * - System messages (critical for context)
 * - Messages with pending permissions/questions/plan approvals
 * - The most recent messages
 */
function trimMessageWindow(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= MESSAGE_WINDOW_LIMIT) {
    return messages;
  }

  // Identify indices of messages that must be preserved
  const preserveIndices = new Set<number>();
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    // Preserve system messages
    if (msg.type === "system") {
      preserveIndices.add(i);
    }
    // Preserve messages with unresolved pending states
    if (msg.permissionData && !msg.permissionData.resolved) {
      preserveIndices.add(i);
    }
    if (msg.questionData && !msg.questionData.resolved) {
      preserveIndices.add(i);
    }
    if (msg.planApprovalData && !msg.planApprovalData.resolved) {
      preserveIndices.add(i);
    }
  }

  // Always preserve the most recent messages up to the limit
  const numToPreserve = Math.min(MESSAGE_WINDOW_LIMIT, messages.length);
  const startIndex = messages.length - numToPreserve;
  
  for (let i = startIndex; i < messages.length; i++) {
    preserveIndices.add(i);
  }

  // Build the trimmed array preserving order
  const trimmed: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (preserveIndices.has(i) || i >= startIndex) {
      const msg = messages[i];
      if (msg) {
        trimmed.push(msg);
      }
    }
  }

  return trimmed;
}

// --- AgentManager ---

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private queries = new Map<string, Query>();
  private abortControllers = new Map<string, AbortController>();
  private onMessage: MessageCallback;
  private onSessionChange: SessionChangeCallback;
  private launchableRepos: LaunchableRepo[] = [];
  private lastBroadcast = new Map<string, number>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cachedPendingCounts: Map<string, RepoGitStatus> = new Map();

  constructor(onMessage: MessageCallback, onSessionChange: SessionChangeCallback) {
    this.onMessage = onMessage;
    this.onSessionChange = onSessionChange;
  }

  // --- Initialization ---

  async init(): Promise<void> {
    await ensureDataDir();
    await this.scanLaunchableRepos();
    const restored = await loadAllSessions();
    for (const session of restored) {
      this.sessions.set(session.id, session);
    }
    if (restored.length > 0) {
      console.log(`[persistence] restored ${restored.length} session(s)`);
      this.onSessionChange(this.getSessions());
    }
  }

  // --- Persistence ---

  private persistSession(sessionId: string, immediate = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (immediate) {
      const existing = this.persistTimers.get(sessionId);
      if (existing) {
        clearTimeout(existing);
        this.persistTimers.delete(sessionId);
      }
      saveSession(session).catch((err) =>
        console.warn(`[persistence] save failed for ${sessionId}:`, err)
      );
      return;
    }

    if (this.persistTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(sessionId);
      saveSession(session).catch((err) =>
        console.warn(`[persistence] save failed for ${sessionId}:`, err)
      );
    }, 2000);
    this.persistTimers.set(sessionId, timer);
  }

  // --- Public API ---

  private lastUsedModel: string = "claude-opus-4-6";

  createSession(cwd: string, model?: string, permissionMode?: PermissionMode, preset?: ModelPreset): AgentSession {
    const id = crypto.randomUUID();
    const repoName = basename(cwd);

    // Use provided model, or fall back to last used model
    const sessionModel = model || this.lastUsedModel;

    const session: AgentSession = {
      id,
      sdkSessionId: "",
      repoName,
      cwd,
      status: "idle",
      lastMessagePreview: "",
      lastActivity: new Date(),
      createdAt: new Date(),
      gitBranch: "",
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      model: sessionModel,
      preset,
      permissionMode: permissionMode || "plan",
      pendingQuestions: [],
      pendingPlanApproval: null,
      pendingPermissions: new Map(),
      messages: [],
    };

    this.sessions.set(id, session);
    this.persistSession(id, true);
    this.onSessionChange(this.getSessions());

    return session;
  }

  async launch(cwd: string, prompt: string, model?: string, permissionMode?: PermissionMode, preset?: ModelPreset): Promise<AgentSession> {
    const session = this.createSession(cwd, model, permissionMode, preset);
    await this.scanLaunchableRepos();
    await this.sendMessage(session.id, prompt);
    return session;
  }

  async sendMessage(sessionId: string, text: string, attachments?: { name: string; type: string; size: number; data: string }[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    if (session.status === "streaming" || session.status === "starting") {
      throw new Error(`Session is busy (status: ${session.status})`);
    }
    if (session.status === "stopped") {
      throw new Error("Session has been stopped");
    }

    // Abort any lingering query before starting a new one
    const existingController = this.abortControllers.get(sessionId);
    if (existingController) {
      existingController.abort();
      this.abortControllers.delete(sessionId);
    }
    const existingQuery = this.queries.get(sessionId);
    if (existingQuery) {
      existingQuery.close();
      this.queries.delete(sessionId);
    }

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    // Convert attachments to SDK format
    const userAttachments: import("./types.ts").Attachment[] = [];
    const contentBlocks: import("./types.ts").ContentBlock[] = [];
    
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        userAttachments.push({
          id: crypto.randomUUID(),
          name: att.name,
          type: att.type,
          size: att.size,
          data: att.data,
        });
        
        // For images, create image content blocks for the SDK
        if (att.type.startsWith("image/")) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.type,
              data: att.data,
            },
          });
        }
      }
    }

    // Add user message
    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      timestamp: new Date(),
      userText: text,
      text,
      attachments: userAttachments,
    };
    session.messages.push(userMsg);
    session.messages = trimMessageWindow(session.messages);
    session.lastMessagePreview = text.slice(0, 80);
    session.lastActivity = new Date();
    session.turnStartedAt = session.lastActivity;
    session.status = "streaming";

    // Track this model as the last used for future sessions
    this.lastUsedModel = session.model;

    this.persistSession(sessionId);
    this.onMessage(userMsg, session);
    this.onSessionChange(this.getSessions());

    // Strip CLAUDECODE so the subprocess can run even inside a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // First message: start new query; follow-up: resume existing session
    const options: Record<string, unknown> = {
      cwd: session.cwd,
      model: session.model,
      abortController,
      permissionMode: session.permissionMode,
      env,
      settingSources: ['user', 'project', 'local'],
      canUseTool: (toolName: string, input: unknown, opts: { toolUseID: string; suggestions?: unknown[] }) => {
        return this.handleCanUseTool(sessionId, toolName, input as Record<string, unknown>, opts.toolUseID, opts.suggestions as PermissionUpdate[] | undefined);
      },
    };
    if (session.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
    if (session.sdkSessionId) {
      options.resume = session.sdkSessionId;
    }

    // Build prompt - use streaming input for images/documents, string for text-only
    let prompt;
    const hasVisualContent = attachments && attachments.some(a => 
      a.type.startsWith("image/") || a.type === "application/pdf"
    );
    
    if (hasVisualContent) {
      // Use streaming input mode for multimodal messages (images + PDFs)
      const imageAttachments = attachments!.filter(a => a.type.startsWith("image/"));
      const pdfAttachments = attachments!.filter(a => a.type === "application/pdf");
      
      const content: Array<{ 
        type: string; 
        text?: string; 
        source?: { type: string; media_type: string; data: string } 
      }> = [];
      
      if (text?.trim()) {
        content.push({ type: "text", text });
      }
      
      // Add image content blocks
      for (const img of imageAttachments) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.type,
            data: img.data,
          },
        });
      }
      
      // Add PDF document content blocks
      for (const pdf of pdfAttachments) {
        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdf.data,
          },
        });
      }
      
      // Create async generator for streaming input
      async function* messageGenerator() {
        yield {
          type: "user" as const,
          message: {
            role: "user" as const,
            content,
          },
          parent_tool_use_id: null,
          session_id: "",
        };
      }
      
      prompt = messageGenerator();
    } else {
      // Simple text-only message
      prompt = text || "";
    }

    const q = query({ prompt, options });

    this.queries.set(sessionId, q);
    this.consumeStream(sessionId, q);
  }

  respondToPermission(sessionId: string, allow: boolean, message?: string, toolUseId?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Find the right pending permission by toolUseId, or fall back to first one
    let pending: PendingPermission | undefined;
    if (toolUseId) {
      pending = session.pendingPermissions.get(toolUseId);
    } else {
      // Legacy fallback: resolve the first pending permission
      const first = session.pendingPermissions.values().next();
      if (!first.done) pending = first.value;
    }
    if (!pending) return;

    // Race condition guard: check if already processed before doing anything
    if (!session.pendingPermissions.has(pending.toolUseId)) {
      return; // Already resolved by another concurrent call
    }

    clearTimeout(pending.timeoutId);

    // Update the inline permission message to show resolved state
    const permMsg = session.messages.find(m => m.id === `perm-${pending.toolUseId}`);
    if (permMsg?.permissionData) {
      permMsg.permissionData.resolved = allow ? "allowed" : "denied";
      this.onMessage(permMsg, session);
    }

    session.pendingPermissions.delete(pending.toolUseId);

    // Only transition to streaming if no more pending permissions/questions/plan approvals
    if (session.pendingPermissions.size === 0 && session.pendingQuestions.length === 0 && !session.pendingPlanApproval) {
      session.status = "streaming";
    }
    this.onSessionChange(this.getSessions());

    if (allow) {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: message || "User denied permission" });
    }
  }

  answerQuestion(sessionId: string, toolUseId: string, answers: Record<string, string>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Find the specific pending question by toolUseId
    const pendingIndex = session.pendingQuestions.findIndex(q => q.toolUseId === toolUseId);
    if (pendingIndex === -1) return;

    const pending = session.pendingQuestions[pendingIndex]!;

    clearTimeout(pending.timeoutId);

    // Update the inline question message to show answered state
    const answerText = Object.values(answers).filter(Boolean).join(", ");
    const qMsg = session.messages.find(m => m.id === `q-${pending.toolUseId}`);
    if (qMsg?.questionData) {
      qMsg.questionData.resolved = "answered";
      qMsg.questionData.answerSummary = answerText || "Answered";
      this.onMessage(qMsg, session);
    }

    // Remove this question from the pending array
    session.pendingQuestions.splice(pendingIndex, 1);
    
    // Only transition to streaming if no more pending permissions/questions/plan approvals
    if (session.pendingPermissions.size === 0 && session.pendingQuestions.length === 0 && !session.pendingPlanApproval) {
      session.status = "streaming";
    }
    this.onSessionChange(this.getSessions());

    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.originalInput, answers },
    });
  }

  async respondToPlanApproval(sessionId: string, accept: boolean, feedback?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingPlanApproval) return;

    const pending = session.pendingPlanApproval;

    // Race condition guard: check if already processed before doing anything
    if (session.pendingPlanApproval !== pending) {
      return; // Already resolved by another concurrent call
    }

    clearTimeout(pending.timeoutId);

    // Update the inline plan approval message to show resolved state
    const planMsg = session.messages.find(m => m.id === `plan-${pending.toolUseId}`);
    if (planMsg?.planApprovalData) {
      planMsg.planApprovalData.resolved = accept ? "accepted" : "revised";
      if (!accept && feedback) {
        planMsg.planApprovalData.reviseFeedback = feedback;
      }
      this.onMessage(planMsg, session);
    }

    session.pendingPlanApproval = null;

    if (accept) {
      session.permissionMode = "default";
      if (session.preset === 'opus-plan') {
        session.model = 'claude-sonnet-4-6';
        const q = this.queries.get(sessionId);
        if (q && typeof q.setModel === 'function') {
          await q.setModel('claude-sonnet-4-6').catch((err: unknown) =>
            console.warn(`[model-switch] setModel failed:`, err)
          );
        }
      }
    }

    // Only transition to streaming if no more pending permissions/questions
    // This happens AFTER async operations complete to avoid status race
    if (session.pendingPermissions.size === 0 && session.pendingQuestions.length === 0) {
      session.status = "streaming";
    }

    this.onSessionChange(this.getSessions());

    if (accept) {
      pending.resolve({ behavior: "allow", updatedPermissions: buildExitPlanPermissions(pending.suggestions) });
      const q = this.queries.get(sessionId);
      if (q && typeof q.setPermissionMode === "function") {
        await q.setPermissionMode("default").catch((err: unknown) =>
          console.warn(`[plan-approval] setPermissionMode failed:`, err)
        );
      }
    } else {
      pending.resolve({ behavior: "deny", message: feedback || "User requested revision", interrupt: false });
    }
  }

  stopAgent(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Set stopped status BEFORE aborting so consumeStream's catch block sees it
    session.status = "stopped";
    session.hooksRunning = false;

    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }

    const q = this.queries.get(sessionId);
    if (q) {
      q.close();
      this.queries.delete(sessionId);
    }

    // Resolve all pending promises so the SDK is not left blocked
    for (const perm of session.pendingPermissions.values()) {
      clearTimeout(perm.timeoutId);
      perm.resolve({ behavior: "deny", message: "Agent stopped" });
    }
    session.pendingPermissions.clear();
    for (const q of session.pendingQuestions) {
      clearTimeout(q.timeoutId);
      q.resolve({ behavior: "deny", message: "Agent stopped" });
    }
    session.pendingQuestions = [];
    if (session.pendingPlanApproval) {
      clearTimeout(session.pendingPlanApproval.timeoutId);
      session.pendingPlanApproval.resolve({ behavior: "deny", message: "Agent stopped" });
      session.pendingPlanApproval = null;
    }

    // Clear persist timers
    const timer = this.persistTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(sessionId);
    }

    this.persistSession(sessionId, true);
    this.onSessionChange(this.getSessions());
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    session.permissionMode = mode;
    const q = this.queries.get(sessionId);
    if (q && typeof q.setPermissionMode === "function") {
      await q.setPermissionMode(mode);
    }
    this.persistSession(sessionId, true);
    this.onSessionChange(this.getSessions());
  }

  setSessionModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    // Only allow changing model before first message is sent
    if (session.messages.length > 0) {
      throw new Error("Cannot change model after conversation has started");
    }
    session.model = model;
    this.persistSession(sessionId, true);
    this.onSessionChange(this.getSessions());
  }

  dismissSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Resolve all pending promises so the SDK is not left blocked
    for (const perm of session.pendingPermissions.values()) {
      clearTimeout(perm.timeoutId);
      perm.resolve({ behavior: "deny", message: "Session dismissed" });
    }
    session.pendingPermissions.clear();
    for (const q of session.pendingQuestions) {
      clearTimeout(q.timeoutId);
      q.resolve({ behavior: "deny", message: "Session dismissed" });
    }
    session.pendingQuestions = [];
    if (session.pendingPlanApproval) {
      clearTimeout(session.pendingPlanApproval.timeoutId);
      session.pendingPlanApproval.resolve({ behavior: "deny", message: "Session dismissed" });
    }

    const controller = this.abortControllers.get(sessionId);
    if (controller) controller.abort();
    const q = this.queries.get(sessionId);
    if (q) q.close();

    // Clear persist timer
    const timer = this.persistTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(sessionId);
    }

    deleteSessionFile(sessionId);
    this.sessions.delete(sessionId);
    this.queries.delete(sessionId);
    this.abortControllers.delete(sessionId);
    this.lastBroadcast.delete(sessionId);

    this.onSessionChange(this.getSessions());
    return true;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()
    );
  }

  getLaunchableRepos(): LaunchableRepo[] {
    return this.launchableRepos;
  }

  getCachedPendingCounts(): Map<string, RepoGitStatus> {
    return this.cachedPendingCounts;
  }

  async getSessionsNeedingAttention(): Promise<{ sessionId: string; repoName: string; type: "permission" | "question" | "plan_approval"; logoUrl?: string }[]> {
    const result: { sessionId: string; repoName: string; type: "permission" | "question" | "plan_approval"; logoUrl?: string }[] = [];
    for (const session of this.sessions.values()) {
      if (session.status !== "needs_input") continue;
      const logoUrl = await this.getSessionLogoUrl(session.id);
      if (session.pendingPlanApproval) {
        result.push({ sessionId: session.id, repoName: session.repoName, type: "plan_approval", logoUrl });
      } else if (session.pendingPermissions.size > 0) {
        result.push({ sessionId: session.id, repoName: session.repoName, type: "permission", logoUrl });
      } else if (session.pendingQuestions.length > 0) {
        result.push({ sessionId: session.id, repoName: session.repoName, type: "question", logoUrl });
      }
    }
    return result;
  }

  async getSessionLogoUrl(sessionId: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // Check if we already have a logoUrl for this session
    if (session.logoUrl) return session.logoUrl;

    // Look up in launchable repos
    const repo = this.launchableRepos.find((r) => r.path === session.cwd);
    if (repo?.logoUrl) {
      session.logoUrl = repo.logoUrl;
      return repo.logoUrl;
    }

    // Check directly if logo.png exists
    try {
      const logoFile = Bun.file(join(session.cwd, "logo.png"));
      if (await logoFile.exists()) {
        const logoUrl = `/static/logo/${session.repoName}`;
        session.logoUrl = logoUrl;
        return logoUrl;
      }
    } catch {
      // No logo.png found
    }

    return undefined;
  }

  getRecentMessages(sessionId: string, count = 50): AgentMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages.slice(-count);
  }

  // --- Stream Consumer ---

  private async consumeStream(sessionId: string, q: Query): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      for await (const msg of q) {
        const s = this.sessions.get(sessionId);
        if (!s) break;

        await this.handleSDKMessage(sessionId, s, msg);
      }

      // Generator ended without a result message (SDK stream closed prematurely,
      // e.g. due to setModel restarting the underlying query or a network drop).
      // Ensure the session is not left stuck in streaming state.
      const s = this.sessions.get(sessionId);
      if (s && (s.status === "streaming" || s.status === "starting")) {
        s.status = "idle";
        s.turnStartedAt = undefined;
        s.hooksRunning = false;
        this.persistSession(sessionId, true);
        this.onSessionChange(this.getSessions());
      }
    } catch (err: unknown) {
      const s = this.sessions.get(sessionId);
      if (s && s.status !== "stopped") {
        s.status = "error";
        const errorMsg: AgentMessage = {
          id: crypto.randomUUID(),
          type: "result",
          timestamp: new Date(),
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
        s.messages.push(errorMsg);
        this.persistSession(sessionId, true);
        this.onMessage(errorMsg, s);
        this.onSessionChange(this.getSessions());
      }
    } finally {
      this.queries.delete(sessionId);
      this.abortControllers.delete(sessionId);
    }
  }

  private async handleSDKMessage(sessionId: string, session: AgentSession, msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          session.sdkSessionId = msg.session_id;
          session.status = "streaming";
          const initModel = (msg as SDKSystemInitMessage).model;
          // Accept whatever model the SDK resolved (may include version suffix)
          session.model = initModel ?? session.model;
          this.persistSession(sessionId, true);
          this.onSessionChange(this.getSessions());
        } else if (msg.subtype === "hook_started" && (msg as SDKSystemHookMessage).hook_event === "Stop") {
          // Stop hooks only run after the model's turn is complete — use it to
          // set status to idle immediately rather than waiting for the result message.
          if (session.status === "streaming" || session.status === "starting") {
            session.status = "idle";
            session.turnStartedAt = undefined;
          }
          session.hooksRunning = true;
          this.persistSession(sessionId, true);
          this.onSessionChange(this.getSessions());
          this.onMessage({
            id: `hook-status-${sessionId}`,
            type: "system",
            timestamp: new Date(),
            hookStatus: "running",
          }, session);
        }
        break;
      }

      case "assistant": {
        session.status = "streaming";
        session.lastActivity = new Date();

        const betaMsg = msg.message;
        const contentBlocks: ContentBlock[] = [];
        let text = "";

        if (Array.isArray(betaMsg.content)) {
          // First pass: collect all tool_uses into a lookup map
          const toolUseMap = new Map<string, string>();
          for (const block of betaMsg.content) {
            if (block.type === "tool_use") {
              toolUseMap.set(block.id, block.name);
            }
          }

          // Second pass: build contentBlocks
          for (const block of betaMsg.content) {
            switch (block.type) {
              case "text":
                contentBlocks.push({ type: "text", text: block.text });
                text += block.text;
                break;
              case "thinking":
                contentBlocks.push({ type: "thinking", text: (block as SDKThinkingBlock).thinking });
                break;
              case "tool_use":
                contentBlocks.push({
                  type: "tool_use",
                  toolName: block.name,
                  toolInput: block.input,
                  toolUseId: block.id,
                });
                break;
              case "tool_result": {
                const toolResultBlock = block as SDKToolResultBlock;
                const toolUseId = toolResultBlock.tool_use_id;
                contentBlocks.push({
                  type: "tool_result",
                  content: typeof toolResultBlock.content === "string"
                    ? toolResultBlock.content
                    : JSON.stringify(toolResultBlock.content),
                  toolUseId,
                  toolName: toolUseMap.get(toolUseId),
                  isError: toolResultBlock.is_error,
                });
                break;
              }
            }
          }
        }

        const usage = betaMsg.usage;
        if (usage) {
          session.inputTokens += usage.input_tokens ?? 0;
          session.outputTokens += usage.output_tokens ?? 0;
        }

        if (text.trim()) {
          session.lastMessagePreview = text.slice(0, 80);
        }

        if (betaMsg.stop_reason === "end_turn") {
          session.status = "idle";
        }

        const agentMsg: AgentMessage = {
          id: msg.uuid ?? crypto.randomUUID(),
          type: "assistant",
          timestamp: new Date(),
          contentBlocks,
          text: text.trim(),
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
        };

        session.messages.push(agentMsg);
        session.messages = trimMessageWindow(session.messages);
        this.persistSession(sessionId);
        this.onMessage(agentMsg, session);
        this.onSessionChange(this.getSessions());
        break;
      }

      case "result": {
        session.lastActivity = new Date();
        session.turnStartedAt = undefined;

        if (session.hooksRunning) {
          session.hooksRunning = false;
          this.onMessage({
            id: `hook-status-${sessionId}`,
            type: "system",
            timestamp: new Date(),
            hookStatus: "done",
          }, session);
        }

        if (msg.subtype === "success") {
          session.status = "idle";
          session.totalCostUsd = msg.total_cost_usd ?? session.totalCostUsd;
          session.turnCount = msg.num_turns ?? session.turnCount;

          const agentMsg: AgentMessage = {
            id: msg.uuid ?? crypto.randomUUID(),
            type: "result",
            timestamp: new Date(),
            text: msg.result,
            durationMs: msg.duration_ms,
            costUsd: msg.total_cost_usd,
            numTurns: msg.num_turns,
            isError: false,
          };
          session.messages.push(agentMsg);
          session.messages = trimMessageWindow(session.messages);
          this.persistSession(sessionId, true);
          this.onMessage(agentMsg, session);
        } else {
          session.status = "error";
          const agentMsg: AgentMessage = {
            id: msg.uuid ?? crypto.randomUUID(),
            type: "result",
            timestamp: new Date(),
            text: (msg as SDKResultErrorMessage).error ?? "Agent ended with error",
            isError: true,
          };
          session.messages.push(agentMsg);
          session.messages = trimMessageWindow(session.messages);
          this.persistSession(sessionId, true);
          this.onMessage(agentMsg, session);
        }

        this.onSessionChange(this.getSessions());
        await this.scanLaunchableRepos();
        this.onSessionChange(this.getSessions());
        break;
      }

      default: {
        session.lastActivity = new Date();
        const now = Date.now();
        const lastBroadcast = this.lastBroadcast.get(sessionId) ?? 0;
        if (now - lastBroadcast > 5000) {
          this.lastBroadcast.set(sessionId, now);
          this.onSessionChange(this.getSessions());
        }
        break;
      }
    }
  }

  // --- Permission Handler ---

  private handleCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    suggestions?: PermissionUpdate[],
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve({ behavior: "deny", message: "Session not found" });
    }

    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestion(session, input, toolUseId);
    }

    if (toolName === "ExitPlanMode") {
      return this.handleExitPlanMode(session, input, toolUseId, suggestions);
    }

    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (result: { behavior: "allow" } | { behavior: "deny"; message: string }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        if (settled) return;
        session.pendingPermissions.delete(toolUseId);

        // Only change status if no more pending permissions/questions/plan approvals
        if (session.pendingPermissions.size === 0 && session.pendingQuestions.length === 0 && !session.pendingPlanApproval) {
          session.status = "streaming";
        }

        // Update the inline permission message to show timed out state
        const permMsg = session.messages.find(m => m.id === `perm-${toolUseId}`);
        if (permMsg?.permissionData) {
          permMsg.permissionData.resolved = "timed_out";
          this.onMessage(permMsg, session);
        }
        this.onSessionChange(this.getSessions());

        safeResolve({ behavior: "deny", message: "Permission timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS);

      session.pendingPermissions.set(toolUseId, {
        toolUseId,
        toolName,
        toolInput: input,
        resolve: safeResolve,
        timeoutId,
      });
      session.status = "needs_input";
      this.onSessionChange(this.getSessions());

      // Emit permission request as an inline message with deterministic ID
      const permMsg: AgentMessage = {
        id: `perm-${toolUseId}`,
        type: "system",
        timestamp: new Date(),
        text: `Permission requested: ${toolName}`,
        sessionId,
        permissionData: { toolName, toolInput: input, toolUseId },
      };
      session.messages.push(permMsg);
      session.messages = trimMessageWindow(session.messages);
      this.onMessage(permMsg, session);
    });
  }

  // --- Question Handler ---

  private handleAskUserQuestion(
    session: AgentSession,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<PermissionResult> {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
    const questions: QuestionItem[] = rawQuestions.map((q: any) => ({
      question: String(q.question ?? ""),
      header: String(q.header ?? ""),
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => ({
            label: String(o.label ?? ""),
            description: o.description ? String(o.description) : undefined,
          }))
        : [],
      multiSelect: Boolean(q.multiSelect),
    }));

    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (result: PermissionResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const firstQuestion = questions[0]?.question ?? "Question";

      const timeoutId = setTimeout(() => {
        if (settled) return;
        // Find and remove this question from the pending array
        const idx = session.pendingQuestions.findIndex(q => q.toolUseId === toolUseId);
        if (idx !== -1) {
          session.pendingQuestions.splice(idx, 1);
        }
        if (session.pendingPermissions.size === 0 && session.pendingQuestions.length === 0 && !session.pendingPlanApproval) {
          session.status = "streaming";
        }

        // Update the inline question message to show timed out state
        const qMsg = session.messages.find(m => m.id === `q-${toolUseId}`);
        if (qMsg?.questionData) {
          qMsg.questionData.resolved = "timed_out";
          this.onMessage(qMsg, session);
        }
        this.onSessionChange(this.getSessions());

        safeResolve({ behavior: "deny", message: "Question timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS);

      session.pendingQuestions.push({
        toolUseId,
        questions,
        originalInput: input,
        resolve: safeResolve,
        timeoutId,
      });
      session.status = "needs_input";
      this.onSessionChange(this.getSessions());

      // Emit question as an inline message with deterministic ID
      const qMsg: AgentMessage = {
        id: `q-${toolUseId}`,
        type: "system",
        timestamp: new Date(),
        text: `Question asked: ${firstQuestion}`,
        sessionId: session.id,
        questionData: { questions, originalInput: input },
      };
      session.messages.push(qMsg);
      session.messages = trimMessageWindow(session.messages);
      this.onMessage(qMsg, session);
    });
  }

  // --- Plan Approval Handler ---

  private handleExitPlanMode(
    session: AgentSession,
    input: Record<string, unknown>,
    toolUseId: string,
    suggestions?: PermissionUpdate[],
  ): Promise<PermissionResult> {
    const rawPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];
    const allowedPrompts = rawPrompts.map((p: any) => ({
      tool: "Bash" as const,
      prompt: String(p.prompt ?? ""),
    }));
    const planContent = typeof input.plan === "string" ? input.plan : undefined;

    return new Promise((resolve) => {
      let settled = false;
      const safeResolve = (result: PermissionResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        if (settled) return;
        session.pendingPlanApproval = null;
        if (session.pendingPermissions.size === 0 && session.pendingQuestions.length === 0) {
          session.status = "streaming";
        }

        const planMsg = session.messages.find(m => m.id === `plan-${toolUseId}`);
        if (planMsg?.planApprovalData) {
          planMsg.planApprovalData.resolved = "timed_out";
          this.onMessage(planMsg, session);
        }
        this.onSessionChange(this.getSessions());

        safeResolve({ behavior: "deny", message: "Plan approval timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS);

      // Resolve any existing plan approval before setting a new one
      if (session.pendingPlanApproval) {
        clearTimeout(session.pendingPlanApproval.timeoutId);
        session.pendingPlanApproval.resolve({ behavior: "deny", message: "Superseded by new plan approval" });
      }

      session.pendingPlanApproval = {
        toolUseId,
        allowedPrompts,
        originalInput: input,
        suggestions,
        resolve: safeResolve,
        timeoutId,
      };
      session.status = "needs_input";
      this.onSessionChange(this.getSessions());

      const planMsg: AgentMessage = {
        id: `plan-${toolUseId}`,
        type: "system",
        timestamp: new Date(),
        text: "Plan ready for review",
        sessionId: session.id,
        planApprovalData: { allowedPrompts, toolUseId, planContent },
      };
      session.messages.push(planMsg);
      session.messages = trimMessageWindow(session.messages);
      this.onMessage(planMsg, session);
    });
  }

  // --- Repo Scanning ---

  async scanLaunchableRepos(): Promise<void> {
    try {
      const reposDir = await getReposDir();
      const entries = await readdir(reposDir, { withFileTypes: true });
      const activeCwds = new Set(
        Array.from(this.sessions.values()).map((s) => s.cwd)
      );

      const repos: LaunchableRepo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const repoPath = join(reposDir, entry.name);
        if (activeCwds.has(repoPath)) continue;
        try {
          await stat(join(repoPath, ".git"));
        } catch {
          continue;
        }
        try {
          await stat(join(repoPath, ARCHIVED_MARKER));
          continue;
        } catch {}

        // Check for logo.png
        let logoUrl: string | undefined;
        try {
          const logoPath = join(repoPath, "logo.png");
          await stat(logoPath);
          // Use a path that can be served statically
          logoUrl = `/static/logo/${entry.name}`;
        } catch {
          // No logo.png found
        }

        repos.push({ name: entry.name, path: repoPath, logoUrl });
      }

      await Promise.all(repos.map(async (r) => {
        r.gitStatus = await getRepoGitStatus(r.path);
      }));

      this.launchableRepos = repos.sort((a, b) => a.name.localeCompare(b.name));

      // Update cachedPendingCounts with launchable repos' git status
      for (const repo of this.launchableRepos) {
        if (repo.gitStatus && (
          repo.gitStatus.uncommitted > 0 ||
          repo.gitStatus.unpulled > 0 ||
          repo.gitStatus.unpushed > 0
        )) {
          this.cachedPendingCounts.set(repo.path, repo.gitStatus);
        } else {
          this.cachedPendingCounts.delete(repo.path);
        }
      }
    } catch {
      this.launchableRepos = [];
    }
  }

  async getRepoPendingCounts(): Promise<Map<string, RepoGitStatus>> {
    const counts = new Map<string, RepoGitStatus>();
    const uniqueCwds = new Set(
      Array.from(this.sessions.values()).map((s) => s.cwd)
    );
    await Promise.all(
      Array.from(uniqueCwds).map(async (cwd) => {
        const status = await getRepoGitStatus(cwd);
        if (status.uncommitted > 0 || status.unpulled > 0 || status.unpushed > 0) {
          counts.set(cwd, status);
        }
      })
    );
    this.cachedPendingCounts = counts;
    return counts;
  }
}
