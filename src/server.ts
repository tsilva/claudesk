import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { AgentManager } from "./agents.ts";
import type { AgentSession, AgentMessage } from "./types.ts";
import { renderLayout } from "./templates/layout.ts";
import { renderSidebar } from "./templates/sidebar.ts";
import { renderSessionDetail, renderEmptyDetail } from "./templates/session-detail.ts";
import { renderMessage, renderSessionStats, renderSessionHeaderStatus, renderTurnCompleteFooter } from "./templates/components.ts";

const PORT = parseInt(process.env.CLAUDESK_PORT || process.env.PORT || "3456", 10);

// --- SSE Client Tracking ---

interface SSEClient {
  id: string;
  sessionId: string | null;
  send: (event: string, data: string) => void;
  close: () => void;
}

const clients = new Map<string, SSEClient>();
let clientIdCounter = 0;

function broadcast(event: string, data: string, sessionFilter?: string) {
  for (const client of clients.values()) {
    if (sessionFilter && client.sessionId !== sessionFilter) continue;
    client.send(event, data);
  }
}

async function broadcastSidebar() {
  const sessions = agentManager.getSessions();
  const repos = agentManager.getLaunchableRepos();

  // Phase 1: immediate broadcast with cached counts (no git operations)
  const cached = agentManager.getCachedPendingCounts();
  for (const client of clients.values()) {
    client.send("sidebar", renderSidebar(sessions, repos, client.sessionId ?? undefined, cached));
  }

  // Phase 2: refresh git counts and send a follow-up only if anything changed
  const fresh = await agentManager.getRepoPendingCounts();
  let changed = cached.size !== fresh.size;
  if (!changed) {
    for (const [k, v] of fresh) {
      const c = cached.get(k);
      if (!c || c.uncommitted !== v.uncommitted || c.unpulled !== v.unpulled || c.unpushed !== v.unpushed) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  for (const client of clients.values()) {
    client.send("sidebar", renderSidebar(sessions, repos, client.sessionId ?? undefined, fresh));
  }
}

// --- Agent Manager ---

// Track previous session statuses for transition detection
const prevStatuses = new Map<string, string>();

const agentManager = new AgentManager(
  // onMessage callback
  (msg: AgentMessage, session: AgentSession) => {
    if (msg.permissionData || msg.questionData || msg.planApprovalData) {
      const html = renderMessage(msg);
      if (html) {
        if (msg.permissionData?.resolved || msg.questionData?.resolved || msg.planApprovalData?.resolved) {
          // Resolved: inject hx-swap-oob to replace existing element in-place
          const oobHtml = html.replace(/^<div /, '<div hx-swap-oob="true" ');
          broadcast("stream-append", oobHtml, session.id);
        } else {
          // Pending: prepend as new message
          broadcast("stream-append", html, session.id);
        }

        // Desktop notification for pending prompts
        if (!msg.permissionData?.resolved && !msg.questionData?.resolved && !msg.planApprovalData?.resolved) {
          const event = msg.planApprovalData ? "plan_approval" : msg.permissionData ? "permission" : "question";
          broadcast("notify", JSON.stringify({
            event,
            repoName: session.repoName,
            sessionId: session.id,
          }));
        }
      }
    } else if (msg.type === "result" && !msg.isError) {
      const footerHtml = renderTurnCompleteFooter(msg);
      broadcast("turn-complete", footerHtml, session.id);
    } else {
      const html = renderMessage(msg);
      if (html) {
        broadcast("stream-append", html, session.id);
      }
    }
    // Update stats on meaningful messages (sidebar is handled by onSessionChange)
    if (msg.type === "user" || msg.type === "assistant" || msg.type === "result") {
      const statsHtml = renderSessionStats(session);
      broadcast("session-stats", statsHtml, session.id);
    }
  },
  // onSessionChange callback
  (sessions: AgentSession[]) => {
    // Detect streaming/starting → idle transitions for completion notifications
    const activeSessionIds = new Set(sessions.map(s => s.id));
    for (const session of sessions) {
      const prev = prevStatuses.get(session.id);
      if ((prev === "streaming" || prev === "starting") && session.status === "idle") {
        broadcast("notify", JSON.stringify({
          event: "complete",
          repoName: session.repoName,
          sessionId: session.id,
        }));
      }
      prevStatuses.set(session.id, session.status);
    }
    // Clean up prevStatuses for dismissed sessions
    for (const id of prevStatuses.keys()) {
      if (!activeSessionIds.has(id)) prevStatuses.delete(id);
    }

    broadcastSidebar().catch((err) => console.warn("[broadcastSidebar] error:", err));
    // Update session header status for viewers of each session
    for (const client of clients.values()) {
      if (!client.sessionId) continue;
      const session = agentManager.getSession(client.sessionId);
      if (!session) continue;
      const html = renderSessionHeaderStatus(session);
      client.send("session-status", html);
    }
  }
);

// --- Hono App ---

const app = new Hono();

// Static files
app.use("/static/*", serveStatic({ root: "./" }));

// Full page
app.get("/", async (c) => {
  const sessions = agentManager.getSessions();
  const repos = agentManager.getLaunchableRepos();
  const pendingCounts = await agentManager.getRepoPendingCounts();
  const activeSession = sessions[0] ?? null;
  const messages = activeSession
    ? agentManager.getRecentMessages(activeSession.id)
    : [];
  return c.html(renderLayout(sessions, repos, activeSession, messages, pendingCounts));
});

// SSE endpoint
app.get("/events", (c) => {
  const sessionId = c.req.query("session") ?? null;

  return streamSSE(c, async (stream) => {
    const clientId = `client-${++clientIdCounter}`;

    let keepAlive: ReturnType<typeof setInterval> | null = null;

    function removeClient() {
      clients.delete(clientId);
      if (keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    }

    const client: SSEClient = {
      id: clientId,
      sessionId,
      send: (event, data) => {
        stream.writeSSE({ event, data }).catch(() => {
          removeClient();
        });
      },
      close: () => {
        removeClient();
      },
    };

    clients.set(clientId, client);

    // Push initial sidebar so client is never stale
    const sessions = agentManager.getSessions();
    const repos = agentManager.getLaunchableRepos();
    const pendingCounts = await agentManager.getRepoPendingCounts();
    const sidebarHtml = renderSidebar(sessions, repos, sessionId ?? undefined, pendingCounts);
    client.send("sidebar", sidebarHtml);

    // Replay pending notifications for sessions needing attention
    for (const pending of agentManager.getSessionsNeedingAttention()) {
      client.send("notify", JSON.stringify({
        event: pending.type,
        repoName: pending.repoName,
        sessionId: pending.sessionId,
      }));
    }

    // Keep-alive ping every 15s
    keepAlive = setInterval(() => {
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {
        removeClient();
      });
    }, 15000);

    stream.onAbort(() => {
      removeClient();
    });

    await new Promise(() => {});
  });
});

// Session detail fragment (HTMX swap)
app.get("/sessions/:id/detail", async (c) => {
  const id = c.req.param("id");
  const session = agentManager.getSession(id);
  if (!session) {
    const repoCount = agentManager.getLaunchableRepos().length;
    return c.html(renderEmptyDetail(repoCount));
  }
  const messages = agentManager.getRecentMessages(id);
  return c.html(renderSessionDetail(session, messages));
});

// Focus the editor window for a session's repo
app.post("/sessions/:id/focus", async (c) => {
  const id = c.req.param("id");
  const session = agentManager.getSession(id);
  if (!session) return c.json({ error: "not found" }, 404);

  // Try CLAUDESK_EDITOR env var, then common editors, then skip gracefully
  const editorCandidates = process.env.CLAUDESK_EDITOR
    ? [process.env.CLAUDESK_EDITOR]
    : ["cursor", "code"];

  for (const editor of editorCandidates) {
    try {
      const proc = Bun.spawn([editor, session.cwd], { stderr: "pipe" });
      await proc.exited;
      return c.json({ ok: true });
    } catch {
      // Try next candidate
    }
  }

  return c.json({ ok: true, skipped: true });
});

// Focus the claudesk browser window (via AeroSpace or fallback to open)
app.post("/api/focus-dashboard", async (c) => {
  const body = await c.req.json<{ sessionId?: string }>().catch(() => ({}));
  const sessionId = (body as any)?.sessionId;
  const BROWSER_APPS = [
    "safari", "google chrome", "arc", "firefox",
    "brave browser", "microsoft edge", "chromium", "orion",
  ];

  try {
    const proc = Bun.spawn([
      "aerospace", "list-windows", "--all",
      "--format", "%{window-id}|%{app-name}|%{window-title}|%{workspace}",
    ]);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = output.trim().split("\n").filter(Boolean);
    let match: { windowId: string; workspace: string } | null = null;

    for (const line of lines) {
      const [windowId, appName, windowTitle, workspace] = line.split("|");
      if (
        BROWSER_APPS.includes(appName.toLowerCase()) &&
        windowTitle.toLowerCase().includes("claudesk")
      ) {
        match = { windowId: windowId.trim(), workspace: workspace.trim() };
        break;
      }
    }

    if (match) {
      if (match.workspace) {
        const ws = Bun.spawn(["aerospace", "workspace", match.workspace]);
        await ws.exited;
      }
      const focus = Bun.spawn(["aerospace", "focus", "--window-id", match.windowId]);
      await focus.exited;
      return c.json({ ok: true, action: "focused" });
    }
  } catch {
    // AeroSpace not available, fall through to platform open
  }

  // Fallback: open in default browser (platform-appropriate)
  const url = sessionId
    ? `http://localhost:${PORT}/#session=${sessionId}`
    : `http://localhost:${PORT}/`;
  const openCmd = process.platform === "win32" ? "start"
    : process.platform === "darwin" ? "open"
    : "xdg-open";
  const open = Bun.spawn([openCmd, url]);
  await open.exited;
  return c.json({ ok: true, action: "opened" });
});

// Dismiss a session
app.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const found = agentManager.dismissSession(id);
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// --- Agent API ---

const VALID_PERMISSION_MODES = new Set([
  'default', 'acceptEdits', 'bypassPermissions', 'plan', 'delegate', 'dontAsk',
]);
const VALID_MODEL_IDS = new Set([
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  'claude-opus-4-5', 'claude-sonnet-4-5',
]);
const VALID_PRESETS = new Set(['opus', 'sonnet', 'opus-plan']);

// Create a new session (no prompt required)
app.post("/api/agents/launch", async (c) => {
  try {
    const body = await c.req.json<{ cwd: string; model?: string; permissionMode?: string; preset?: string }>();
    const { cwd, model, permissionMode, preset } = body;
    if (!cwd) return c.json({ error: "cwd required" }, 400);

    if (permissionMode && !VALID_PERMISSION_MODES.has(permissionMode)) {
      return c.json({ error: "invalid permissionMode" }, 400);
    }
    if (model && !VALID_MODEL_IDS.has(model)) {
      return c.json({ error: "invalid model" }, 400);
    }
    if (preset && !VALID_PRESETS.has(preset)) {
      return c.json({ error: "invalid preset" }, 400);
    }

    const session = agentManager.createSession(cwd, model, permissionMode as any, preset as any);
    return c.json({ ok: true, sessionId: session.id });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "launch failed" }, 500);
  }
});

