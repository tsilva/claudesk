import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { AgentManager } from "./agents.ts";
import type { AgentSession, AgentMessage } from "./types.ts";
import { renderLayout } from "./templates/layout.ts";
import { renderSidebar } from "./templates/sidebar.ts";
import { renderSessionDetail, renderEmptyDetail } from "./templates/session-detail.ts";
import { renderMessage, renderSessionStats, renderPermissionPrompt } from "./templates/components.ts";

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

function broadcastSidebar() {
  const sessions = agentManager.getSessions();
  const repos = agentManager.getLaunchableRepos();
  for (const client of clients.values()) {
    const html = renderSidebar(sessions, repos, client.sessionId ?? undefined);
    client.send("sidebar", html);
  }
}

// --- Agent Manager ---

const agentManager = new AgentManager(
  // onMessage callback
  (msg: AgentMessage, session: AgentSession) => {
    if (msg.type === "system" && msg.text?.startsWith("Permission requested:")) {
      // Send permission prompt to viewers of this session
      if (session.pendingPermission) {
        const html = renderPermissionPrompt(session.pendingPermission, session.id);
        broadcast("permission-request", html, session.id);
      }
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
  (_sessions: AgentSession[]) => {
    broadcastSidebar();
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
  const activeSession = sessions[0] ?? null;
  const messages = activeSession
    ? agentManager.getRecentMessages(activeSession.id)
    : [];
  return c.html(renderLayout(sessions, repos, activeSession, messages));
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
    const sidebarHtml = renderSidebar(sessions, repos, sessionId ?? undefined);
    client.send("sidebar", sidebarHtml);

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
      session.repoName,
    ]);
    await proc.exited;
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "focus failed" }, 500);
  }
});

// Dismiss a session
app.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const found = agentManager.dismissSession(id);
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// --- Agent API ---

// Launch a new agent
app.post("/api/agents/launch", async (c) => {
  try {
    const body = await c.req.json<{ cwd: string; prompt: string; model?: string }>();
    const { cwd, prompt, model } = body;
    if (!cwd || !prompt) return c.json({ error: "cwd and prompt required" }, 400);

    const session = await agentManager.launch(cwd, prompt, model);
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
    const body = await c.req.json<{ allow: boolean; message?: string }>();

    agentManager.respondToPermission(id, body.allow, body.message);
    // Clear the permission prompt for viewers
    broadcast("permission-request", "", id);
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

// Stop an agent
app.post("/api/agents/:id/stop", async (c) => {
  const id = c.req.param("id");
  agentManager.stopAgent(id);
  return c.json({ ok: true });
});

// --- Start ---

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`claudesk running at http://localhost:${PORT}`);
