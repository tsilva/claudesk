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
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  toolUseId: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  resolve: (answers: Record<string, string>) => void;
}

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
  pendingQuestion: PendingQuestion | null;
  pendingPermission: PendingPermission | null;
  messages: AgentMessage[];
}

// --- Launchable Repos ---

export interface LaunchableRepo {
  name: string;
  path: string;
}
