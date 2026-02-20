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

function serializeMessage(m: AgentMessage): PersistedMessage {
  const { hookStatus, rawRequest, rawResponse, ...rest } = m;
  return { ...rest, timestamp: m.timestamp.toISOString() };
}

function deserializeMessage(data: PersistedMessage): AgentMessage {
  return { ...data, timestamp: new Date(data.timestamp) };
}

export function serializeSession(session: AgentSession): PersistedSession {
  const { pendingPermissions, pendingQuestions, pendingPlanApproval, turnStartedAt, hooksRunning, messages, lastActivity, createdAt, ...rest } = session;
  return {
    ...rest,
    lastActivity: lastActivity.toISOString(),
    createdAt: createdAt.toISOString(),
    messages: messages.map(serializeMessage),
  };
}

export function deserializeSession(data: PersistedSession): AgentSession {
  // Preserve terminal statuses; reset transient ones to idle
  const transientStatuses = new Set(["streaming", "starting", "needs_input"]);
  const restoredStatus = transientStatuses.has(data.status) ? "idle" : (data.status ?? "idle");
  return {
    ...data,
    status: restoredStatus,
    lastActivity: new Date(data.lastActivity),
    createdAt: new Date(data.createdAt),
    pendingPermissions: new Map(),
    pendingQuestions: [],
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
