import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createOpencodeClient,
  createOpencodeServer,
  type AssistantMessage as OpenCodeAssistantMessage,
  type Event as OpenCodeEvent,
  type GlobalEvent as OpenCodeGlobalEvent,
  type OpencodeClient,
  type Part as OpenCodePart,
  type Permission as OpenCodePermission,
  type Provider as OpenCodeProvider,
} from "@opencode-ai/sdk";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import type {
  AgentBackend,
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
import { getReposDir, isRepoBlacklisted } from "./config.ts";

// --- Constants ---

const ARCHIVED_MARKER = ".archived.md";
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MESSAGE_WINDOW_LIMIT = 100; // Maximum messages to keep in memory per session
const DEFAULT_CLAUDE_MODEL = "claude-opus-4-6";
const DEFAULT_OPENCODE_PROVIDER = "anthropic";
const DEFAULT_OPENCODE_MODEL = "claude-sonnet-4-5";

type OpencodeRuntime = {
  client: OpencodeClient;
  server: {
    url: string;
    close(): void;
  };
};

type ModelOption = {
  backend: AgentBackend;
  model: string;
  label: string;
  description: string;
  providerId?: string;
};

const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  {
    backend: "claude",
    model: "claude-opus-4-6",
    label: "Opus 4.6",
    description: "Powerful, direct Claude SDK session",
  },
  {
    backend: "claude",
    model: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Fast and capable for most work",
  },
  {
    backend: "claude",
    model: "claude-opus-4-5",
    label: "Opus 4.5",
    description: "Previous generation Opus model",
  },
  {
    backend: "claude",
    model: "claude-sonnet-4-5",
    label: "Sonnet 4.5",
    description: "Previous generation Sonnet model",
  },
  {
    backend: "claude",
    model: "claude-haiku-4-5-20251001",
    label: "Haiku",
    description: "Fastest Claude option for simple tasks",
  },
];

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
type SessionChangeCallback = (sessions: AgentSession[]) => void | Promise<void>;

function fireCallback(cb: () => void | Promise<void>, label: string): void {
  try {
    const result = cb();
    if (result instanceof Promise) {
      result.catch((err) => console.warn(`[${label}] callback error:`, err));
    }
  } catch (err) {
    console.warn(`[${label}] callback error:`, err);
  }
}

// --- Plan Mode Helpers ---

