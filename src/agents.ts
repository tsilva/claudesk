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
  QuestionItem,
  PermissionResult,
  PermissionMode,
} from "./types.ts";

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

// --- AgentManager ---

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private queries = new Map<string, Query>();
  private abortControllers = new Map<string, AbortController>();
  private onMessage: MessageCallback;
  private onSessionChange: SessionChangeCallback;
  private launchableRepos: LaunchableRepo[] = [];
  private lastBroadcast = new Map<string, number>();

  constructor(onMessage: MessageCallback, onSessionChange: SessionChangeCallback) {
    this.onMessage = onMessage;
    this.onSessionChange = onSessionChange;
    this.scanLaunchableRepos();
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
      pendingPermission: null,
      messages: [],
    };

    this.sessions.set(id, session);
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
    this.onMessage(userMsg, session);
    this.onSessionChange(this.getSessions());

    // First message: start new query; follow-up: resume existing session
    const options: Record<string, unknown> = {
      cwd: session.cwd,
      model: session.model,
      abortController,
      permissionMode: session.permissionMode,
      settingSources: ['user', 'project', 'local'],
      canUseTool: (toolName: string, input: unknown, opts: { toolUseID: string }) => {
        console.log(`[DEBUG canUseTool] tool=${toolName} session=${sessionId}`);
        return this.handleCanUseTool(sessionId, toolName, input as Record<string, unknown>, opts.toolUseID);
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

  respondToPermission(sessionId: string, allow: boolean, message?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingPermission) return;

    const pending = session.pendingPermission;
    clearTimeout(pending.timeoutId);
    session.pendingPermission = null;
    session.status = "streaming";
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
    session.pendingQuestion = null;
    session.status = "streaming";

    // Show the user's answer in the conversation
    const answerText = Object.values(answers).filter(Boolean).join(", ");
    if (answerText) {
      const answerMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "user",
        timestamp: new Date(),
        text: answerText,
        userText: answerText,
      };
      session.messages.push(answerMsg);
      this.onMessage(answerMsg, session);
    }

    this.onSessionChange(this.getSessions());

    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.originalInput, answers },
    });
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
    if (session.pendingPermission) clearTimeout(session.pendingPermission.timeoutId);
    if (session.pendingQuestion) clearTimeout(session.pendingQuestion.timeoutId);
    session.pendingPermission = null;
    session.pendingQuestion = null;
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
    this.onSessionChange(this.getSessions());
  }

  dismissSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.pendingPermission) clearTimeout(session.pendingPermission.timeoutId);
    if (session.pendingQuestion) clearTimeout(session.pendingQuestion.timeoutId);

    const controller = this.abortControllers.get(sessionId);
    if (controller) controller.abort();
    const q = this.queries.get(sessionId);
    if (q) q.close();

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
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve({ behavior: "deny", message: "Session not found" });
    }

    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestion(session, input, toolUseId);
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
        session.pendingPermission = null;
        session.status = "streaming";

        const timeoutMsg: AgentMessage = {
          id: crypto.randomUUID(),
          type: "system",
          timestamp: new Date(),
          text: `Permission for ${toolName} auto-denied after 5 minute timeout`,
        };
        session.messages.push(timeoutMsg);
        this.onMessage(timeoutMsg, session);
        this.onSessionChange(this.getSessions());

        safeResolve({ behavior: "deny", message: "Permission timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS);

      session.pendingPermission = {
        toolUseId,
        toolName,
        toolInput: input,
        resolve: safeResolve,
        timeoutId,
      };
      session.status = "needs_input";
      this.onSessionChange(this.getSessions());

      // Emit permission request as a message so it shows in the UI
      const permMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "system",
        timestamp: new Date(),
        text: `Permission requested: ${toolName}`,
      };
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

        const timeoutMsg: AgentMessage = {
          id: crypto.randomUUID(),
          type: "system",
          timestamp: new Date(),
          text: `Question "${firstQuestion}" auto-denied after 5 minute timeout`,
        };
        session.messages.push(timeoutMsg);
        this.onMessage(timeoutMsg, session);
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

      const sysMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "system",
        timestamp: new Date(),
        text: `Question asked: ${firstQuestion}`,
      };
      this.onMessage(sysMsg, session);
      console.log(`[DEBUG handleAskUserQuestion] dispatched system message for session=${session.id}`);
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
