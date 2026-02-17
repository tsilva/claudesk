// claudesk client-side JS
// Handles: notifications, SSE session switching, connection status, agent interaction

(function () {
  // --- State ---
  let notificationsEnabled = false;
  let currentSessionId = null;
  var savedLaunchFormState = null;

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

      if (data.event === "permission") {
        title = data.repoName || "Agent";
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

    var cards = sidebar.querySelectorAll(".session-card");
    cards.forEach(function (card) {
      if (!q) {
        card.classList.remove("hidden");
        return;
      }
      var text = card.textContent.toLowerCase();
      var group = card.closest(".repo-group");
      if (group) {
        var header = group.querySelector(".repo-group-header");
        if (header) text += " " + header.textContent.toLowerCase();
      }
      card.classList.toggle("hidden", text.indexOf(q) === -1);
    });

    var groups = sidebar.querySelectorAll(".repo-group");
    groups.forEach(function (group) {
      var groupCards = group.querySelectorAll(".session-card");
      var allHidden = groupCards.length > 0 && Array.from(groupCards).every(function (c) {
        return c.classList.contains("hidden");
      });
      group.classList.toggle("hidden", allHidden);
    });

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

    var launchSection = sidebar.querySelector(".launch-section");
    if (launchSection) {
      if (!q) {
        launchSection.classList.remove("hidden");
      } else {
        launchSection.classList.toggle("hidden", allLaunchHidden);
      }
    }
  }

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

  // --- Launch Form State Preservation ---

  function saveLaunchFormState() {
    var form = document.querySelector(".launch-prompt-form:not(.hidden)");
    if (!form) {
      savedLaunchFormState = null;
      return;
    }
    var promptInput = form.querySelector(".launch-prompt-input");
    if (!promptInput) return;
    // Identify the form by the cwd encoded in onsubmit
    var onsubmit = form.getAttribute("onsubmit") || "";
    savedLaunchFormState = {
      formKey: onsubmit,
      prompt: promptInput.value,
      hadFocus: document.activeElement === promptInput,
    };
  }

  function restoreLaunchFormState() {
    if (!savedLaunchFormState) return;
    var state = savedLaunchFormState;
    var forms = document.querySelectorAll(".launch-prompt-form");
    for (var i = 0; i < forms.length; i++) {
      var onsubmit = forms[i].getAttribute("onsubmit") || "";
      if (onsubmit === state.formKey) {
        forms[i].classList.remove("hidden");
        var promptInput = forms[i].querySelector(".launch-prompt-input");
        if (promptInput) {
          promptInput.value = state.prompt;
          if (state.hadFocus) {
            promptInput.focus();
            promptInput.setSelectionRange(state.prompt.length, state.prompt.length);
          }
        }
        return;
      }
    }
  }

  document.addEventListener("input", function (e) {
    if (e.target && e.target.classList.contains("launch-prompt-input")) {
      saveLaunchFormState();
    }
  });
  document.addEventListener("focusin", function (e) {
    if (e.target && e.target.classList.contains("launch-prompt-input")) {
      saveLaunchFormState();
    }
  });

  document.body.addEventListener("htmx:sseBeforeMessage", function () {
    saveLaunchFormState();
  });

  // --- SSE sidebar active-class logic ---

  document.body.addEventListener("htmx:sseMessage", function (e) {
    var type = e.detail.type;

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
        restoreLaunchFormState();
      });
    }
  });

  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (e.detail.target && e.detail.target.id === "session-detail") {
      var container = document.getElementById("conversation-stream");
      if (container) {
        container.scrollTop = 0;
      }
      // Focus message input when session loads
      var input = document.querySelector(".message-input");
      if (input && !input.disabled) {
        input.focus();
      }
    }

  });

  // --- Session Dismiss ---

  window.dismissSession = function (sessionId) {
    fetch("/sessions/" + sessionId, { method: "DELETE" }).then(function () {
      if (sessionId === currentSessionId) {
        currentSessionId = null;
        var detail = document.getElementById("session-detail");
        if (detail) detail.innerHTML = "";
      }
    });
  };

  // --- Session Switching ---

  window.switchSession = function (sessionId) {
    if (sessionId === currentSessionId) return;
    currentSessionId = sessionId;

    var cards = document.querySelectorAll(".session-card");
    cards.forEach(function (card) {
      card.classList.remove("active");
    });
    var target = document.querySelector(
      '[hx-get="/sessions/' + sessionId + '/detail"]'
    );
    if (target) target.classList.add("active");

    reconnectSSE(sessionId);

    // Focus the corresponding Cursor window
    fetch("/sessions/" + sessionId + "/focus", { method: "POST" });
  };

  function reconnectSSE(sessionId) {
    var app = document.querySelector(".app");
    if (!app) return;

    var newUrl = "/events?session=" + sessionId;
    app.setAttribute("sse-connect", newUrl);
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

    document.querySelectorAll(".launch-prompt-form").forEach(function (f) {
      if (f !== form) f.classList.add("hidden");
    });

    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) {
      form.querySelector(".launch-prompt-input").focus();
      saveLaunchFormState();
    } else {
      savedLaunchFormState = null;
    }
  };

  // --- Agent Interaction ---

  window.launchAgent = function (event, cwd) {
    event.preventDefault();
    var form = event.target;
    var promptInput = form.querySelector('[name="prompt"]');
    var prompt = promptInput ? promptInput.value.trim() : "";
    if (!prompt) return;

    fetch("/api/agents/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: cwd, prompt: prompt }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.sessionId) {
          form.reset();
          form.classList.add("hidden");
          savedLaunchFormState = null;
          // Switch to the new session
          switchSession(data.sessionId);
          // Fetch the detail view
          htmx.ajax("GET", "/sessions/" + data.sessionId + "/detail", "#session-detail");
        }
      })
      .catch(function (err) {
        console.error("Launch failed:", err);
      });
  };

  window.sendMessage = function (event, sessionId) {
    event.preventDefault();
    var form = event.target;
    var input = form.querySelector('[name="text"]');
    var text = input ? input.value.trim() : "";
    if (!text) return;

    // Disable input while sending
    input.disabled = true;
    var btn = form.querySelector(".message-send-btn");
    if (btn) btn.disabled = true;

    fetch("/api/agents/" + sessionId + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    })
      .then(function () {
        input.value = "";
      })
      .catch(function (err) {
        console.error("Send failed:", err);
      })
      .finally(function () {
        input.disabled = false;
        if (btn) btn.disabled = false;
        input.focus();
      });
  };

  window.approvePermission = function (sessionId) {
    fetch("/api/agents/" + sessionId + "/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: true }),
    });
  };

  window.denyPermission = function (sessionId) {
    var message = prompt("Denial reason (optional):");
    fetch("/api/agents/" + sessionId + "/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: false, message: message || "User denied" }),
    });
  };

  window.stopAgent = function (sessionId) {
    fetch("/api/agents/" + sessionId + "/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  };

  // --- Elapsed Timer ---

  function formatElapsed(ms) {
    var seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    var secs = seconds % 60;
    return minutes + 'm ' + (secs < 10 ? '0' : '') + secs + 's';
  }

  setInterval(function () {
    var elements = document.querySelectorAll('[data-last-activity]');
    var now = Date.now();
    elements.forEach(function (el) {
      var status = el.getAttribute('data-status');
      var ts = new Date(el.getAttribute('data-last-activity')).getTime();
      var elapsed = now - ts;

      if (status === 'streaming' || status === 'starting') {
        var text = formatElapsed(elapsed);
        if (el.classList.contains('elapsed-timer')) {
          el.textContent = '\u00b7 ' + text;
        } else {
          el.textContent = text;
        }
        // Amber tint when elapsed > 60s while active
        el.classList.toggle('elapsed-warning', elapsed > 60000);
      } else if (el.classList.contains('elapsed-timer')) {
        el.textContent = '';
        el.classList.remove('elapsed-warning');
      }
    });
  }, 1000);

  // --- Init ---

  var app = document.querySelector(".app");
  if (app) {
    var sseUrl = app.getAttribute("sse-connect") || "";
    var match = sseUrl.match(/session=([^&]+)/);
    if (match) {
      currentSessionId = match[1];
    }
  }
})();
