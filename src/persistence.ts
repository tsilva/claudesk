import { join } from "path";
import { readdir, unlink, mkdir } from "fs/promises";
import type {
  AgentSession,
  AgentMessage,
  PersistedSession,
  PersistedMessage,
} from "./types.ts";

const DATA_DIR = join(process.cwd(), ".claudesk", "sessions");

export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function serializeMessage(msg: AgentMessage): PersistedMessage {
  return {
    id: msg.id,
    type: msg.type,
    timestamp: msg.timestamp.toISOString(),
    contentBlocks: msg.contentBlocks,
    text: msg.text,
    userText: msg.userText,
    durationMs: msg.durationMs,
    costUsd: msg.costUsd,
    inputTokens: msg.inputTokens,
    outputTokens: msg.outputTokens,
    isError: msg.isError,
    numTurns: msg.numTurns,
    sessionId: msg.sessionId,
    permissionData: msg.permissionData,
    questionData: msg.questionData,
    planApprovalData: msg.planApprovalData,
  };
}

function deserializeMessage(data: PersistedMessage): AgentMessage {
  return {
    id: data.id,
    type: data.type,
    timestamp: new Date(data.timestamp),
    contentBlocks: data.contentBlocks,
    text: data.text,
    userText: data.userText,
    durationMs: data.durationMs,
    costUsd: data.costUsd,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    isError: data.isError,
    numTurns: data.numTurns,
    sessionId: data.sessionId,
    permissionData: data.permissionData,
    questionData: data.questionData,
    planApprovalData: data.planApprovalData,
  };
}

export function serializeSession(session: AgentSession): PersistedSession {
  return {
    id: session.id,
    sdkSessionId: session.sdkSessionId,
    repoName: session.repoName,
    cwd: session.cwd,
    status: session.status,
    lastMessagePreview: session.lastMessagePreview,
    lastActivity: session.lastActivity.toISOString(),
    createdAt: session.createdAt.toISOString(),
    gitBranch: session.gitBranch,
    totalCostUsd: session.totalCostUsd,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    turnCount: session.turnCount,
    model: session.model,
    preset: session.preset,
    permissionMode: session.permissionMode,
    messages: session.messages.map(serializeMessage),
  };
}

export function deserializeSession(data: PersistedSession): AgentSession {
  return {
    id: data.id,
    sdkSessionId: data.sdkSessionId,
    repoName: data.repoName,
    cwd: data.cwd,
    status: "idle",
    lastMessagePreview: data.lastMessagePreview,
    lastActivity: new Date(data.lastActivity),
    createdAt: new Date(data.createdAt),
    gitBranch: data.gitBranch,
    totalCostUsd: data.totalCostUsd,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    turnCount: data.turnCount,
    model: data.model,
    preset: data.preset,
    permissionMode: data.permissionMode,
    pendingPermissions: new Map(),
    pendingQuestion: null,
    pendingPlanApproval: null,
    messages: data.messages.map(deserializeMessage),
  };
}

export async function saveSession(session: AgentSession): Promise<void> {
  const data = serializeSession(session);
  const filePath = join(DATA_DIR, `${session.id}.json`);
  await Bun.write(filePath, JSON.stringify(data, null, 2));
}

export async function loadAllSessions(): Promise<AgentSession[]> {
  const sessions: AgentSession[] = [];
  let entries: string[];
  try {
    entries = await readdir(DATA_DIR);
  } catch {
    return sessions;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const filePath = join(DATA_DIR, entry);
      const file = Bun.file(filePath);
      const data: PersistedSession = await file.json();
      sessions.push(deserializeSession(data));
    } catch (err) {
      console.warn(`[persistence] skipping corrupt session file: ${entry}`, err);
    }
  }

  return sessions;
}

export async function deleteSessionFile(sessionId: string): Promise<void> {
  try {
    await unlink(join(DATA_DIR, `${sessionId}.json`));
  } catch {
    // File may not exist yet (session created but never persisted)
  }
}
