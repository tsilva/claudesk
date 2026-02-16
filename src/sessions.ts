import { watch, type FSWatcher } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";

// --- Types ---

export interface LockInfo {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: string;
  authToken: string;
  lockFile: string;
}

export type SessionStatus =
  | "streaming"
  | "idle"
  | "needs_permission"
  | "died";

export interface Session {
  id: string;
  slug: string;
  projectDir: string;
  workspaceFolder: string;
  repoName: string;
  ideName: string;
  jsonlPath: string;
  status: SessionStatus;
  lastMessagePreview: string;
  lastActivity: Date;
  gitBranch: string;
  totalTokens: number;
  turnCount: number;
  pid: number;
  lockFile: string;
  /** Registry file backing this session (if wrapper-detected), or empty */
  registryFile: string;
}

interface RegistryEntry {
  pid: number;
  cwd: string;
  startedAt: number;
  file: string; // filename e.g. "12345.json"
}

export interface LaunchableRepo {
  name: string;
  path: string;
}

export interface ParsedMessage {
  type: "user" | "assistant" | "progress" | "system" | "tool_use" | "tool_result" | "ignored";
  sessionId: string;
  uuid: string;
  timestamp: Date;
  slug?: string;
  gitBranch?: string;
  // For user/assistant
  text?: string;
  // For assistant with tool_use
  toolName?: string;
  toolInput?: string;
  // For progress
  progressType?: string;
  progressMessage?: string;
  // For system
  systemSubtype?: string;
  durationMs?: number;
  // Token usage from assistant messages
  inputTokens?: number;
  outputTokens?: number;
  // Content blocks for assistant messages
  contentBlocks?: ContentBlock[];
  // stop reason
  stopReason?: string | null;
}

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  // For tool_result
  content?: string;
  isError?: boolean;
}

// --- Constants ---

