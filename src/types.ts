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
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  // For image content blocks
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

// --- Attachments ---

export interface Attachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number; // bytes
  data: string; // base64 encoded
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
  sessionId?: string;
  hookStatus?: "running" | "done";
  permissionData?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    resolved?: "allowed" | "denied" | "timed_out";
  };
  questionData?: {
    questions: QuestionItem[];
    originalInput: Record<string, unknown>;
    resolved?: "answered" | "timed_out";
    answerSummary?: string;
  };
  planApprovalData?: {
    allowedPrompts: { tool: "Bash"; prompt: string }[];
    toolUseId: string;
    planContent?: string;
    resolved?: "accepted" | "revised" | "timed_out";
    reviseFeedback?: string;
  };
  attachments?: Attachment[];
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

export type PermissionResult = { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] } | { behavior: "deny"; message: string; interrupt?: boolean };

export interface PendingQuestion {
  toolUseId: string;
  questions: QuestionItem[];
  originalInput: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface PendingPlanApproval {
  toolUseId: string;
  allowedPrompts: { tool: "Bash"; prompt: string }[];
  originalInput: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// --- Permission Mode ---

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'delegate' | 'dontAsk';

export type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';

export type PermissionUpdate =
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow' | 'deny' | 'ask'; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow' | 'deny' | 'ask'; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow' | 'deny' | 'ask'; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination };

// --- Agent Session ---

export type ModelPreset = 'opus' | 'sonnet' | 'opus-plan';

export interface AgentSession {
  id: string;
  sdkSessionId: string;
  repoName: string;
  cwd: string;
  status: AgentStatus;
  lastMessagePreview: string;
  lastActivity: Date;
  turnStartedAt?: Date;
  createdAt: Date;
  gitBranch: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  model: string;
  preset?: ModelPreset;
  permissionMode: PermissionMode;
  hooksRunning?: boolean;
  pendingQuestion: PendingQuestion | null;
  pendingPlanApproval: PendingPlanApproval | null;
  pendingPermissions: Map<string, PendingPermission>;
  messages: AgentMessage[];
  logoUrl?: string;
}

// --- Git Status ---

export interface RepoGitStatus {
  uncommitted: number;
  unpulled: number;
  unpushed: number;
}

// --- Launchable Repos ---

// --- Persisted types (serializable to JSON) ---

export interface PersistedMessage {
  id: string;
  type: "user" | "assistant" | "system" | "result";
  timestamp: string; // ISO 8601
  contentBlocks?: ContentBlock[];
  text?: string;
  userText?: string;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError?: boolean;
  numTurns?: number;
  sessionId?: string;
  permissionData?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    resolved?: "allowed" | "denied" | "timed_out";
  };
  questionData?: {
    questions: QuestionItem[];
    originalInput: Record<string, unknown>;
    resolved?: "answered" | "timed_out";
    answerSummary?: string;
  };
  planApprovalData?: {
    allowedPrompts: { tool: "Bash"; prompt: string }[];
    toolUseId: string;
    planContent?: string;
    resolved?: "accepted" | "revised" | "timed_out";
    reviseFeedback?: string;
  };
  attachments?: Attachment[];
}

export interface PersistedSession {
  id: string;
  sdkSessionId: string;
  repoName: string;
  cwd: string;
  status: AgentStatus;
  lastMessagePreview: string;
  lastActivity: string; // ISO 8601
  createdAt: string; // ISO 8601
  gitBranch: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  model: string;
  preset?: ModelPreset;
  permissionMode: PermissionMode;
  messages: PersistedMessage[];
  logoUrl?: string;
}

// --- Launchable Repos ---

export interface LaunchableRepo {
  name: string;
  path: string;
  gitStatus?: RepoGitStatus;
  logoUrl?: string;
}