// Send a follow-up message
app.post("/api/agents/:id/message", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ text: string }>();
    if (!body.text) return c.json({ error: "text required" }, 400);

    const session = agentManager.getSession(id);
    if (!session) return c.json({ error: "session not found" }, 404);

    await agentManager.sendMessage(id, body.text);
    return c.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "failed";
    if (msg.includes("busy") || msg.includes("stopped")) {
      return c.json({ error: msg }, 409);
    }
    return c.json({ error: msg }, 500);
  }
});

// Respond to a permission request
app.post("/api/agents/:id/permission", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ allow: boolean; message?: string; toolUseId?: string }>();

    agentManager.respondToPermission(id, body.allow, body.message, body.toolUseId);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
  }
});

// Answer a question
app.post("/api/agents/:id/answer", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ answers: Record<string, string> }>();

    agentManager.answerQuestion(id, body.answers);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
  }
});

// Respond to a plan approval
app.post("/api/agents/:id/plan-approval", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ accept: boolean; feedback?: string }>();

    agentManager.respondToPlanApproval(id, body.accept, body.feedback);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
  }
});

// Change permission mode
app.post("/api/agents/:id/mode", async (c) => {
  try {
    const id = c.req.param("id");
    const { mode } = await c.req.json<{ mode: string }>();

    if (!VALID_PERMISSION_MODES.has(mode)) {
      return c.json({ error: "invalid mode" }, 400);
    }
    const session = agentManager.getSession(id);
    if (!session) return c.json({ error: "session not found" }, 404);

    await agentManager.setPermissionMode(id, mode as any);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
  }
});

// Stop an agent
app.post("/api/agents/:id/stop", async (c) => {
  const id = c.req.param("id");
  agentManager.stopAgent(id);
  return c.json({ ok: true });
});

// --- Start ---

await agentManager.init();

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`claudesk running at http://localhost:${PORT}`);

if (!process.argv.includes("--no-open")) {
  const openCmd = process.platform === "win32" ? "start"
    : process.platform === "darwin" ? "open"
    : "xdg-open";
  Bun.spawn([openCmd, `http://localhost:${PORT}`]);
}
