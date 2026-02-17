// claudesk client-side JS
// Handles: notifications, SSE session switching, connection status, agent interaction

(function () {
  // --- State ---
  let notificationsEnabled = false;
  let currentSessionId = null;
  var pendingAnswers = {}; // { questionText: selectedLabel(s) }


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
      } else if (data.event === "question") {
        title = data.repoName || "Agent";
        body = "Question needs your answer";
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

    var launchItems = sidebar.querySelectorAll(".launch-item");
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
      });
    }
  });

  // --- SSE Dedup: prevent duplicate messages in conversation stream ---

  document.body.addEventListener("htmx:sseBeforeMessage", function (e) {
    if (e.detail.type === "stream-append") {
      var temp = document.createElement("div");
      temp.innerHTML = e.detail.data;
      var newMsg = temp.querySelector("[data-id]");
      if (newMsg) {
        var existingMsg = document.querySelector(
          '#conversation-stream [data-id="' + newMsg.getAttribute("data-id") + '"]'
        );
        if (existingMsg) {
          e.preventDefault();
          return;
        }
      }
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
    pendingAnswers = {};

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

  // --- Agent Interaction ---

  window.createSession = function (cwd) {
    fetch("/api/agents/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: cwd }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.sessionId) {
          switchSession(data.sessionId);
          htmx.ajax("GET", "/sessions/" + data.sessionId + "/detail", "#session-detail");
        }
      })
      .catch(function (err) {
        console.error("Create session failed:", err);
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
        showTypingIndicator();
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

  // --- Question Interaction ---

  window.selectQuestionOption = function (btn) {
    var sessionId = btn.getAttribute("data-session");
    var question = btn.getAttribute("data-question");
    var label = btn.getAttribute("data-label");

    // Deselect siblings in same question block
    var block = btn.closest(".question-block");
    if (block) {
      block.querySelectorAll(".question-option").forEach(function (b) {
        b.classList.remove("selected");
      });
    }
    btn.classList.add("selected");
    pendingAnswers[question] = label;

    // Single question, single select: auto-submit
    var prompt = btn.closest(".question-prompt");
    var blocks = prompt ? prompt.querySelectorAll(".question-block") : [];
    if (blocks.length === 1) {
      submitQuestionAnswers(sessionId);
    }
  };

  window.toggleQuestionOption = function (btn) {
    var question = btn.getAttribute("data-question");
    var label = btn.getAttribute("data-label");

    btn.classList.toggle("selected");

    // Build comma-separated list of selected labels
    var block = btn.closest(".question-block");
    var selected = [];
    if (block) {
      block.querySelectorAll(".question-option.selected").forEach(function (b) {
        selected.push(b.getAttribute("data-label"));
      });
    }
    pendingAnswers[question] = selected.join(", ");
  };

  window.selectQuestionOther = function (inputEl) {
    var sessionId = inputEl.getAttribute("data-session");
    var question = inputEl.getAttribute("data-question");
    var value = inputEl.value.trim();
    if (!value) return;

    // Deselect all option buttons in this block
    var block = inputEl.closest(".question-block");
    if (block) {
      block.querySelectorAll(".question-option").forEach(function (b) {
        b.classList.remove("selected");
      });
    }

    pendingAnswers[question] = value;

    // Single question: auto-submit
    var prompt = inputEl.closest(".question-prompt");
    var blocks = prompt ? prompt.querySelectorAll(".question-block") : [];
    if (blocks.length === 1) {
      submitQuestionAnswers(sessionId);
    }
  };

  window.submitQuestionAnswers = function (sessionId) {
    var answers = Object.assign({}, pendingAnswers);
    pendingAnswers = {};

    fetch("/api/agents/" + sessionId + "/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: answers }),
    });
  };

  window.stopAgent = function (sessionId) {
    fetch("/api/agents/" + sessionId + "/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  };

  // --- Typing Indicator ---

  function showTypingIndicator() {
    var container = document.getElementById("conversation-stream");
    if (!container) return;
    // Remove any existing indicator first
    removeTypingIndicator();
    var indicator = document.createElement("div");
    indicator.className = "typing-indicator";
    indicator.id = "typing-indicator";
    indicator.innerHTML =
      '<div class="typing-indicator-dot"></div>' +
      '<div class="typing-indicator-dot"></div>' +
      '<div class="typing-indicator-dot"></div>';
    container.prepend(indicator);
  }

  function removeTypingIndicator() {
    var indicator = document.getElementById("typing-indicator");
    if (indicator) indicator.remove();
  }

  // Remove typing indicator when first agent response arrives
  document.body.addEventListener("htmx:sseMessage", function (e) {
    if (e.detail.type === "stream-append") {
      removeTypingIndicator();
    }
  });

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