const CLAUDE_DIR = join(homedir(), ".claude");
const IDE_DIR = join(CLAUDE_DIR, "ide");
const SESSIONS_DIR = join(IDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const REPOS_DIR = join(homedir(), "repos", "tsilva");
const DISCOVERY_INTERVAL = 3000;
const TAIL_FALLBACK_INTERVAL = 500;
const PROGRESS_DEBOUNCE_MS = 200;
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000; // fallback: mtime window when no registry
const BIRTH_WINDOW_MS = 30_000; // match JSONL born within 30s of registry startedAt
// --- Helpers ---

function extractPort(lockFileName: string): number | null {
  const match = lockFileName.match(/^(\d+)\.lock$/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

async function getPortsWithEstablished(): Promise<Set<number>> {
  const proc = Bun.spawn(["netstat", "-an"], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    if (!line.includes("ESTABLISHED")) continue;
    // Match local address like 127.0.0.1.PORT
    const match = line.match(/127\.0\.0\.1\.(\d+)\s/);
    if (match?.[1]) ports.add(parseInt(match[1], 10));
  }
  return ports;
}

// --- Session Manager ---

type MessageCallback = (msg: ParsedMessage, session: Session) => void;
type SessionChangeCallback = (sessions: Session[]) => void;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private tailers = new Map<string, JsonlTailer>();
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: MessageCallback;
  private onSessionChange: SessionChangeCallback;
  private launchableRepos: LaunchableRepo[] = [];

  constructor(onMessage: MessageCallback, onSessionChange: SessionChangeCallback) {
    this.onMessage = onMessage;
    this.onSessionChange = onSessionChange;
  }

  start() {
    this.discover();
    this.discoveryTimer = setInterval(() => this.discover(), DISCOVERY_INTERVAL);
  }

  stop() {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    for (const tailer of this.tailers.values()) {
      tailer.stop();
    }
  }

  getSessions(): Session[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => a.slug.localeCompare(b.slug)
    );
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getLaunchableRepos(): LaunchableRepo[] {
    return this.launchableRepos;
  }

  private async discover() {
    try {
      const registry = await this.scanRegistry();
      const locks = await this.scanLockFiles();
      const validLocks = await this.validatePids(locks);
      const reachableLocks = await this.validateTransports(validLocks);
      const changed = await this.reconcileSessions(registry, reachableLocks);
      await this.scanLaunchableRepos();
      if (changed) {
        this.onSessionChange(this.getSessions());
      }
    } catch (err) {
      console.error("[discovery] error:", err);
    }
  }

  private async scanLockFiles(): Promise<LockInfo[]> {
    const locks: LockInfo[] = [];
    try {
      const files = await readdir(IDE_DIR);
      for (const file of files) {
        if (!file.endsWith(".lock")) continue;
        try {
          const content = await readFile(join(IDE_DIR, file), "utf-8");
          const data = JSON.parse(content);
          locks.push({ ...data, lockFile: file });
        } catch {
          // skip corrupt lock files
        }
      }
    } catch {
      // IDE dir may not exist
    }
    return locks;
  }

  private async validatePids(locks: LockInfo[]): Promise<LockInfo[]> {
    return locks.filter((lock) => {
      try {
        process.kill(lock.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }

  private async validateTransports(locks: LockInfo[]): Promise<LockInfo[]> {
    const activePorts = await getPortsWithEstablished();
    return locks.filter((lock) => {
      if (lock.transport !== "ws") return true;
      const port = extractPort(lock.lockFile);
      if (port === null) return true;
      return activePorts.has(port);
    });
  }

  private async scanRegistry(): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = [];
    try {
      const files = await readdir(SESSIONS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = await readFile(join(SESSIONS_DIR, file), "utf-8");
          const data = JSON.parse(content);
          // Validate PID is still alive
          try { process.kill(data.pid, 0); } catch { continue; }
          entries.push({ ...data, file });
        } catch {
          // skip corrupt/unreadable
        }
      }
    } catch {
      // sessions dir may not exist yet
    }
    return entries;
  }

  private async findJsonlForRegistry(
    entry: RegistryEntry,
    projectDir: string,
    claimedJsonls: Set<string>,
  ): Promise<string | null> {
    try {
      const files = await readdir(projectDir);
      const jsonls = files.filter((f) => f.endsWith(".jsonl"));
      if (jsonls.length === 0) return null;

      const candidates: { path: string; birthtime: number; mtime: number }[] = [];
      for (const file of jsonls) {
        const fullPath = join(projectDir, file);
        if (claimedJsonls.has(fullPath)) continue;
        try {
          const s = await stat(fullPath);
          candidates.push({ path: fullPath, birthtime: s.birthtimeMs, mtime: s.mtimeMs });
        } catch { /* skip */ }
      }
      if (candidates.length === 0) return null;

      // Primary: JSONL born AFTER process start (new conversation)
      // Only look forward — prevents matching old JSONLs from previous sessions
      const newJsonls = candidates
        .filter((c) => c.birthtime >= entry.startedAt - 2000) // 2s tolerance for clock jitter
        .sort((a, b) => a.birthtime - b.birthtime); // earliest first
      if (newJsonls.length > 0) return newJsonls[0]!.path;

      // Fallback: most recently modified JSONL modified after process start (resumed conversation)
      const resumed = candidates
        .filter((c) => c.mtime > entry.startedAt)
        .sort((a, b) => b.mtime - a.mtime);
      return resumed[0]?.path ?? null;
    } catch {
      return null;
    }
  }

  private async findNewerConversation(
    session: Session,
    entry: RegistryEntry,
    claimedJsonls: Set<string>,
  ): Promise<string | null> {
    try {
      const currentBirth = (await stat(session.jsonlPath)).birthtimeMs;
      const files = await readdir(session.projectDir);
      const jsonls = files.filter((f) => f.endsWith(".jsonl"));

      let newest: { path: string; birthtime: number } | null = null;
      for (const file of jsonls) {
        const fullPath = join(session.projectDir, file);
        if (fullPath === session.jsonlPath) continue;
        if (claimedJsonls.has(fullPath)) continue;
        try {
          const s = await stat(fullPath);
          // Must be born AFTER current JSONL AND after process start
          if (s.birthtimeMs > currentBirth && s.birthtimeMs >= entry.startedAt - 2000) {
            if (!newest || s.birthtimeMs > newest.birthtime) {
              newest = { path: fullPath, birthtime: s.birthtimeMs };
            }
          }
        } catch { /* skip */ }
      }
      return newest?.path ?? null;
    } catch {
      return null;
    }
  }

  private removeSession(id: string) {
    this.tailers.get(id)?.stop();
    this.tailers.delete(id);
    this.sessions.delete(id);
  }

  private async reconcileSessions(
    registry: RegistryEntry[],
    locks: LockInfo[],
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();

    // --- Phase 1: Registry-based sessions (authoritative start/stop) ---

    const activeRegistryFiles = new Set(registry.map((e) => e.file));
    const claimedJsonls = new Set<string>();

    // Keep existing registry-backed sessions that are still alive
    for (const session of this.sessions.values()) {
      if (session.registryFile && activeRegistryFiles.has(session.registryFile)) {
        claimedJsonls.add(session.jsonlPath);
      }
    }

    // Build lookup of existing sessions by registry file
    const sessionsByRegistry = new Map<string, Session>();
    for (const session of this.sessions.values()) {
      if (session.registryFile) sessionsByRegistry.set(session.registryFile, session);
    }

    for (const entry of registry) {
      const workspace = entry.cwd;
      const projectDir = this.workspaceToProjectDir(workspace);
      if (!projectDir) continue;

      const existing = sessionsByRegistry.get(entry.file);
      if (existing) {
        // Already tracking — check if a NEW conversation started in this same instance.
        // Only consider JSONLs born AFTER the current one (strict birthtime check,
        // no mtime fallback — prevents stealing other instances' unclaimed JSONLs).
        const newerJsonl = await this.findNewerConversation(existing, entry, claimedJsonls);
        if (newerJsonl) {
          claimedJsonls.delete(existing.jsonlPath);
          claimedJsonls.add(newerJsonl);
          this.removeSession(existing.id);

          const sessionId = basename(newerJsonl, ".jsonl");
          const lock = locks.find((l) => l.workspaceFolders[0] === workspace);
          const session: Session = {
            id: sessionId, slug: "", projectDir, workspaceFolder: workspace,
            repoName: this.extractRepoName(workspace),
            ideName: lock?.ideName ?? "Terminal",
            jsonlPath: newerJsonl, status: "idle", lastMessagePreview: "",
            lastActivity: new Date(), gitBranch: "",
            totalTokens: 0, turnCount: 0, pid: entry.pid,
            lockFile: lock?.lockFile ?? "", registryFile: entry.file,
          };
          this.sessions.set(sessionId, session);
          this.startTailing(session);
          changed = true;
        }
        continue;
      }

      // New registry entry — find its JSONL
      const jsonlPath = await this.findJsonlForRegistry(entry, projectDir, claimedJsonls);
      if (!jsonlPath) continue; // retry next cycle

      const sessionId = basename(jsonlPath, ".jsonl");
      claimedJsonls.add(jsonlPath);

      const lock = locks.find((l) => l.workspaceFolders[0] === workspace);
      const session: Session = {
        id: sessionId, slug: "", projectDir, workspaceFolder: workspace,
        repoName: this.extractRepoName(workspace),
        ideName: lock?.ideName ?? "Terminal",
        jsonlPath, status: "idle", lastMessagePreview: "",
        lastActivity: new Date(), gitBranch: "",
        totalTokens: 0, turnCount: 0, pid: entry.pid,
        lockFile: lock?.lockFile ?? "", registryFile: entry.file,
      };
      this.sessions.set(sessionId, session);
      this.startTailing(session);
      changed = true;
    }

    // --- Phase 2: Lock-based fallback (workspaces without any registry entries) ---

    const registryWorkspaces = new Set(registry.map((e) => e.cwd));
    const activeWorkspaces = new Set<string>();

    for (const lock of locks) {
      const workspace = lock.workspaceFolders[0];
      if (!workspace) continue;
      activeWorkspaces.add(workspace);

      // Skip workspaces that have registry entries (already handled above)
      if (registryWorkspaces.has(workspace)) continue;

      const projectDir = this.workspaceToProjectDir(workspace);
      if (!projectDir) continue;

      try {
        const files = await readdir(projectDir);
        const jsonls = files.filter((f) => f.endsWith(".jsonl"));

        for (const file of jsonls) {
          const fullPath = join(projectDir, file);
          if (claimedJsonls.has(fullPath)) continue;

          try {
            const s = await stat(fullPath);
            if (now - s.mtimeMs < ACTIVITY_WINDOW_MS) {
              const sessionId = basename(fullPath, ".jsonl");
              claimedJsonls.add(fullPath);
              const session: Session = {
                id: sessionId, slug: "", projectDir, workspaceFolder: workspace,
                repoName: this.extractRepoName(workspace),
                ideName: lock.ideName,
                jsonlPath: fullPath, status: "idle", lastMessagePreview: "",
                lastActivity: new Date(), gitBranch: "",
                totalTokens: 0, turnCount: 0, pid: lock.pid,
                lockFile: lock.lockFile, registryFile: "",
              };
              this.sessions.set(sessionId, session);
              this.startTailing(session);
              changed = true;
            }
          } catch { /* skip */ }
        }
      } catch { /* projectDir doesn't exist */ }
    }

    // --- Phase 3: Cleanup ---

    for (const [id, session] of this.sessions) {
      if (session.registryFile) {
        // Registry-backed: remove if registry file is gone
        if (!activeRegistryFiles.has(session.registryFile)) {
          this.removeSession(id);
          changed = true;
        }
      } else {
        // Lock-backed fallback: remove if workspace gone OR JSONL stale
        if (!activeWorkspaces.has(session.workspaceFolder)) {
          this.removeSession(id);
          changed = true;
        } else {
          try {
            const s = await stat(session.jsonlPath);
            if (now - s.mtimeMs >= ACTIVITY_WINDOW_MS) {
              this.removeSession(id);
              changed = true;
            }
          } catch {
            this.removeSession(id);
            changed = true;
          }
        }
      }
    }

    return changed;
  }

  private workspaceToProjectDir(workspace: string): string | null {
    // Convert /Users/tsilva/repos/tsilva/claudesk → -Users-tsilva-repos-tsilva-claudesk
    const encoded = workspace.replace(/\//g, "-").replace(/^-/, "-");
    const dir = join(PROJECTS_DIR, encoded);
    return dir;
  }

  private extractRepoName(workspace: string): string {
    return basename(workspace);
  }

  private startTailing(session: Session) {
    const tailer = new JsonlTailer(session.jsonlPath, (msg) => {
      this.handleMessage(session, msg);
    });
    this.tailers.set(session.id, tailer);
    tailer.start();
  }

  private handleMessage(session: Session, msg: ParsedMessage) {
    // Update session metadata from message
    if (msg.slug) session.slug = msg.slug;
    if (msg.gitBranch) session.gitBranch = msg.gitBranch;
    session.lastActivity = msg.timestamp;

    switch (msg.type) {
      case "user":
        session.status = "streaming";
        session.turnCount++;
        if (msg.text) {
          session.lastMessagePreview = msg.text.slice(0, 80);
        }
        break;

      case "assistant":
        session.status = "streaming";
        if (msg.outputTokens) session.totalTokens += msg.outputTokens;
        if (msg.inputTokens) session.totalTokens += msg.inputTokens;
        if (msg.text) {
          session.lastMessagePreview = msg.text.slice(0, 80);
        }
        if (msg.stopReason === "end_turn") {
          session.status = "idle";
        }
        break;

      case "progress":
        session.status = "streaming";
        break;

      case "system":
        if (msg.systemSubtype === "stop_hook_summary") {
          session.status = "idle";
        }
        break;

      case "tool_use":
        session.status = "streaming";
        if (msg.toolName) {
          session.lastMessagePreview = `Tool: ${msg.toolName}`;
        }
        break;

      default:
        break;
    }

    this.onMessage(msg, session);
  }

  setSessionStatus(sessionId: string, status: SessionStatus) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      this.onSessionChange(this.getSessions());
    }
  }

  async getRecentMessages(sessionId: string, count = 50): Promise<ParsedMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    try {
      const file = Bun.file(session.jsonlPath);
      const content = await file.text();
      const lines = content.split("\n").filter(Boolean);

      const parsed: ParsedMessage[] = [];
      for (const line of lines) {
        try {
          const raw = JSON.parse(line);
          const msg = parseRawMessage(raw);
          if (msg && msg.type !== "ignored" && msg.type !== "progress") {
            parsed.push(msg);
          }
        } catch {
          // skip
        }
      }

      return parsed.slice(-count);
    } catch {
      return [];
    }
  }

  private async scanLaunchableRepos() {
    try {
      const entries = await readdir(REPOS_DIR);
      const activeWorkspaces = new Set(
        Array.from(this.sessions.values()).map((s) => s.workspaceFolder)
      );

      this.launchableRepos = entries
        .map((name) => ({
          name,
          path: join(REPOS_DIR, name),
        }))
        .filter((repo) => !activeWorkspaces.has(repo.path));
    } catch {
      this.launchableRepos = [];
    }
  }
}

// --- JSONL Tailer ---

class JsonlTailer {
  private filePath: string;
  private callback: (msg: ParsedMessage) => void;
  private byteOffset = 0;
  private watcher: FSWatcher | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private progressDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressMsg: ParsedMessage | null = null;
  private initialLoadDone = false;
  private reading = false;

  constructor(filePath: string, callback: (msg: ParsedMessage) => void) {
    this.filePath = filePath;
    this.callback = callback;
  }

  async start() {
    // Initial load — read the whole file to build session state, but only emit last N messages
    await this.loadInitial();
    this.initialLoadDone = true;

    // Watch for changes
    try {
      this.watcher = watch(this.filePath, () => {
        this.readNewContent();
      });
    } catch {
      // fs.watch may fail on some systems
    }

    // Fallback polling
    this.fallbackTimer = setInterval(() => {
      this.readNewContent();
    }, TAIL_FALLBACK_INTERVAL);
  }

  stop() {
    this.watcher?.close();
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    if (this.progressDebounceTimer) clearTimeout(this.progressDebounceTimer);
  }

  private async loadInitial() {
    try {
      const file = Bun.file(this.filePath);
      const content = await file.text();
      this.byteOffset = Buffer.byteLength(content, "utf-8");

      const lines = content.split("\n").filter(Boolean);

      // Parse all lines to build state, but only emit last 50 non-progress messages
      const parsed: ParsedMessage[] = [];
      for (const line of lines) {
        const msg = this.parseLine(line);
        if (msg && msg.type !== "ignored") {
          parsed.push(msg);
        }
      }

      // Emit last 50 meaningful messages for initial display
      const recent = parsed.filter((m) => m.type !== "progress").slice(-50);
      for (const msg of recent) {
        this.callback(msg);
      }
    } catch {
      // File might not exist yet
    }
  }

  private async readNewContent() {
    if (this.reading) return;
    this.reading = true;
    try {
      const file = Bun.file(this.filePath);
      const size = file.size;
      if (size <= this.byteOffset) return;

      const content = await file.slice(this.byteOffset, size).text();
      this.byteOffset = size;

      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        const msg = this.parseLine(line);
        if (!msg || msg.type === "ignored") continue;

        if (msg.type === "progress") {
          this.debounceProgress(msg);
        } else {
          // Flush any pending progress before emitting non-progress
          this.flushProgress();
          this.callback(msg);
        }
      }
    } catch {
      // File read error — will retry on next poll
    } finally {
      this.reading = false;
    }
  }

  private debounceProgress(msg: ParsedMessage) {
    this.lastProgressMsg = msg;
    if (!this.progressDebounceTimer) {
      this.progressDebounceTimer = setTimeout(() => {
        this.flushProgress();
      }, PROGRESS_DEBOUNCE_MS);
    }
  }

  private flushProgress() {
    if (this.progressDebounceTimer) {
      clearTimeout(this.progressDebounceTimer);
      this.progressDebounceTimer = null;
    }
    if (this.lastProgressMsg) {
      this.callback(this.lastProgressMsg);
      this.lastProgressMsg = null;
    }
  }

  private parseLine(line: string): ParsedMessage | null {
    try {
      const raw = JSON.parse(line);
      return parseRawMessage(raw);
    } catch {
      return null;
    }
  }
}

// --- Shared JSONL parser (used by both tailer and on-demand reads) ---

function parseRawMessage(raw: Record<string, unknown>): ParsedMessage | null {
    const type = raw.type as string;
    const base = {
      sessionId: raw.sessionId as string ?? "",
      uuid: raw.uuid as string ?? "",
      timestamp: new Date(raw.timestamp as string ?? Date.now()),
      slug: raw.slug as string | undefined,
      gitBranch: raw.gitBranch as string | undefined,
    };

    switch (type) {
      case "user": {
        const message = raw.message as Record<string, unknown> | undefined;
        if (!message) return { ...base, type: "ignored" };

        // Skip meta/system user messages
        if (raw.isMeta) return { ...base, type: "ignored" };

        const content = message.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text)
            .join("\n");
        }

        // Skip command/system messages
        if (text.startsWith("<local-command") || text.startsWith("<command-name>")) {
          return { ...base, type: "ignored" };
        }

        return { ...base, type: "user", text };
      }

      case "assistant": {
        const message = raw.message as Record<string, unknown> | undefined;
        if (!message) return { ...base, type: "ignored" };

        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(content)) return { ...base, type: "ignored" };

        const usage = message.usage as Record<string, unknown> | undefined;
        const stopReason = message.stop_reason as string | null;

        const contentBlocks: ContentBlock[] = [];
        let text = "";

        for (const block of content) {
          switch (block.type) {
            case "text":
              contentBlocks.push({ type: "text", text: block.text as string });
              text += block.text as string;
              break;
            case "thinking":
              contentBlocks.push({ type: "thinking", text: block.thinking as string });
              break;
            case "tool_use":
              contentBlocks.push({
                type: "tool_use",
                toolName: block.name as string,
                toolInput: block.input,
                toolUseId: block.id as string,
              });
              break;
            case "tool_result":
              contentBlocks.push({
                type: "tool_result",
                content: typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
                toolUseId: block.tool_use_id as string,
                isError: block.is_error as boolean,
              });
              break;
          }
        }

        return {
          ...base,
          type: "assistant",
          text: text.trim(),
          contentBlocks,
          stopReason,
          inputTokens: usage?.input_tokens as number | undefined,
          outputTokens: usage?.output_tokens as number | undefined,
        };
      }

      case "progress": {
        const data = raw.data as Record<string, unknown> | undefined;
        if (!data) return { ...base, type: "ignored" };

        const progressType = data.type as string;
        let progressMessage = "";

        if (progressType === "agent_progress") {
          progressMessage = data.prompt as string ?? "";
        } else if (progressType === "bash_progress") {
          progressMessage = typeof data === "string" ? data : JSON.stringify(data);
        } else if (progressType === "hook_progress") {
          progressMessage = `Hook: ${data.hookEvent as string ?? ""}`;
        } else {
          progressMessage = data.message as string ?? "";
        }

        return { ...base, type: "progress", progressType, progressMessage };
      }

      case "system": {
        const subtype = raw.subtype as string ?? (raw as Record<string, unknown>).type as string;
        const durationMs = (raw as Record<string, unknown>).durationMs as number | undefined;
        return { ...base, type: "system", systemSubtype: subtype, durationMs };
      }

      case "file-history-snapshot":
        return { ...base, type: "ignored" };

      default:
        return { ...base, type: "ignored" };
    }
}
