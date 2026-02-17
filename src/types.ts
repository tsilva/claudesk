// --- Agent Status ---

export type AgentStatus =
  | "starting"
  | "streaming"
  | "idle"
  | "needs_input"
  | "error"
  | "stopped";

// --- Content Blocks (reused from old sessions.ts) ---

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

// --- Agent Messages ---

export interface AgentMessage {
  id: string;
  type: "user" | "assistant" | "system" | "result";
  timestamp: Date;
  contentBlocks?: ContentBlock[];
  text?: string;
  userText?: string;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError?: boolean;
  numTurns?: number;
}

// --- Permission & Question handling ---

export interface PendingPermission {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (result: { behavior: "allow" } | { behavior: "deny"; message: string }) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export type PermissionResult = { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string };

export interface PendingQuestion {
  toolUseId: string;
  questions: QuestionItem[];
  originalInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// --- Permission Mode ---

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'delegate' | 'dontAsk';

// --- Agent Session ---

export interface AgentSession {
  id: string;
  sdkSessionId: string;
  repoName: string;
  cwd: string;
  status: AgentStatus;
  lastMessagePreview: string;
  lastActivity: Date;
  createdAt: Date;
  gitBranch: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  model: string;
  permissionMode: PermissionMode;
  pendingQuestion: PendingQuestion | null;
  pendingPermission: PendingPermission | null;
  messages: AgentMessage[];
}

// --- Git Status ---

export interface RepoGitStatus {
  uncommitted: number;
  unpulled: number;
  unpushed: number;
}

// --- Launchable Repos ---

export interface LaunchableRepo {
  name: string;
  path: string;
  gitStatus?: RepoGitStatus;
}
