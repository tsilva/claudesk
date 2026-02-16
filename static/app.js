// claudesk client-side JS
// Handles: notifications, SSE session switching, connection status

(function () {
  // --- State ---
  let notificationsEnabled = false;
  let currentSessionId = null;

  // --- Notifications ---

  window.toggleNotifications = function () {
    if (!notificationsEnabled) {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().then(function (perm) {
          if (perm === "granted") {
            enableNotifications();
          }
        });
      } else if (Notification.permission === "granted") {
        enableNotifications();
      }
    } else {
      disableNotifications();
    }
  };

  function enableNotifications() {
    notificationsEnabled = true;
    var status = document.getElementById("notif-status");
    if (status) status.textContent = "On";
  }

  function disableNotifications() {
    notificationsEnabled = false;
    var status = document.getElementById("notif-status");
    if (status) status.textContent = "Off";
  }

  // --- SSE Notification Handler ---

  document.body.addEventListener("sse:notify", function (e) {
    if (!notificationsEnabled) return;

    try {
      var data = JSON.parse(e.detail.data);
      var title = "claudesk";
      var body = "";

      if (data.event === "stop") {
        title = data.repoName || "Claude Code";
        body = "Ready for input";
      } else if (data.event === "permission") {
        title = data.repoName || "Claude Code";
        body = "Permission required";
      }

      if (body) {
        var n = new Notification(title, {
          body: body,
          tag: "claudesk-" + (data.sessionId || ""),
          silent: false,
        });

        n.onclick = function () {
          window.focus();
          if (data.sessionId) {
            switchSession(data.sessionId);
          }
          n.close();
        };

        // Auto-close after 8s
        setTimeout(function () {
          n.close();
        }, 8000);
      }
    } catch (err) {
      // ignore parse errors
    }
  });

  // --- SSE sidebar active-class logic ---

  document.body.addEventListener("htmx:sseMessage", function (e) {
    var type = e.detail.type;

    // Re-apply active class after sidebar SSE re-render
    if (type === "sidebar" && currentSessionId) {
      requestAnimationFrame(function () {
        var sidebar = document.getElementById("sidebar");
        if (!sidebar) return;
        var cards = sidebar.querySelectorAll(".session-card");
        cards.forEach(function (card) {
          card.classList.remove("active");
        });
        var active = sidebar.querySelector(
          '[hx-get="/sessions/' + currentSessionId + '/detail"]'
        );
        if (active) active.classList.add("active");
      });
    }
  });

  // Re-apply active class after sidebar htmx swap; scroll to top on session load
  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (e.detail.target && e.detail.target.id === "session-detail") {
      var container = document.getElementById("conversation-stream");
      if (container) {
        container.scrollTop = 0;
      }
    }

    // Re-apply active class after sidebar SSE re-render
    if (e.detail.target && e.detail.target.id === "sidebar" && currentSessionId) {
      var cards = e.detail.target.querySelectorAll(".session-card");
      cards.forEach(function (card) {
        card.classList.remove("active");
      });
      var active = e.detail.target.querySelector(
        '[hx-get="/sessions/' + currentSessionId + '/detail"]'
      );
      if (active) active.classList.add("active");
    }
  });

  // --- Session Switching ---

  window.switchSession = function (sessionId) {
    if (sessionId === currentSessionId) return;
    currentSessionId = sessionId;

    // Update active state in sidebar
    var cards = document.querySelectorAll(".session-card");
    cards.forEach(function (card) {
      card.classList.remove("active");
    });
    // The clicked card gets active via htmx swap, but we also set it eagerly
    var target = document.querySelector(
      '[hx-get="/sessions/' + sessionId + '/detail"]'
    );
    if (target) target.classList.add("active");

    // Reconnect SSE with new session filter
    reconnectSSE(sessionId);
  };

  function reconnectSSE(sessionId) {
    // Close existing SSE and reconnect with new session param
    var app = document.querySelector(".app");
    if (!app) return;

    var newUrl = "/events?session=" + sessionId;
    app.setAttribute("sse-connect", newUrl);

    // Reconnect SSE directly — avoids htmx.process(app) which reprocesses the entire DOM tree
    htmx.reconnectSSE(app);
  }

  // --- Connection Status ---

  function updateConnectionDot(connected) {
    var dot = document.getElementById("connection-dot");
    if (dot) {
      dot.classList.toggle("connected", connected);
      dot.title = connected ? "SSE Connected" : "SSE Disconnected";
    }
  }

  document.body.addEventListener("htmx:sseOpen", function () {
    updateConnectionDot(true);
  });

  document.body.addEventListener("htmx:sseError", function () {
    updateConnectionDot(false);
  });

  document.body.addEventListener("htmx:sseClose", function () {
    updateConnectionDot(false);
  });

  // --- Init ---

  // Extract current session from SSE URL
  var app = document.querySelector(".app");
  if (app) {
    var sseUrl = app.getAttribute("sse-connect") || "";
    var match = sseUrl.match(/session=([^&]+)/);
    if (match) {
      currentSessionId = match[1];
    }
  }
})();
