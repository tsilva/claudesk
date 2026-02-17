import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { AgentManager } from "./agents.ts";
import type { AgentSession, AgentMessage } from "./types.ts";
import { renderLayout } from "./templates/layout.ts";
import { renderSidebar } from "./templates/sidebar.ts";
import { renderSessionDetail, renderEmptyDetail } from "./templates/session-detail.ts";
import { renderMessage, renderSessionStats, renderSessionHeaderStatus, renderTurnCompleteFooter } from "./templates/components.ts";

const PORT = 3456;

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
  const pendingCounts = await agentManager.getRepoPendingCounts();
  for (const client of clients.values()) {
    const html = renderSidebar(sessions, repos, client.sessionId ?? undefined, pendingCounts);
    client.send("sidebar", html);
  }
}

// --- Agent Manager ---

// Track previous session statuses for transition detection
const prevStatuses = new Map<string, string>();

const agentManager = new AgentManager(
  // onMessage callback
  (msg: AgentMessage, session: AgentSession) => {
    if (msg.type === "system") {
      console.log(`[DEBUG onMessage] system msg: "${msg.text}" session=${session.id}`);
    }

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

    broadcastSidebar();
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

    const client: SSEClient = {
      id: clientId,
      sessionId,
      send: (event, data) => {
        stream.writeSSE({ event, data }).catch(() => {
          clients.delete(clientId);
        });
      },
      close: () => {
        clients.delete(clientId);
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
    const keepAlive = setInterval(() => {
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {
        clearInterval(keepAlive);
        clients.delete(clientId);
      });
    }, 15000);

    stream.onAbort(() => {
      clearInterval(keepAlive);
      clients.delete(clientId);
    });

    await new Promise(() => {});
  });
});

// Session detail fragment (HTMX swap)
app.get("/sessions/:id/detail", async (c) => {
  const id = c.req.param("id");
  const session = agentManager.getSession(id);
  if (!session) {
    return c.html(renderEmptyDetail());
  }
  const messages = agentManager.getRecentMessages(id);
  return c.html(renderSessionDetail(session, messages));
});

// Focus the Cursor window for a session's repo
app.post("/sessions/:id/focus", async (c) => {
  const id = c.req.param("id");
  const session = agentManager.getSession(id);
  if (!session) return c.json({ error: "not found" }, 404);

  try {
    const proc = Bun.spawn([
      "/Users/tsilva/.claude/focus-window.sh",
      session.cwd,
    ]);
    await proc.exited;
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "focus failed" }, 500);
  }
});

// Focus the claudesk browser window (via AeroSpace or fallback to open)
app.post("/api/focus-dashboard", async (c) => {
  const body = await c.req.json<{ sessionId?: string }>().catch(() => ({}));
  const sessionId = (body as any)?.sessionId;
  const AEROSPACE = "/opt/homebrew/bin/aerospace";
  const BROWSER_APPS = [
    "safari", "google chrome", "arc", "firefox",
    "brave browser", "microsoft edge", "chromium", "orion",
  ];

  try {
    const proc = Bun.spawn([
      AEROSPACE, "list-windows", "--all",
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
        const ws = Bun.spawn([AEROSPACE, "workspace", match.workspace]);
        await ws.exited;
      }
      const focus = Bun.spawn([AEROSPACE, "focus", "--window-id", match.windowId]);
      await focus.exited;
      return c.json({ ok: true, action: "focused" });
    }
  } catch {
    // AeroSpace not available, fall through to open
  }

  // Fallback: open in default browser
  const url = sessionId
    ? `http://localhost:${PORT}/#session=${sessionId}`
    : `http://localhost:${PORT}/`;
  const open = Bun.spawn(["open", url]);
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

// Create a new session (no prompt required)
app.post("/api/agents/launch", async (c) => {
  try {
    const body = await c.req.json<{ cwd: string; model?: string; permissionMode?: string }>();
    const { cwd, model, permissionMode } = body;
    if (!cwd) return c.json({ error: "cwd required" }, 400);

    const session = agentManager.createSession(cwd, model, permissionMode as any);
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

    await agentManager.sendMessage(id, body.text);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
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

// DEBUG: Test question SSE delivery independently of SDK
app.post("/api/debug/test-question", async (c) => {
  const body = await c.req.json<{ sessionId: string }>().catch(() => ({ sessionId: "" }));
  const sessionId = body.sessionId;
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const session = agentManager.getSession(sessionId);
  if (!session) return c.json({ error: "session not found" }, 404);

  const fakeMsg: AgentMessage = {
    id: `q-debug-test`,
    type: "system",
    timestamp: new Date(),
    text: "Debug question test",
    sessionId,
    questionData: {
      questions: [
        {
          question: "Which language do you prefer?",
          header: "Language",
          options: [
            { label: "TypeScript", description: "Typed JavaScript" },
            { label: "Python", description: "General purpose" },
            { label: "Rust", description: "Systems programming" },
          ],
          multiSelect: false,
        },
      ],
      originalInput: {},
    },
  };

  const html = renderMessage(fakeMsg);
  const clientCount = Array.from(clients.values()).filter(cl => cl.sessionId === sessionId).length;
  console.log(`[DEBUG test-question] broadcasting to ${clientCount} clients for session=${sessionId}`);
  if (html) broadcast("stream-append", html, sessionId);
  return c.json({ ok: true, clientCount });
});

// Change permission mode
app.post("/api/agents/:id/mode", async (c) => {
  try {
    const id = c.req.param("id");
    const { mode } = await c.req.json<{ mode: string }>();
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
