import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
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
} from "./types.ts";
import {
  ensureDataDir,
  saveSession,
  loadAllSessions,
  deleteSessionFile,
} from "./persistence.ts";

// --- Constants ---

const REPOS_DIR = join(homedir(), "repos", "tsilva");
const ARCHIVED_MARKER = ".archived";
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

type MessageCallback = (msg: AgentMessage, session: AgentSession) => void;
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

  constructor(onMessage: MessageCallback, onSessionChange: SessionChangeCallback) {
    this.onMessage = onMessage;
    this.onSessionChange = onSessionChange;
    this.scanLaunchableRepos();
  }

  // --- Initialization ---

  async init(): Promise<void> {
    await ensureDataDir();
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

  createSession(cwd: string, model?: string, permissionMode?: PermissionMode): AgentSession {
    const id = crypto.randomUUID();
    const repoName = basename(cwd);

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
      model: model || "claude-opus-4-6",
      permissionMode: permissionMode || "default",
      pendingQuestion: null,
      pendingPlanApproval: null,
      pendingPermissions: new Map(),
      messages: [],
    };

    this.sessions.set(id, session);
    this.persistSession(id, true);
    this.onSessionChange(this.getSessions());

    return session;
  }

  async launch(cwd: string, prompt: string, model?: string, permissionMode?: PermissionMode): Promise<AgentSession> {
    const session = this.createSession(cwd, model, permissionMode);
    await this.scanLaunchableRepos();
    await this.sendMessage(session.id, prompt);
    return session;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    // Add user message
    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      timestamp: new Date(),
      userText: text,
      text,
    };
    session.messages.push(userMsg);
    session.lastMessagePreview = text.slice(0, 80);
    session.lastActivity = new Date();
    session.status = "streaming";
    this.persistSession(sessionId);
    this.onMessage(userMsg, session);
    this.onSessionChange(this.getSessions());

    // First message: start new query; follow-up: resume existing session
    const options: Record<string, unknown> = {
      cwd: session.cwd,
      model: session.model,
      abortController,
      permissionMode: session.permissionMode,
      settingSources: ['user', 'project', 'local'],
      canUseTool: (toolName: string, input: unknown, opts: { toolUseID: string; suggestions?: unknown[] }) => {
        console.log(`[DEBUG canUseTool] tool=${toolName} session=${sessionId}`);
        return this.handleCanUseTool(sessionId, toolName, input as Record<string, unknown>, opts.toolUseID, opts.suggestions as PermissionUpdate[] | undefined);
      },
    };
    if (session.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
    if (session.sdkSessionId) {
      options.resume = session.sdkSessionId;
    }

    const q = query({ prompt: text, options: options as any });

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

    clearTimeout(pending.timeoutId);

    // Update the inline permission message to show resolved state
    const permMsg = session.messages.find(m => m.id === `perm-${pending.toolUseId}`);
    if (permMsg?.permissionData) {
      permMsg.permissionData.resolved = allow ? "allowed" : "denied";
      this.onMessage(permMsg, session);
    }

    session.pendingPermissions.delete(pending.toolUseId);

    // Only transition to streaming if no more pending permissions/questions/plan approvals
    if (session.pendingPermissions.size === 0 && !session.pendingQuestion && !session.pendingPlanApproval) {
      session.status = "streaming";
    }
    this.onSessionChange(this.getSessions());

    if (allow) {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: message || "User denied permission" });
    }
  }

  answerQuestion(sessionId: string, answers: Record<string, string>): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingQuestion) return;

    const pending = session.pendingQuestion;
    clearTimeout(pending.timeoutId);

    // Update the inline question message to show answered state
    const answerText = Object.values(answers).filter(Boolean).join(", ");
    const qMsg = session.messages.find(m => m.id === `q-${pending.toolUseId}`);
    if (qMsg?.questionData) {
      qMsg.questionData.resolved = "answered";
      qMsg.questionData.answerSummary = answerText || "Answered";
      this.onMessage(qMsg, session);
    }

    session.pendingQuestion = null;
    session.status = "streaming";
    this.onSessionChange(this.getSessions());

    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.originalInput, answers },
    });
  }

  respondToPlanApproval(sessionId: string, accept: boolean, feedback?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingPlanApproval) return;

    const pending = session.pendingPlanApproval;
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
    session.status = "streaming";

    if (accept) {
      session.permissionMode = "default";
    }

    this.onSessionChange(this.getSessions());

    if (accept) {
      pending.resolve({ behavior: "allow", updatedPermissions: buildExitPlanPermissions(pending.suggestions) });
    } else {
      pending.resolve({ behavior: "deny", message: feedback || "User requested revision", interrupt: false });
    }
  }

  stopAgent(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

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

    session.status = "stopped";
    for (const perm of session.pendingPermissions.values()) {
      clearTimeout(perm.timeoutId);
    }
    session.pendingPermissions.clear();
    if (session.pendingQuestion) clearTimeout(session.pendingQuestion.timeoutId);
    session.pendingQuestion = null;
    if (session.pendingPlanApproval) clearTimeout(session.pendingPlanApproval.timeoutId);
    session.pendingPlanApproval = null;
    this.persistSession(sessionId, true);
    this.onSessionChange(this.getSessions());
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    session.permissionMode = mode;
    const q = this.queries.get(sessionId);
    if (q && typeof (q as any).setPermissionMode === "function") {
      await (q as any).setPermissionMode(mode);
    }
    this.persistSession(sessionId, true);
    this.onSessionChange(this.getSessions());
  }

  dismissSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    for (const perm of session.pendingPermissions.values()) {
      clearTimeout(perm.timeoutId);
    }
    session.pendingPermissions.clear();
    if (session.pendingQuestion) clearTimeout(session.pendingQuestion.timeoutId);
    if (session.pendingPlanApproval) clearTimeout(session.pendingPlanApproval.timeoutId);

    const controller = this.abortControllers.get(sessionId);
    if (controller) controller.abort();
    const q = this.queries.get(sessionId);
    if (q) q.close();

    deleteSessionFile(sessionId);
    this.sessions.delete(sessionId);
    this.queries.delete(sessionId);
    this.abortControllers.delete(sessionId);

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

  getSessionsNeedingAttention(): { sessionId: string; repoName: string; type: "permission" | "question" | "plan_approval" }[] {
    const result: { sessionId: string; repoName: string; type: "permission" | "question" | "plan_approval" }[] = [];
    for (const session of this.sessions.values()) {
      if (session.status !== "needs_input") continue;
      if (session.pendingPlanApproval) {
        result.push({ sessionId: session.id, repoName: session.repoName, type: "plan_approval" });
      } else if (session.pendingPermissions.size > 0) {
        result.push({ sessionId: session.id, repoName: session.repoName, type: "permission" });
      } else if (session.pendingQuestion) {
        result.push({ sessionId: session.id, repoName: session.repoName, type: "question" });
      }
    }
    return result;
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
          session.model = (msg as any).model ?? session.model;
          this.persistSession(sessionId, true);
          this.onSessionChange(this.getSessions());
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
          for (const block of betaMsg.content) {
            switch (block.type) {
              case "text":
                contentBlocks.push({ type: "text", text: block.text });
                text += block.text;
                break;
              case "thinking":
                contentBlocks.push({ type: "thinking", text: (block as any).thinking });
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
                const toolUseId = (block as any).tool_use_id;
                const matchingToolUse = contentBlocks.find(
                  (b) => b.type === "tool_use" && b.toolUseId === toolUseId
                );
                contentBlocks.push({
                  type: "tool_result",
                  content: typeof (block as any).content === "string"
                    ? (block as any).content
                    : JSON.stringify((block as any).content),
                  toolUseId,
                  toolName: matchingToolUse?.toolName,
                  isError: (block as any).is_error,
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
        this.persistSession(sessionId);
        this.onMessage(agentMsg, session);
        this.onSessionChange(this.getSessions());
        break;
      }

      case "result": {
        session.lastActivity = new Date();

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
          this.persistSession(sessionId, true);
          this.onMessage(agentMsg, session);
        } else {
          session.status = "error";
          const agentMsg: AgentMessage = {
            id: msg.uuid ?? crypto.randomUUID(),
            type: "result",
            timestamp: new Date(),
            text: (msg as any).error ?? "Agent ended with error",
            isError: true,
          };
          session.messages.push(agentMsg);
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
        if (session.pendingPermissions.size === 0 && !session.pendingQuestion && !session.pendingPlanApproval) {
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
      this.onMessage(permMsg, session);
    });
  }

  // --- Question Handler ---

  private handleAskUserQuestion(
    session: AgentSession,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<PermissionResult> {
    console.log(`[DEBUG handleAskUserQuestion] session=${session.id} questions=${JSON.stringify(input.questions).slice(0, 200)}`);
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
        session.pendingQuestion = null;
        session.status = "streaming";

        // Update the inline question message to show timed out state
        const qMsg = session.messages.find(m => m.id === `q-${toolUseId}`);
        if (qMsg?.questionData) {
          qMsg.questionData.resolved = "timed_out";
          this.onMessage(qMsg, session);
        }
        this.onSessionChange(this.getSessions());

        safeResolve({ behavior: "deny", message: "Question timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS);

      session.pendingQuestion = {
        toolUseId,
        questions,
        originalInput: input,
        resolve: safeResolve,
        timeoutId,
      };
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
      this.onMessage(qMsg, session);
      console.log(`[DEBUG handleAskUserQuestion] dispatched inline question message for session=${session.id}`);
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
        session.status = "streaming";

        const planMsg = session.messages.find(m => m.id === `plan-${toolUseId}`);
        if (planMsg?.planApprovalData) {
          planMsg.planApprovalData.resolved = "timed_out";
          this.onMessage(planMsg, session);
        }
        this.onSessionChange(this.getSessions());

        safeResolve({ behavior: "deny", message: "Plan approval timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS);

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
      this.onMessage(planMsg, session);
    });
  }

  // --- Repo Scanning ---

  async scanLaunchableRepos(): Promise<void> {
    try {
      const entries = await readdir(REPOS_DIR, { withFileTypes: true });
      const activeCwds = new Set(
        Array.from(this.sessions.values()).map((s) => s.cwd)
      );

      const repos: LaunchableRepo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const repoPath = join(REPOS_DIR, entry.name);
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
        repos.push({ name: entry.name, path: repoPath });
      }

      await Promise.all(repos.map(async (r) => {
        r.gitStatus = await getRepoGitStatus(r.path);
      }));

      this.launchableRepos = repos.sort((a, b) => a.name.localeCompare(b.name));
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
    return counts;
  }
}