function buildExitPlanPermissions(suggestions?: PermissionUpdate[]): PermissionUpdate[] {
  const setModeDefault: PermissionUpdate = {
    type: 'setMode',
    mode: 'acceptEdits',
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
  private sdkSessionLookup = new Map<string, string>();
  private onMessage: MessageCallback;
  private onSessionChange: SessionChangeCallback;
  private launchableRepos: LaunchableRepo[] = [];
  private lastBroadcast = new Map<string, number>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cachedPendingCounts: Map<string, RepoGitStatus> = new Map();
  private opencodeRuntime: OpencodeRuntime | null = null;
  private opencodeRuntimePromise: Promise<OpencodeRuntime> | null = null;
  private opencodeEventLoop: Promise<void> | null = null;
  private opencodeParts = new Map<string, OpenCodePart[]>();
  private opencodeMessageRoles = new Map<string, string>();

  constructor(onMessage: MessageCallback, onSessionChange: SessionChangeCallback) {
    this.onMessage = onMessage;
    this.onSessionChange = onSessionChange;
  }

  private fireOnMessage(msg: AgentMessage, session: AgentSession): void {
    fireCallback(() => this.onMessage(msg, session), "onMessage");
  }

  private fireOnSessionChange(): void {
    fireCallback(() => this.onSessionChange(this.getSessions()), "onSessionChange");
  }

  private sdkLookupKey(backend: AgentBackend, sdkSessionId: string): string {
    return `${backend}:${sdkSessionId}`;
  }

  private setSdkSessionId(session: AgentSession, sdkSessionId: string): void {
    if (session.sdkSessionId) {
      this.sdkSessionLookup.delete(this.sdkLookupKey(session.backend, session.sdkSessionId));
    }
    session.sdkSessionId = sdkSessionId;
    this.sdkSessionLookup.set(this.sdkLookupKey(session.backend, sdkSessionId), session.id);
  }

  private getSessionBySdkSessionId(backend: AgentBackend, sdkSessionId: string): AgentSession | undefined {
    const sessionId = this.sdkSessionLookup.get(this.sdkLookupKey(backend, sdkSessionId));
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  private unwrapData<T>(value: T | { data: T }): T {
    if (value && typeof value === "object" && "data" in value) {
      return value.data;
    }
    return value;
  }

  // --- Initialization ---

  async init(): Promise<void> {
    await ensureDataDir();
    await this.scanLaunchableRepos();
    const restored = await loadAllSessions();
    for (const session of restored) {
      session.backend = session.backend ?? "claude";
      if (session.backend === "claude") {
        this.lastUsedSelection.claude = { model: session.model };
      } else {
        this.lastUsedSelection.opencode = {
          model: session.model || DEFAULT_OPENCODE_MODEL,
          providerId: session.modelProviderId || DEFAULT_OPENCODE_PROVIDER,
        };
      }
      this.sessions.set(session.id, session);
      if (session.sdkSessionId) {
        this.sdkSessionLookup.set(this.sdkLookupKey(session.backend, session.sdkSessionId), session.id);
      }
    }
    if (restored.length > 0) {
      console.log(`[persistence] restored ${restored.length} session(s)`);
      this.fireOnSessionChange();
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

  private lastUsedSelection: Record<AgentBackend, { model: string; providerId?: string }> = {
    claude: { model: DEFAULT_CLAUDE_MODEL },
    opencode: { model: DEFAULT_OPENCODE_MODEL, providerId: DEFAULT_OPENCODE_PROVIDER },
  };

  createSession(
    cwd: string,
    options?: {
      backend?: AgentBackend;
      model?: string;
      modelProviderId?: string;
      permissionMode?: PermissionMode;
      preset?: ModelPreset;
    },
  ): AgentSession {
    const id = crypto.randomUUID();
    const repoName = basename(cwd);
    const backend = options?.backend ?? "claude";
    const defaultSelection = this.lastUsedSelection[backend];
    const sessionModel = options?.model || defaultSelection.model;
    const modelProviderId = backend === "opencode"
      ? (options?.modelProviderId || defaultSelection.providerId || DEFAULT_OPENCODE_PROVIDER)
      : undefined;

    const session: AgentSession = {
      id,
      backend,
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
      modelProviderId,
      preset: options?.preset,
      permissionMode: options?.permissionMode || "plan",
      pendingQuestions: [],
      pendingPlanApproval: null,
      pendingPermissions: new Map(),
      messages: [],
    };

    this.sessions.set(id, session);
    this.persistSession(id, true);
    this.fireOnSessionChange();

    return session;
  }

  async launch(
    cwd: string,
    prompt: string,
    options?: {
      backend?: AgentBackend;
      model?: string;
      modelProviderId?: string;
      permissionMode?: PermissionMode;
      preset?: ModelPreset;
    },
  ): Promise<AgentSession> {
    const session = this.createSession(cwd, options);
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

    const userAttachments: import("./types.ts").Attachment[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        userAttachments.push({
          id: crypto.randomUUID(),
          name: att.name,
          type: att.type,
          size: att.size,
          data: att.data,
        });
      }
    }

    const hasVisualContent = attachments?.some((a) =>
      a.type.startsWith("image/") || a.type === "application/pdf"
    ) ?? false;
    if (session.backend === "opencode" && attachments && attachments.length > 0) {
      throw new Error("OpenCode sessions do not support file attachments yet");
    }

    const rawRequest = session.backend === "claude"
      ? (hasVisualContent ? {
        role: "user",
        content: [
          ...(text?.trim() ? [{ type: "text", text }] : []),
          ...(attachments?.filter((a) => a.type.startsWith("image/")).map((a) => ({
            type: "image",
            source: { type: "base64" as const, media_type: a.type, data: a.data },
          })) || []),
          ...(attachments?.filter((a) => a.type === "application/pdf").map((a) => ({
            type: "document",
            source: { type: "base64" as const, media_type: "application/pdf", data: a.data },
          })) || []),
        ],
      } : {
        role: "user",
        content: text || "",
      })
      : {
        backend: "opencode",
        parts: text?.trim() ? [{ type: "text", text }] : [],
      };

    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      timestamp: new Date(),
      userText: text,
      text,
      attachments: userAttachments,
      rawRequest,
    };
    this.pushMessage(session, userMsg);
    session.lastMessagePreview = text.slice(0, 80);
    session.lastActivity = new Date();
    session.turnStartedAt = session.lastActivity;
    session.status = "streaming";

    this.lastUsedSelection[session.backend] = {
      model: session.model,
      providerId: session.modelProviderId,
    };

    this.persistSession(sessionId);
    this.fireOnMessage(userMsg, session);
    this.fireOnSessionChange();
    try {
      if (session.backend === "claude") {
        this.sendClaudeMessage(sessionId, session, text, attachments, hasVisualContent);
      } else {
        await this.sendOpencodeMessage(sessionId, session, text);
      }
    } catch (err) {
      session.status = "error";
      session.turnStartedAt = undefined;
      const errorMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "result",
        timestamp: new Date(),
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
      this.pushMessage(session, errorMsg);
      this.persistSession(sessionId, true);
      this.fireOnMessage(errorMsg, session);
      this.fireOnSessionChange();
      throw err;
    }
  }

  private sendClaudeMessage(
    sessionId: string,
    session: AgentSession,
    text: string,
    attachments: { name: string; type: string; size: number; data: string }[] | undefined,
    hasVisualContent: boolean,
  ): void {
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

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const options: Record<string, unknown> = {
      cwd: session.cwd,
      model: session.model,
      abortController,
      permissionMode: session.permissionMode,
      env,
      settingSources: ["user", "project", "local"],
      canUseTool: (toolName: string, input: unknown, opts: { toolUseID: string; suggestions?: unknown[] }) => {
        return this.handleCanUseTool(
          sessionId,
          toolName,
          input as Record<string, unknown>,
          opts.toolUseID,
          opts.suggestions as PermissionUpdate[] | undefined,
        );
      },
    };
    if (session.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }
    if (session.sdkSessionId) {
      options.resume = session.sdkSessionId;
    }

    let prompt;
    if (hasVisualContent) {
      const imageAttachments = attachments!.filter((a) => a.type.startsWith("image/"));
      const pdfAttachments = attachments!.filter((a) => a.type === "application/pdf");
      const content: Array<{
        type: string;
        text?: string;
        source?: { type: string; media_type: string; data: string };
      }> = [];

      if (text?.trim()) {
        content.push({ type: "text", text });
      }

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
      prompt = text || "";
    }

    const q = query({ prompt, options });
    this.queries.set(sessionId, q);
    this.consumeStream(sessionId, q);
  }

  private async sendOpencodeMessage(sessionId: string, session: AgentSession, text: string): Promise<void> {
    const runtime = await this.ensureOpencodeRuntime();
    if (!session.sdkSessionId) {
      const createdResponse = await runtime.client.session.create({
        query: { directory: session.cwd },
        body: { title: session.repoName },
        responseStyle: "data",
        throwOnError: true,
      });
      const created = this.unwrapData(createdResponse);
      this.setSdkSessionId(session, created.id);
      session.lastActivity = new Date(created.time.updated);
      this.persistSession(sessionId, true);
    }

    await runtime.client.session.promptAsync({
      path: { id: session.sdkSessionId },
      query: { directory: session.cwd },
      body: {
        model: {
          providerID: session.modelProviderId || DEFAULT_OPENCODE_PROVIDER,
          modelID: session.model,
        },
        parts: text?.trim() ? [{ type: "text", text }] : [],
      },
      responseStyle: "data",
      throwOnError: true,
    });
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
      this.fireOnMessage(permMsg, session);
    }

    session.pendingPermissions.delete(pending.toolUseId);

    // Only transition to streaming if no more pending permissions/questions/plan approvals
    this.resumeIfNoPending(session);
    this.fireOnSessionChange();

    if (pending.backend === "opencode") {
      this.resolveOpencodePermission(session, pending.toolUseId, allow).catch((err) =>
        console.warn(`[opencode] permission reply failed:`, err)
      );
      return;
    }

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
      qMsg.questionData.answers = answers;
      this.fireOnMessage(qMsg, session);
    }

    // Remove this question from the pending array
    session.pendingQuestions.splice(pendingIndex, 1);

    // Only transition to streaming if no more pending permissions/questions/plan approvals
    this.resumeIfNoPending(session);
    this.fireOnSessionChange();

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
      this.fireOnMessage(planMsg, session);
    }

    session.pendingPlanApproval = null;

    if (accept) {
      session.permissionMode = "acceptEdits";
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

    this.fireOnSessionChange();

    if (accept) {
      // Set permission mode BEFORE resolving so the SDK processes the next tool with the correct mode
      const q = this.queries.get(sessionId);
      if (q && typeof q.setPermissionMode === "function") {
        await q.setPermissionMode("acceptEdits").catch((err: unknown) =>
          console.warn(`[plan-approval] setPermissionMode failed:`, err)
        );
      }
      pending.resolve({ behavior: "allow", updatedPermissions: buildExitPlanPermissions(pending.suggestions) });
    } else {
      pending.resolve({ behavior: "deny", message: feedback || "User requested revision", interrupt: false });
    }
  }

  private resolveAllPending(session: AgentSession, reason: string): void {
    for (const perm of session.pendingPermissions.values()) {
      clearTimeout(perm.timeoutId);
      perm.resolve({ behavior: "deny", message: reason });
    }
    session.pendingPermissions.clear();
    for (const q of session.pendingQuestions) {
      clearTimeout(q.timeoutId);
      q.resolve({ behavior: "deny", message: reason });
    }
    session.pendingQuestions = [];
    if (session.pendingPlanApproval) {
      clearTimeout(session.pendingPlanApproval.timeoutId);
      session.pendingPlanApproval.resolve({ behavior: "deny", message: reason });
      session.pendingPlanApproval = null;
    }
  }

  private pushMessage(session: AgentSession, msg: AgentMessage): void {
    session.messages.push(msg);
    session.messages = trimMessageWindow(session.messages);
  }

  private resumeIfNoPending(session: AgentSession): void {
    if (session.pendingPermissions.size === 0 && session.pendingQuestions.length === 0 && !session.pendingPlanApproval) {
      session.status = "streaming";
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

    if (session.backend === "opencode" && session.sdkSessionId) {
      this.abortOpencodeSession(session).catch((err) =>
        console.warn(`[opencode] abort failed:`, err)
      );
    }

    this.resolveAllPending(session, "Agent stopped");

    // Clear persist timers
    const timer = this.persistTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(sessionId);
    }

    this.persistSession(sessionId, true);
    this.fireOnSessionChange();
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    session.permissionMode = mode;
    const q = this.queries.get(sessionId);
    if (session.backend === "claude" && q && typeof q.setPermissionMode === "function") {
      await q.setPermissionMode(mode);
    }
    this.persistSession(sessionId, true);
    this.fireOnSessionChange();
  }

  setSessionModel(
    sessionId: string,
    options: { backend: AgentBackend; model: string; modelProviderId?: string },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    // Only allow changing model before first message is sent
    if (session.messages.length > 0) {
      throw new Error("Cannot change model after conversation has started");
    }
    session.backend = options.backend;
    session.model = options.model;
    session.modelProviderId = options.backend === "opencode"
      ? (options.modelProviderId || DEFAULT_OPENCODE_PROVIDER)
      : undefined;
    if (options.backend !== "claude") {
      session.preset = undefined;
    }
    this.lastUsedSelection[session.backend] = {
      model: session.model,
      providerId: session.modelProviderId,
    };
    this.persistSession(sessionId, true);
    this.fireOnSessionChange();
  }

  dismissSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.resolveAllPending(session, "Session dismissed");

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
    if (session.sdkSessionId) {
      this.sdkSessionLookup.delete(this.sdkLookupKey(session.backend, session.sdkSessionId));
    }

    this.fireOnSessionChange();
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

  async getAvailableModels(): Promise<{ claude: ModelOption[]; opencode: ModelOption[]; opencodeError?: string }> {
    const result: { claude: ModelOption[]; opencode: ModelOption[]; opencodeError?: string } = {
      claude: CLAUDE_MODEL_OPTIONS,
      opencode: [],
    };

    try {
      const runtime = await this.ensureOpencodeRuntime();
      const providersResponse = await runtime.client.config.providers({
        responseStyle: "data",
        throwOnError: true,
      });
      const providers = this.unwrapData(providersResponse);
      result.opencode = this.buildOpencodeModelOptions(providers.providers);
    } catch (err) {
      result.opencodeError = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  private buildOpencodeModelOptions(providers: OpenCodeProvider[]): ModelOption[] {
    const options: ModelOption[] = [];
    for (const provider of providers) {
      const models = Object.values(provider.models)
        .filter((model) => model.status !== "deprecated")
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const model of models) {
        options.push({
          backend: "opencode",
          providerId: provider.id,
          model: model.id,
          label: `${provider.name} / ${model.name}`,
          description: `OpenCode via ${provider.name}`,
        });
      }
    }
    return options;
  }

  private async ensureOpencodeRuntime(): Promise<OpencodeRuntime> {
    if (this.opencodeRuntime) {
      return this.opencodeRuntime;
    }
    if (this.opencodeRuntimePromise) {
      return this.opencodeRuntimePromise;
    }

    this.opencodeRuntimePromise = (async () => {
      // Use an ephemeral port so dev reloads don't collide with a stale local server.
      const server = await createOpencodeServer({ port: 0 });
      const client = createOpencodeClient({ baseUrl: server.url });
      const runtime: OpencodeRuntime = { client, server };
      const { stream } = await client.global.event({
        responseStyle: "data",
        throwOnError: true,
      });

      this.opencodeRuntime = runtime;
      this.opencodeEventLoop = this.consumeOpencodeEvents(stream as AsyncGenerator<OpenCodeGlobalEvent, unknown, unknown>)
        .catch((err) => console.warn("[opencode] event stream failed:", err))
        .finally(() => {
          this.opencodeEventLoop = null;
        });
      return runtime;
    })().catch((err) => {
      this.opencodeRuntimePromise = null;
      this.opencodeRuntime = null;
      throw err;
    });

    return this.opencodeRuntimePromise;
  }

  private async consumeOpencodeEvents(stream: AsyncGenerator<OpenCodeGlobalEvent, unknown, unknown>): Promise<void> {
    for await (const event of stream) {
      if (!event?.payload) continue;
      await this.handleOpencodeEvent(event.payload);
    }
  }

  private async handleOpencodeEvent(event: OpenCodeEvent): Promise<void> {
    switch (event.type) {
      case "session.status": {
        const session = this.getSessionBySdkSessionId("opencode", event.properties.sessionID);
        if (!session) break;
        if (event.properties.status.type === "busy") {
          if (session.status !== "needs_input") {
            session.status = "streaming";
          }
        } else if (event.properties.status.type === "idle" && session.pendingPermissions.size === 0) {
          session.status = "idle";
          session.turnStartedAt = undefined;
        }
        this.persistSession(session.id);
        this.fireOnSessionChange();
        break;
      }

      case "session.idle": {
        const session = this.getSessionBySdkSessionId("opencode", event.properties.sessionID);
        if (!session) break;
        if (session.pendingPermissions.size === 0) {
          session.status = "idle";
          session.turnStartedAt = undefined;
        }
        this.persistSession(session.id);
        this.fireOnSessionChange();
        break;
      }

      case "session.updated": {
        const session = this.getSessionBySdkSessionId("opencode", event.properties.info.id);
        if (!session) break;
        session.lastActivity = new Date(event.properties.info.time.updated);
        this.persistSession(session.id);
        this.fireOnSessionChange();
        break;
      }

      case "message.updated": {
        this.opencodeMessageRoles.set(event.properties.info.id, event.properties.info.role);
        if (event.properties.info.role !== "assistant") {
          break;
        }
        const info = event.properties.info as OpenCodeAssistantMessage;
        const session = this.getSessionBySdkSessionId("opencode", info.sessionID);
        if (!session) break;
        this.upsertOpencodeAssistantMessage(session, info.id, info.time.created, info);
        if (info.time.completed || info.error) {
          this.upsertOpencodeResultMessage(session, info);
        }
        break;
      }

      case "message.part.updated": {
        const role = this.opencodeMessageRoles.get(event.properties.part.messageID);
        if (role !== "assistant") break;
        const session = this.getSessionBySdkSessionId("opencode", event.properties.part.sessionID);
        if (!session) break;
        const parts = this.opencodeParts.get(event.properties.part.messageID) ?? [];
        const existingIndex = parts.findIndex((part) => part.id === event.properties.part.id);
        if (existingIndex >= 0) {
          parts[existingIndex] = event.properties.part;
        } else {
          parts.push(event.properties.part);
        }
        this.opencodeParts.set(event.properties.part.messageID, parts);
        this.upsertOpencodeAssistantMessage(session, event.properties.part.messageID, Date.now());
        break;
      }

      case "permission.updated": {
        const session = this.getSessionBySdkSessionId("opencode", event.properties.sessionID);
        if (!session) break;
        this.applyOpencodePermissionUpdated(session, event.properties);
        break;
      }

      case "permission.replied": {
        const session = this.getSessionBySdkSessionId("opencode", event.properties.sessionID);
        if (!session) break;
        this.applyOpencodePermissionReplied(session, event.properties.permissionID, event.properties.response);
        break;
      }

      case "session.error": {
        if (!event.properties.sessionID) break;
        const session = this.getSessionBySdkSessionId("opencode", event.properties.sessionID);
        if (!session) break;
        session.status = "error";
        const errorMsg: AgentMessage = {
          id: crypto.randomUUID(),
          type: "result",
          timestamp: new Date(),
          text: `Error: ${event.properties.error?.data.message || "OpenCode session failed"}`,
          isError: true,
        };
        this.pushMessage(session, errorMsg);
        this.persistSession(session.id, true);
        this.fireOnMessage(errorMsg, session);
        this.fireOnSessionChange();
        break;
      }
    }
  }

  private applyOpencodePermissionUpdated(session: AgentSession, permission: OpenCodePermission): void {
    const existing = session.pendingPermissions.get(permission.id);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    const toolInput: Record<string, unknown> = {
      type: permission.type,
      pattern: permission.pattern,
      ...permission.metadata,
    };
    const timeoutId = setTimeout(() => {
      session.pendingPermissions.delete(permission.id);
      this.resumeIfNoPending(session);
      const permMsg = session.messages.find((m) => m.id === `perm-${permission.id}`);
      if (permMsg?.permissionData) {
        permMsg.permissionData.resolved = "timed_out";
        permMsg.uiAction = "replace";
        this.fireOnMessage(permMsg, session);
      }
      this.fireOnSessionChange();
    }, PERMISSION_TIMEOUT_MS);

    session.pendingPermissions.set(permission.id, {
      backend: "opencode",
      toolUseId: permission.id,
      toolName: permission.title || permission.type,
      toolInput,
      resolve: () => {},
      timeoutId,
    });
    session.status = "needs_input";

    const existingMsg = session.messages.find((m) => m.id === `perm-${permission.id}`);
    if (existingMsg?.permissionData) {
      existingMsg.timestamp = new Date(permission.time.created);
      existingMsg.permissionData.toolName = permission.title || permission.type;
      existingMsg.permissionData.toolInput = toolInput;
      existingMsg.uiAction = "replace";
      this.fireOnMessage(existingMsg, session);
    } else {
      const permMsg: AgentMessage = {
        id: `perm-${permission.id}`,
        type: "system",
        timestamp: new Date(permission.time.created),
        text: `Permission requested: ${permission.title || permission.type}`,
        sessionId: session.id,
        permissionData: {
          toolName: permission.title || permission.type,
          toolInput,
          toolUseId: permission.id,
        },
      };
      this.pushMessage(session, permMsg);
      this.fireOnMessage(permMsg, session);
    }

    this.persistSession(session.id);
    this.fireOnSessionChange();
  }

  private applyOpencodePermissionReplied(session: AgentSession, permissionId: string, response: string): void {
    const pending = session.pendingPermissions.get(permissionId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      session.pendingPermissions.delete(permissionId);
    }

    const permMsg = session.messages.find((m) => m.id === `perm-${permissionId}`);
    if (permMsg?.permissionData) {
      permMsg.permissionData.resolved = response === "reject" ? "denied" : "allowed";
      permMsg.uiAction = "replace";
      this.fireOnMessage(permMsg, session);
    }

    this.resumeIfNoPending(session);
    this.persistSession(session.id);
    this.fireOnSessionChange();
  }

  private upsertOpencodeAssistantMessage(
    session: AgentSession,
    messageId: string,
    createdAt: number,
    info?: OpenCodeAssistantMessage,
  ): void {
    const contentBlocks = this.buildOpencodeContentBlocks(messageId);
    const text = contentBlocks
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const rawResponse = {
      backend: "opencode",
      info,
      parts: this.opencodeParts.get(messageId) ?? [],
    };
    let agentMsg = session.messages.find((msg) => msg.id === messageId && msg.type === "assistant");
    if (!agentMsg) {
      agentMsg = {
        id: messageId,
        type: "assistant",
        timestamp: new Date(createdAt),
        contentBlocks,
        text,
        rawResponse,
      };
      this.pushMessage(session, agentMsg);
      this.persistSession(session.id);
      this.fireOnMessage(agentMsg, session);
    } else {
      agentMsg.timestamp = new Date(createdAt);
      agentMsg.contentBlocks = contentBlocks;
      agentMsg.text = text;
      agentMsg.rawResponse = rawResponse;
      agentMsg.uiAction = "replace";
      this.persistSession(session.id);
      this.fireOnMessage(agentMsg, session);
    }

    if (text) {
      session.lastMessagePreview = text.slice(0, 80);
    }
    if (info) {
      session.lastActivity = new Date(info.time.completed ?? info.time.created);
      if (!info.error && !session.pendingPermissions.size) {
        session.status = info.time.completed ? "idle" : "streaming";
      }
      if (info.modelID) {
        session.model = info.modelID;
      }
      if (info.providerID) {
        session.modelProviderId = info.providerID;
      }
    }
    this.fireOnSessionChange();
  }

  private buildOpencodeContentBlocks(messageId: string): ContentBlock[] {
    const parts = this.opencodeParts.get(messageId) ?? [];
    const blocks: ContentBlock[] = [];

    for (const part of parts) {
      switch (part.type) {
        case "text":
          blocks.push({ type: "text", text: part.text, partId: part.id });
          break;

        case "reasoning":
          blocks.push({ type: "thinking", text: part.text, partId: part.id });
          break;

        case "tool":
          blocks.push({
            type: "tool_use",
            toolName: part.tool,
            toolInput: part.state.input,
            toolUseId: part.callID,
            partId: `${part.id}:tool`,
          });
          if (part.state.status === "completed") {
            blocks.push({
              type: "tool_result",
              toolName: part.tool,
              toolUseId: part.callID,
              content: part.state.output,
              partId: `${part.id}:result`,
            });
          } else if (part.state.status === "error") {
            blocks.push({
              type: "tool_result",
              toolName: part.tool,
              toolUseId: part.callID,
              content: part.state.error,
              isError: true,
              partId: `${part.id}:result`,
            });
          }
          break;

        case "file":
          if (part.mime.startsWith("image/") && part.url.startsWith("data:") && part.url.includes(";base64,")) {
            const [, payload] = part.url.split(";base64,");
            if (payload) {
              blocks.push({
                type: "image",
                partId: part.id,
                source: {
                  type: "base64",
                  media_type: part.mime,
                  data: payload,
                },
              });
            }
          }
          break;

        case "patch":
          if (part.files.length > 0) {
            blocks.push({
              type: "tool_result",
              toolName: "Patch",
              content: `Updated files:\n${part.files.join("\n")}`,
              partId: part.id,
            });
          }
          break;
      }
    }

    return blocks;
  }

  private formatOpencodeErrorMessage(info: OpenCodeAssistantMessage): string {
    const error = info.error;
    if (!error) {
      return "OpenCode session failed";
    }
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data && typeof error.data.message === "string") {
      return error.data.message;
    }
    return error.name || "OpenCode session failed";
  }

  private upsertOpencodeResultMessage(session: AgentSession, info: OpenCodeAssistantMessage): void {
    const resultId = `result-${info.id}`;
    let resultMsg = session.messages.find((msg) => msg.id === resultId && msg.type === "result");
    const timestamp = new Date(info.time.completed ?? Date.now());
    const isError = Boolean(info.error);
    const resultText = isError ? this.formatOpencodeErrorMessage(info) : "Done";

    if (!resultMsg) {
      session.totalCostUsd += info.cost || 0;
      session.inputTokens += info.tokens.input || 0;
      session.outputTokens += info.tokens.output || 0;
      session.turnCount += 1;
      resultMsg = {
        id: resultId,
        type: "result",
        timestamp,
        durationMs: session.turnStartedAt
          ? Math.max(0, timestamp.getTime() - session.turnStartedAt.getTime())
          : undefined,
        costUsd: info.cost || 0,
        inputTokens: info.tokens.input || 0,
        outputTokens: info.tokens.output || 0,
        numTurns: 1,
        text: resultText,
        isError,
      };
      this.pushMessage(session, resultMsg);
    } else {
      resultMsg.timestamp = timestamp;
      resultMsg.text = resultText;
      resultMsg.isError = isError;
      resultMsg.uiAction = "replace";
    }

    session.status = isError ? "error" : (session.pendingPermissions.size > 0 ? "needs_input" : "idle");
    session.turnStartedAt = undefined;
    this.persistSession(session.id);
    this.fireOnMessage(resultMsg!, session);
    this.fireOnSessionChange();
  }

  private async resolveOpencodePermission(session: AgentSession, permissionId: string, allow: boolean): Promise<void> {
    const runtime = await this.ensureOpencodeRuntime();
    await runtime.client.postSessionIdPermissionsPermissionId({
      path: {
        id: session.sdkSessionId,
        permissionID: permissionId,
      },
      query: { directory: session.cwd },
      body: { response: allow ? "once" : "reject" },
      responseStyle: "data",
      throwOnError: true,
    });
  }

  private async abortOpencodeSession(session: AgentSession): Promise<void> {
    const runtime = await this.ensureOpencodeRuntime();
    await runtime.client.session.abort({
      path: { id: session.sdkSessionId },
      query: { directory: session.cwd },
      responseStyle: "data",
      throwOnError: true,
    });
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
        this.fireOnSessionChange();
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
        this.fireOnMessage(errorMsg, s);
        this.fireOnSessionChange();
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
          this.setSdkSessionId(session, msg.session_id);
          session.status = "streaming";
          const initModel = (msg as SDKSystemInitMessage).model;
          // Accept whatever model the SDK resolved (may include version suffix)
          session.model = initModel ?? session.model;
          this.persistSession(sessionId, true);
          this.fireOnSessionChange();
        } else if (msg.subtype === "hook_started" && (msg as SDKSystemHookMessage).hook_event === "Stop") {
          // Stop hooks only run after the model's turn is complete — use it to
          // set status to idle immediately rather than waiting for the result message.
          if (session.status === "streaming" || session.status === "starting") {
            session.status = "idle";
            session.turnStartedAt = undefined;
          }
          session.hooksRunning = true;
          this.persistSession(sessionId, true);
          this.fireOnSessionChange();
          this.fireOnMessage({
            id: `hook-status-${sessionId}`,
            type: "system",
            timestamp: new Date(),
            hookStatus: "running",
          }, session);
        }
        break;
      }

      case "assistant": {
        // Don't overwrite needs_input status — a permission/question may still be pending
        if (session.status !== "needs_input") {
          session.status = "streaming";
        }
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

        // Store raw response for raw mode
        const rawResponse = {
          id: msg.uuid,
          type: "message",
          role: "assistant",
          content: betaMsg.content,
          model: session.model,
          stop_reason: betaMsg.stop_reason,
          usage: betaMsg.usage,
        };

        const agentMsg: AgentMessage = {
          id: msg.uuid ?? crypto.randomUUID(),
          type: "assistant",
          timestamp: new Date(),
          contentBlocks,
          text: text.trim(),
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          rawResponse,
        };

        this.pushMessage(session, agentMsg);
        this.persistSession(sessionId);
        this.fireOnMessage(agentMsg, session);
        this.fireOnSessionChange();
        break;
      }

      case "result": {
        session.lastActivity = new Date();
        session.turnStartedAt = undefined;

        if (session.hooksRunning) {
          session.hooksRunning = false;
          this.fireOnMessage({
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
          this.pushMessage(session, agentMsg);
          this.persistSession(sessionId, true);
          this.fireOnMessage(agentMsg, session);
        } else {
          session.status = "error";
          const agentMsg: AgentMessage = {
            id: msg.uuid ?? crypto.randomUUID(),
            type: "result",
            timestamp: new Date(),
            text: (msg as SDKResultErrorMessage).error ?? "Agent ended with error",
            isError: true,
          };
          this.pushMessage(session, agentMsg);
          this.persistSession(sessionId, true);
          this.fireOnMessage(agentMsg, session);
        }

        this.fireOnSessionChange();
        await this.scanLaunchableRepos();
        this.fireOnSessionChange();
        break;
      }

      default: {
        session.lastActivity = new Date();
        const now = Date.now();
        const lastBroadcast = this.lastBroadcast.get(sessionId) ?? 0;
        if (now - lastBroadcast > 5000) {
          this.lastBroadcast.set(sessionId, now);
          this.fireOnSessionChange();
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
        this.resumeIfNoPending(session);

        // Update the inline permission message to show timed out state
        const permMsg = session.messages.find(m => m.id === `perm-${toolUseId}`);
        if (permMsg?.permissionData) {
          permMsg.permissionData.resolved = "timed_out";
          this.fireOnMessage(permMsg, session);
        }
        this.fireOnSessionChange();

        safeResolve({ behavior: "deny", message: "Permission timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS);

      session.pendingPermissions.set(toolUseId, {
        backend: "claude",
        toolUseId,
        toolName,
        toolInput: input,
        resolve: safeResolve,
        timeoutId,
      });
      session.status = "needs_input";
      this.fireOnSessionChange();

      // Emit permission request as an inline message with deterministic ID
      const permMsg: AgentMessage = {
        id: `perm-${toolUseId}`,
        type: "system",
        timestamp: new Date(),
        text: `Permission requested: ${toolName}`,
        sessionId,
        permissionData: { toolName, toolInput: input, toolUseId },
      };
      this.pushMessage(session, permMsg);
      this.fireOnMessage(permMsg, session);
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
        this.resumeIfNoPending(session);

        // Update the inline question message to show timed out state
        const qMsg = session.messages.find(m => m.id === `q-${toolUseId}`);
        if (qMsg?.questionData) {
          qMsg.questionData.resolved = "timed_out";
          this.fireOnMessage(qMsg, session);
        }
        this.fireOnSessionChange();

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
      this.fireOnSessionChange();

      // Emit question as an inline message with deterministic ID
      const qMsg: AgentMessage = {
        id: `q-${toolUseId}`,
        type: "system",
        timestamp: new Date(),
        text: `Question asked: ${firstQuestion}`,
        sessionId: session.id,
        questionData: { questions, originalInput: input },
      };
      this.pushMessage(session, qMsg);
      this.fireOnMessage(qMsg, session);
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
          this.fireOnMessage(planMsg, session);
        }
        this.fireOnSessionChange();

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
      this.fireOnSessionChange();

      const planMsg: AgentMessage = {
        id: `plan-${toolUseId}`,
        type: "system",
        timestamp: new Date(),
        text: "Plan ready for review",
        sessionId: session.id,
        planApprovalData: { allowedPrompts, toolUseId, planContent },
      };
      this.pushMessage(session, planMsg);
      this.fireOnMessage(planMsg, session);
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
        if (await isRepoBlacklisted(entry.name)) continue;
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
    const uniqueCwds = new Set(
      Array.from(this.sessions.values()).map((s) => s.cwd)
    );
    await Promise.all(
      Array.from(uniqueCwds).map(async (cwd) => {
        const status = await getRepoGitStatus(cwd);
        if (status.uncommitted > 0 || status.unpulled > 0 || status.unpushed > 0) {
          this.cachedPendingCounts.set(cwd, status);
        } else {
          this.cachedPendingCounts.delete(cwd);
        }
      })
    );
    return this.cachedPendingCounts;
  }
}
