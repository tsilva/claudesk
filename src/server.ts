import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { SessionManager, type Session, type ParsedMessage } from "./sessions.ts";
import { renderLayout } from "./templates/layout.ts";
import { renderSidebar } from "./templates/sidebar.ts";
import { renderSessionDetail, renderEmptyDetail } from "./templates/session-detail.ts";
import { renderMessage, renderSessionStats } from "./templates/components.ts";

const PORT = 3456;

// --- SSE Client Tracking ---

interface SSEClient {
  id: string;
  sessionId: string | null; // which session this client is viewing
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

function broadcastAll(event: string, data: string) {
  for (const client of clients.values()) {
    client.send(event, data);
  }
}

function broadcastSidebar() {
  const sessions = sessionManager.getSessions();
  const repos = sessionManager.getLaunchableRepos();
  for (const client of clients.values()) {
    const html = renderSidebar(sessions, repos, client.sessionId ?? undefined);
    client.send("sidebar", html);
  }
}

// --- Session Manager ---

const sessionManager = new SessionManager(
  // onMessage callback
  (msg: ParsedMessage, session: Session) => {
    if (msg.type === "progress") {
      const html = renderMessage(msg);
      if (html) {
        broadcast("stream-progress", html, session.id);
      }
    } else {
      // Clear progress indicator before appending real content
      broadcast("stream-progress", "", session.id);
      const html = renderMessage(msg);
      if (html) {
        broadcast("stream-append", html, session.id);
      }
    }
    // Update sidebar for all clients on status changes
    if (msg.type === "user" || msg.type === "assistant" || msg.type === "system") {
      broadcastSidebar();
      // Update stats for viewers of this session
      const statsHtml = renderSessionStats(session);
      broadcast("session-stats", statsHtml, session.id);
    }
  },
  // onSessionChange callback
  (_sessions: Session[]) => {
    broadcastSidebar();
  }
);

// --- Hono App ---

const app = new Hono();

// Static files
app.use("/static/*", serveStatic({ root: "./" }));

// Full page
app.get("/", async (c) => {
  const sessions = sessionManager.getSessions();
  const repos = sessionManager.getLaunchableRepos();
  const activeSession = sessions[0] ?? null;
  const messages = activeSession
    ? await sessionManager.getRecentMessages(activeSession.id)
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
          // Client disconnected
          clients.delete(clientId);
        });
      },
      close: () => {
        clients.delete(clientId);
      },
    };

    clients.set(clientId, client);

    // Keep-alive ping every 15s
    const keepAlive = setInterval(() => {
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {
        clearInterval(keepAlive);
        clients.delete(clientId);
      });
    }, 15000);

    // Wait until stream is closed
    stream.onAbort(() => {
      clearInterval(keepAlive);
      clients.delete(clientId);
    });

    // Hold the stream open
    await new Promise(() => {});
  });
});

// Session detail fragment (HTMX swap)
app.get("/sessions/:id/detail", async (c) => {
  const id = c.req.param("id");
  const session = sessionManager.getSession(id);
  if (!session) {
    return c.html(renderEmptyDetail());
  }
  const messages = await sessionManager.getRecentMessages(id);
  return c.html(renderSessionDetail(session, messages));
});

// Hook receiver
app.post("/api/hook", async (c) => {
  try {
    const body = await c.req.json<{ event: string; project: string }>();
    const { event, project } = body;

    // Find session by project dir
    const sessions = sessionManager.getSessions();
    const session = sessions.find((s) => project?.includes(s.repoName));

    if (session) {
      if (event === "permission") {
        sessionManager.setSessionStatus(session.id, "needs_permission");
      }

      // Push notification to all clients
      broadcastAll("notify", JSON.stringify({
        event,
        sessionId: session.id,
        repoName: session.repoName,
        slug: session.slug,
      }));

      // Update sidebar
      broadcastSidebar();
    }

    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 400);
  }
});

// Focus window via AeroSpace
app.post("/sessions/:id/focus", async (c) => {
  const id = c.req.param("id");
  const session = sessionManager.getSession(id);
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

// Launch Cursor for a repo
app.post("/launch", async (c) => {
  const body = await c.req.parseBody();
  const path = typeof body.path === "string" ? body.path : "";
  if (!path) return c.json({ error: "path required" }, 400);

  try {
    Bun.spawn(["cursor", path]);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "launch failed" }, 500);
  }
});

// --- Start ---

sessionManager.start();

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`claudesk running at http://localhost:${PORT}`);
