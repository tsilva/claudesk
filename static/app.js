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

  // --- Sidebar Filter ---

  function filterSidebar(query) {
    var sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    var q = (query || "").toLowerCase().trim();

    // Filter session cards
    var cards = sidebar.querySelectorAll(".session-card");
    cards.forEach(function (card) {
      if (!q) {
        card.classList.remove("hidden");
        return;
      }
      var text = card.textContent.toLowerCase();
      // Also check parent repo group header
      var group = card.closest(".repo-group");
      if (group) {
        var header = group.querySelector(".repo-group-header");
        if (header) text += " " + header.textContent.toLowerCase();
      }
      card.classList.toggle("hidden", text.indexOf(q) === -1);
    });

    // Hide repo groups where all session cards are hidden
    var groups = sidebar.querySelectorAll(".repo-group");
    groups.forEach(function (group) {
      var groupCards = group.querySelectorAll(".session-card");
      var allHidden = groupCards.length > 0 && Array.from(groupCards).every(function (c) {
        return c.classList.contains("hidden");
      });
      group.classList.toggle("hidden", allHidden);
    });

    // Filter launch items
    var launchItems = sidebar.querySelectorAll(".launch-item-wrapper");
    var allLaunchHidden = true;
    launchItems.forEach(function (item) {
      if (!q) {
        item.classList.remove("hidden");
        allLaunchHidden = false;
        return;
      }
      var text = item.textContent.toLowerCase();
      var match = text.indexOf(q) !== -1;
      item.classList.toggle("hidden", !match);
      if (match) allLaunchHidden = false;
    });

    // Hide launch section header if all items are hidden
    var launchSection = sidebar.querySelector(".launch-section");
    if (launchSection) {
      if (!q) {
        launchSection.classList.remove("hidden");
      } else {
        launchSection.classList.toggle("hidden", allLaunchHidden);
      }
    }
  }

  // Wire up filter input
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "sidebar-filter-input") {
      filterSidebar(e.target.value);
    }
  });

  function reapplyFilter() {
    var input = document.getElementById("sidebar-filter-input");
    if (input && input.value) {
      filterSidebar(input.value);
    }
  }

  // --- SSE sidebar active-class logic ---

  document.body.addEventListener("htmx:sseMessage", function (e) {
    var type = e.detail.type;

    // Re-apply active class and filter after sidebar SSE re-render
    if (type === "sidebar") {
      requestAnimationFrame(function () {
        var sidebar = document.getElementById("sidebar");
        if (!sidebar) return;
        if (currentSessionId) {
          var cards = sidebar.querySelectorAll(".session-card");
          cards.forEach(function (card) {
            card.classList.remove("active");
          });
          var active = sidebar.querySelector(
            '[hx-get="/sessions/' + currentSessionId + '/detail"]'
          );
          if (active) active.classList.add("active");
        }
        reapplyFilter();
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

    // Re-apply active class and filter after sidebar SSE re-render
    if (e.detail.target && e.detail.target.id === "sidebar") {
      if (currentSessionId) {
        var cards = e.detail.target.querySelectorAll(".session-card");
        cards.forEach(function (card) {
          card.classList.remove("active");
        });
        var active = e.detail.target.querySelector(
          '[hx-get="/sessions/' + currentSessionId + '/detail"]'
        );
        if (active) active.classList.add("active");
      }
      reapplyFilter();
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

  // --- Launch Prompt Toggle ---

  window.toggleLaunchPrompt = function (btn) {
    var wrapper = btn.closest(".launch-item-wrapper");
    var form = wrapper.querySelector(".launch-prompt-form");

    // Close all other open forms first
    document.querySelectorAll(".launch-prompt-form").forEach(function (f) {
      if (f !== form) f.classList.add("hidden");
    });

    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) {
      form.querySelector(".launch-prompt-input").focus();
    }
  };

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
