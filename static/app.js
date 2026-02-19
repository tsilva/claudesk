// claudesk client-side JS
// Handles: notifications, SSE session switching, connection status, agent interaction

(function () {
  // --- State ---
  let notificationsEnabled = false;
  let currentSessionId = null;
  var pendingAnswers = {}; // { toolUseId: { questionText: selectedLabel(s) } }
  var seenNotifications = new Set(); // tracks "event:sessionId" keys to suppress replayed notifications
  var isUserScrolling = false;
  var scrollTimeout = null;


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
    localStorage.setItem("claudesk-notifications", "on");
    var status = document.getElementById("notif-status");
    if (status) status.textContent = "On";
  }

  function disableNotifications() {
    notificationsEnabled = false;
    localStorage.setItem("claudesk-notifications", "off");
    var status = document.getElementById("notif-status");
    if (status) status.textContent = "Off";
  }

  // Restore notification preference from localStorage, falling back to browser permission
  if ("Notification" in window) {
    var savedNotifPref = localStorage.getItem("claudesk-notifications");
    if (savedNotifPref === "on" && Notification.permission === "granted") {
      enableNotifications();
    } else if (savedNotifPref === "off") {
      // Explicitly disabled — leave off
    } else if (Notification.permission === "granted") {
      enableNotifications();
    }
  }

  // --- SSE Notification Handler ---

  document.body.addEventListener("sse:notify", function (e) {
    if (!notificationsEnabled) return;

    try {
      var data = JSON.parse(e.detail.data);
      var sid = data.sessionId || "";
      var key = (data.event || "") + ":" + sid;

      // "complete" clears all keys for this session so future notifications can fire
      if (data.event === "complete") {
        seenNotifications.forEach(function (k) {
          if (k.endsWith(":" + sid)) seenNotifications.delete(k);
        });
      }

      // Skip if we already showed this notification
      if (seenNotifications.has(key)) return;

      var title = "claudesk";
      var body = "";

      if (data.event === "plan_approval") {
        title = data.repoName || "Agent";
        body = "Plan ready for review";
      } else if (data.event === "permission") {
        title = data.repoName || "Agent";
        body = "Permission required";
      } else if (data.event === "question") {
        title = data.repoName || "Agent";
        body = "Question needs your answer";
      } else if (data.event === "complete") {
        title = data.repoName || "Agent";
        body = "Task completed";
      }

      if (body) {
        seenNotifications.add(key);

        var n = new Notification(title, {
          body: body,
          tag: "claudesk-" + sid,
          silent: false,
          icon: data.logoUrl || undefined,
        });

        n.onclick = function () {
          fetch("/api/focus-dashboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: data.sessionId || null }),
          }).then(function () {
            if (data.sessionId) {
              switchSession(data.sessionId, { skipEditorFocus: true });
            }
          }).catch(function (err) { console.warn("Focus dashboard failed:", err); });
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

  // --- Needs Attention Cycle ---

  window.cycleNeedsInput = function () {
    var sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    var cards = Array.from(sidebar.querySelectorAll(".session-card"));
    var needsInput = cards.filter(function (card) {
      return card.querySelector(".status-dot.needs_input");
    });
    if (needsInput.length === 0) return;

    // Find the current active card's index in the needs-input list
    var currentIndex = -1;
    if (currentSessionId) {
      needsInput.forEach(function (card, i) {
        var hxGet = card.getAttribute("hx-get") || "";
        if (hxGet.indexOf(currentSessionId) !== -1) {
          currentIndex = i;
        }
      });
    }

    // Pick the next one (wrap around)
    var nextCard = needsInput[(currentIndex + 1) % needsInput.length];
    var hxGet = nextCard.getAttribute("hx-get") || "";
    var match = hxGet.match(/\/sessions\/([^/]+)\/detail/);
    if (match) {
      switchSession(match[1]);
      htmx.ajax("GET", hxGet, "#session-detail");
    }
  };

  function updateNeedsAttentionBadge() {
    var sidebar = document.getElementById("sidebar");
    var badge = document.getElementById("needs-attention-badge");
    var btn = document.getElementById("needs-attention-btn");
    if (!badge || !btn) return;

    var count = sidebar ? sidebar.querySelectorAll(".status-dot.needs_input").length : 0;
    badge.textContent = count;
    btn.disabled = count === 0;
    btn.classList.toggle("hidden", count === 0);
  }

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
        applyStarredState();
        updateNeedsAttentionBadge();
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
        // Allow OOB swaps through — they replace existing elements in-place
        if (newMsg.hasAttribute("hx-swap-oob")) return;

        // Replace optimistic user message with real server echo
        if (newMsg.classList.contains("message--user")) {
          var optimistic = document.getElementById("optimistic-user-msg");
          if (optimistic) {
            optimistic.replaceWith(newMsg);
            e.preventDefault();
            return;
          }
        }

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
        // Track user scrolling on conversation stream (only attach once)
        if (!container.dataset.scrollTrackingAttached) {
          container.dataset.scrollTrackingAttached = "true";
          container.addEventListener("scroll", function() {
            isUserScrolling = true;
            if (scrollTimeout) clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(function() {
              isUserScrolling = false;
            }, 2000);
          }, { passive: true });
        }
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
    fetch("/sessions/" + sessionId, { method: "DELETE" })
      .then(function () {
        if (sessionId === currentSessionId) {
          currentSessionId = null;
          var detail = document.getElementById("session-detail");
          if (detail) detail.innerHTML = "";
        }
        // Clean up notification dedup state for this session
        seenNotifications.forEach(function (k) {
          if (k.endsWith(":" + sessionId)) seenNotifications.delete(k);
        });
      })
      .catch(function (err) { console.warn("Dismiss session failed:", err); });
  };

  // --- Session Switching ---

  window.switchSession = function (sessionId, opts) {
    if (sessionId === currentSessionId) return;
    currentSessionId = sessionId;
    pendingAnswers = {};
    isUserScrolling = false;
    if (scrollTimeout) { clearTimeout(scrollTimeout); scrollTimeout = null; }

    var cards = document.querySelectorAll(".session-card");
    cards.forEach(function (card) {
      card.classList.remove("active");
    });
    var target = document.querySelector(
      '[hx-get="/sessions/' + sessionId + '/detail"]'
    );
    if (target) target.classList.add("active");

    reconnectSSE(sessionId);
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

  var MODEL_PRESETS = {
    opus: { label: "Opus", description: "Powerful — best for complex tasks", model: "claude-opus-4-6", permissionMode: "default" },
    sonnet: { label: "Sonnet", description: "Fast & capable — great for most tasks", model: "claude-sonnet-4-6", permissionMode: "default" },
    "opus-plan": { label: "Opus Plan", description: "Plans with Opus, executes with Sonnet", model: "claude-opus-4-6", permissionMode: "plan" },
  };

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

  // --- Model Selector Popup ---

  var AVAILABLE_MODELS = [
    { id: "claude-opus-4-6", label: "Opus 4.6", description: "Powerful — best for complex tasks" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", description: "Fast & capable — great for most tasks" },
    { id: "claude-opus-4-5", label: "Opus 4.5", description: "Previous generation Opus" },
    { id: "claude-sonnet-4-5", label: "Sonnet 4.5", description: "Previous generation Sonnet" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku", description: "Fastest — for simple tasks" },
  ];

  var activeModelPicker = null;

  window.showModelPicker = function (event, sessionId) {
    event.stopPropagation();
    dismissModelPicker();

    var trigger = event.target;
    var rect = trigger.getBoundingClientRect();

    var popover = document.createElement("div");
    popover.className = "model-picker-popover";
    popover.style.position = "fixed";
    popover.style.bottom = (window.innerHeight - rect.top + 4) + "px";
    popover.style.left = rect.left + "px";
    popover.style.zIndex = "9999";

    AVAILABLE_MODELS.forEach(function (m) {
      var opt = document.createElement("button");
      opt.className = "model-picker-option";
      opt.type = "button";
      opt.innerHTML =
        '<span class="model-picker-label">' + escapeHtmlClient(m.label) + '</span>' +
        '<span class="model-picker-desc">' + escapeHtmlClient(m.description) + '</span>';
      opt.onclick = function (e) {
        e.stopPropagation();
        dismissModelPicker();
        updateSessionModel(sessionId, m.id);
      };
      popover.appendChild(opt);
    });

    document.body.appendChild(popover);
    activeModelPicker = popover;
  };

  function dismissModelPicker() {
    if (activeModelPicker) {
      activeModelPicker.remove();
      activeModelPicker = null;
    }
  }

  document.addEventListener("click", function (e) {
    // Handle model picker click via event delegation
    var target = e.target;
    if (target && target.getAttribute("data-action") === "show-model-picker") {
      var sessionId = target.getAttribute("data-session-id");
      if (sessionId) {
        e.stopPropagation();
        showModelPicker(e, sessionId);
        return;
      }
    }
    dismissModelPicker();
  });

  window.updateSessionModel = function (sessionId, model) {
    fetch("/api/agents/" + sessionId + "/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model }),
    })
      .then(function (res) {
        if (res.ok) {
          // Refresh the session stats to show new model
          htmx.ajax("GET", "/sessions/" + sessionId + "/detail", "#session-detail");
        }
      })
      .catch(function (err) {
        console.error("Update model failed:", err);
      });
  };

  window.handleMessageKeydown = function (event, sessionId) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      var form = event.target.closest('form');
      if (form) {
        var submitEvent = new Event('submit', { bubbles: true, cancelable: true });
        form.dispatchEvent(submitEvent);
      }
    }
    // Shift+Tab cycles permission mode
    if (event.shiftKey && event.key === 'Tab') {
      event.preventDefault();
      var detail = event.target.closest('[data-session-id]');
      if (detail) cycleMode(detail.getAttribute('data-session-id'));
    }
  };

  window.handleMessagePaste = function (event) {
    var items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    
    var hasFiles = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var file = items[i].getAsFile();
        if (file) {
          pendingFiles.push(file);
          hasFiles = true;
        }
      }
    }
    
    if (hasFiles) {
      event.preventDefault();
      updateAttachmentPreview();
    }
  };

  // --- File Upload ---
  var pendingFiles = [];

  window.handleFileSelect = function (event) {
    var files = event.target.files;
    if (!files || files.length === 0) return;
    
    for (var i = 0; i < files.length; i++) {
      pendingFiles.push(files[i]);
    }
    updateAttachmentPreview();
    event.target.value = ''; // Reset input for re-selection
  };

  // --- Global Drag and Drop ---
  var dragCounter = 0;

  function showDropOverlay() {
    var overlay = document.getElementById('drop-overlay');
    if (overlay) overlay.classList.add('active');
  }

  function hideDropOverlay() {
    var overlay = document.getElementById('drop-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  document.addEventListener('dragenter', function (event) {
    event.preventDefault();
    dragCounter++;
    if (event.dataTransfer && event.dataTransfer.types.includes('Files')) {
      showDropOverlay();
    }
  });

  document.addEventListener('dragleave', function (event) {
    event.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      hideDropOverlay();
    }
  });

  document.addEventListener('dragover', function (event) {
    event.preventDefault();
  });

  document.addEventListener('drop', function (event) {
    event.preventDefault();
    dragCounter = 0;
    hideDropOverlay();

    var files = event.dataTransfer.files;
    if (!files || files.length === 0) return;

    for (var i = 0; i < files.length; i++) {
      pendingFiles.push(files[i]);
    }
    updateAttachmentPreview();

    // Focus the message input after dropping files
    var input = document.querySelector('.message-input');
    if (input && !input.disabled) {
      input.focus();
    }
  });

  window.removeAttachment = function (index) {
    pendingFiles.splice(index, 1);
    updateAttachmentPreview();
  };

  function updateAttachmentPreview() {
    var container = document.getElementById("attachment-preview");
    if (!container) return;
    
    if (pendingFiles.length === 0) {
      container.innerHTML = "";
      return;
    }
    
    // Clear container first
    container.innerHTML = "";
    
    // Process each file
    for (var i = 0; i < pendingFiles.length; i++) {
      (function(index) {
        var file = pendingFiles[index];
        var isImage = file.type.startsWith("image/");
        var isPdf = file.type === "application/pdf";
        
        var chip = document.createElement('div');
        chip.className = 'attachment-chip' + (isPdf ? ' attachment-chip--pdf' : '');
        
        if (isImage) {
          // Create image preview
          var img = document.createElement('img');
          img.className = 'attachment-thumbnail';
          img.alt = '';
          
          var reader = new FileReader();
          reader.onload = function(e) {
            img.src = e.target.result;
          };
          reader.readAsDataURL(file);
          chip.appendChild(img);
        } else if (isPdf) {
          // PDF icon
          var icon = document.createElement('span');
          icon.className = 'attachment-icon';
          icon.textContent = '📑';
          chip.appendChild(icon);
        } else {
          // Generic file icon
          var icon = document.createElement('span');
          icon.className = 'attachment-icon';
          icon.textContent = '📄';
          chip.appendChild(icon);
        }
        
        // Add filename
        var name = document.createElement('span');
        name.className = 'attachment-name';
        name.textContent = file.name;
        chip.appendChild(name);
        
        // Add remove button
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'attachment-remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = function() { removeAttachment(index); };
        chip.appendChild(removeBtn);
        
        container.appendChild(chip);
      })(i);
    }
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  window.sendMessage = function (event, sessionId) {
    event.preventDefault();
    var form = event.target;
    var input = form.querySelector('[name="text"]');
    var text = input ? input.value.trim() : "";
    
    if (!text && pendingFiles.length === 0) return;

    // Disable input while sending
    if (input) input.disabled = true;

    createOptimisticUserMessage(text);
    showTypingIndicator();

    var container = document.getElementById("conversation-stream");
    if (container) {
        container.scrollTop = 0;
    }

    var body;
    var headers = {};
    
    if (pendingFiles.length > 0) {
      // Use FormData for file uploads
      body = new FormData();
      body.append("text", text);
      for (var i = 0; i < pendingFiles.length; i++) {
        body.append("files", pendingFiles[i]);
      }
      pendingFiles = [];
      updateAttachmentPreview();
    } else {
      // JSON for text-only messages
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ text: text });
    }

    fetch("/api/agents/" + sessionId + "/message", {
      method: "POST",
      headers: headers,
      body: body,
    })
      .then(function (res) {
        if (!res.ok) throw new Error(res.statusText || "Send failed");
        if (input) input.value = "";
      })
      .catch(function (err) {
        console.error("Send failed:", err);
        removeTypingIndicator();
        var optimistic = document.getElementById("optimistic-user-msg");
        if (optimistic) optimistic.remove();
      })
      .finally(function () {
        if (input) { input.disabled = false; input.focus(); }
      });
  };

  window.openImageLightbox = function (base64Data, mediaType) {
    mediaType = mediaType || "image/png";
    var overlay = document.createElement("div");
    overlay.className = "image-lightbox-overlay";
    overlay.innerHTML = '<div class="image-lightbox-content"><img src="data:' + mediaType + ";base64," + base64Data + '"><button class="image-lightbox-close">×</button></div>';
    document.body.appendChild(overlay);
    
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.className === "image-lightbox-close") {
        document.body.removeChild(overlay);
      }
    });
  };

  window.approvePermission = function (sessionId, toolUseId) {
    seenNotifications.delete("permission:" + sessionId);
    showTypingIndicator();
    fetch("/api/agents/" + sessionId + "/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: true, toolUseId: toolUseId }),
    }).catch(function () {
      removeTypingIndicator();
    });
  };

  window.showDenyInput = function (sessionId, toolUseId, btn) {
    var row = document.getElementById("deny-row-" + toolUseId);
    if (!row) return;
    row.style.display = "flex";
    var input = row.querySelector(".deny-reason-input");
    if (input) input.focus();
    btn.style.display = "none";
  };

  window.confirmDeny = function (sessionId, toolUseId, inputEl) {
    var message = inputEl ? inputEl.value.trim() : "";
    seenNotifications.delete("permission:" + sessionId);
    showTypingIndicator();
    fetch("/api/agents/" + sessionId + "/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: false, message: message || "User denied", toolUseId: toolUseId }),
    }).catch(function () {
      removeTypingIndicator();
    });
  };

  window.denyPermission = function (sessionId, toolUseId) {
    // Legacy fallback — should not be called since deny button now uses showDenyInput
    confirmDeny(sessionId, toolUseId, null);
  };

  // --- Question Interaction ---

  function getToolUseId(msgId) {
    return msgId ? msgId.replace(/^q-/, '') : '__default__';
  }

  window.selectQuestionOption = function (btn) {
    var sessionId = btn.getAttribute("data-session");
    var question = btn.getAttribute("data-question");
    var label = btn.getAttribute("data-label");
    var msgId = btn.getAttribute("data-msg-id");
    var toolUseId = getToolUseId(msgId);

    // Deselect siblings in same question block
    var block = btn.closest(".question-block");
    if (block) {
      block.querySelectorAll(".question-option").forEach(function (b) {
        b.classList.remove("selected");
      });
    }
    btn.classList.add("selected");
    if (!pendingAnswers[toolUseId]) pendingAnswers[toolUseId] = {};
    pendingAnswers[toolUseId][question] = label;

    // Single question, single select: auto-submit
    var prompt = btn.closest(".question-prompt");
    var blocks = prompt ? prompt.querySelectorAll(".question-block") : [];
    if (blocks.length === 1) {
      submitQuestionAnswers(sessionId, msgId);
    }
  };

  window.toggleQuestionOption = function (btn) {
    var question = btn.getAttribute("data-question");
    var label = btn.getAttribute("data-label");
    var msgId = btn.getAttribute("data-msg-id");
    var toolUseId = getToolUseId(msgId);

    btn.classList.toggle("selected");

    // Build comma-separated list of selected labels
    var block = btn.closest(".question-block");
    var selected = [];
    if (block) {
      block.querySelectorAll(".question-option.selected").forEach(function (b) {
        selected.push(b.getAttribute("data-label"));
      });
    }
    if (!pendingAnswers[toolUseId]) pendingAnswers[toolUseId] = {};
    pendingAnswers[toolUseId][question] = selected.join(", ");
  };

  window.selectQuestionOther = function (inputEl) {
    var sessionId = inputEl.getAttribute("data-session");
    var question = inputEl.getAttribute("data-question");
    var msgId = inputEl.getAttribute("data-msg-id");
    var toolUseId = getToolUseId(msgId);
    var value = inputEl.value.trim();
    if (!value) return;

    // Deselect all option buttons in this block
    var block = inputEl.closest(".question-block");
    if (block) {
      block.querySelectorAll(".question-option").forEach(function (b) {
        b.classList.remove("selected");
      });
    }

    if (!pendingAnswers[toolUseId]) pendingAnswers[toolUseId] = {};
    pendingAnswers[toolUseId][question] = value;

    // Single question: auto-submit
    var prompt = inputEl.closest(".question-prompt");
    var blocks = prompt ? prompt.querySelectorAll(".question-block") : [];
    if (blocks.length === 1) {
      submitQuestionAnswers(sessionId, msgId);
    }
  };

  window.submitQuestionAnswers = function (sessionId, msgId) {
    var toolUseId = getToolUseId(msgId);
    var answers = Object.assign({}, pendingAnswers[toolUseId] || {});
    delete pendingAnswers[toolUseId];
    seenNotifications.delete("question:" + sessionId);

    // Optimistically collapse the specific question message being answered
    var answerValues = Object.values(answers).filter(Boolean).join(', ');
    var badgeText = answerValues ? 'Answered: ' + answerValues : 'Answered';
    var questionMsgs = msgId
      ? (document.getElementById(msgId) ? [document.getElementById(msgId)] : [])
      : document.querySelectorAll('#conversation-stream .message--question');
    questionMsgs.forEach(function(el) {
      if (!el) return;
      var questionTextEl = el.querySelector('.question-text');
      var firstQ = questionTextEl ? questionTextEl.textContent.trim() : 'Question';

      // Build expanded content showing answers
      var expandedContent = '';
      for (var question in answers) {
        if (answers[question]) {
          expandedContent += '<div class="question-detail-block"><div class="question-detail-answer">' + escapeHtmlClient(answers[question]) + '</div></div>';
        }
      }

      el.className = 'message message--system';
      el.innerHTML = '<div class="message-content"><details class="question-resolved-details"><summary class="question-resolved-summary"><span class="question-prompt-icon" style="width:16px;height:16px;font-size:10px;">?</span><span class="question-resolved-text">' + escapeHtmlClient(firstQ) + '</span><span class="question-badge question-badge--answered">' + escapeHtmlClient(badgeText) + '</span></summary>' + (expandedContent ? '<div class="question-resolved-content">' + expandedContent + '</div>' : '') + '</details></div>';
    });

    showTypingIndicator();
    fetch("/api/agents/" + sessionId + "/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolUseId: toolUseId, answers: answers }),
    }).catch(function () {
      removeTypingIndicator();
    });
  };

  // --- Plan Approval Interaction ---

  window.acceptPlan = function (sessionId) {
    seenNotifications.delete("plan_approval:" + sessionId);
    showTypingIndicator();
    fetch("/api/agents/" + sessionId + "/plan-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accept: true }),
    }).catch(function () {
      removeTypingIndicator();
    });
  };

  window.revisePlan = function (sessionId) {
    var input = document.querySelector(".plan-revise-input");
    var feedback = input ? input.value.trim() : "";
    if (!feedback) {
      if (input) input.focus();
      return;
    }
    seenNotifications.delete("plan_approval:" + sessionId);
    showTypingIndicator();
    fetch("/api/agents/" + sessionId + "/plan-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accept: false, feedback: feedback }),
    }).catch(function () {
      removeTypingIndicator();
    });
  };

  window.copyCode = function (btn) {
    var text = btn.getAttribute("data-code") || "";
    navigator.clipboard.writeText(text).then(function () {
      var orig = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("code-copy-btn--copied");
      setTimeout(function () {
        btn.textContent = orig;
        btn.classList.remove("code-copy-btn--copied");
      }, 2000);
    }).catch(function () {
      // Fallback for older browsers
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 2000);
    });
  };

  window.stopAgent = function (sessionId) {
    fetch("/api/agents/" + sessionId + "/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).catch(function (err) { console.warn("Stop agent failed:", err); });
  };

  window.focusEditor = function (sessionId) {
    fetch("/sessions/" + sessionId + "/focus", { method: "POST" })
      .catch(function (err) { console.warn("Focus editor failed:", err); });
  };

  // --- Raw Mode Toggle ---

  window.toggleRawMode = function (sessionId) {
    var detail = document.getElementById("session-detail");
    if (!detail) return;

    var isRawMode = detail.querySelector(".raw-mode-active") !== null;
    var mode = isRawMode ? "normal" : "raw";

    htmx.ajax("GET", "/sessions/" + sessionId + "/raw-toggle?mode=" + mode, "#session-detail");
  };

  // --- Permission Mode Cycling ---

  var MODE_ORDER = ['plan', 'acceptEdits', 'bypassPermissions', 'delegate', 'dontAsk'];
  var MODE_LABELS = {
    default: 'Plan', plan: 'Plan', acceptEdits: 'Accept Edits',
    bypassPermissions: 'Bypass', delegate: 'Delegate', dontAsk: "Don't Ask"
  };
  var MODE_TOOLTIPS = {
    default: 'Agent creates a plan for approval before making changes',
    plan: 'Agent creates a plan for approval before making changes',
    acceptEdits: 'Agent can read and edit files freely, asks before running commands',
    bypassPermissions: 'Agent runs all tools without asking — use with caution',
    delegate: 'Agent works independently, notifies you only on completion',
    dontAsk: 'Agent remembers your choices and stops asking for repeated tools'
  };

  window.cycleMode = function (sessionId) {
    var indicator = document.querySelector('.mode-stat--interactive');
    if (!indicator) return;

    var currentMode = 'plan';
    MODE_ORDER.forEach(function (m) {
      if (indicator.classList.contains('mode-stat--' + m)) currentMode = m;
    });
    var idx = MODE_ORDER.indexOf(currentMode);
    var nextMode = MODE_ORDER[(idx + 1) % MODE_ORDER.length];

    // Optimistic UI update
    indicator.textContent = MODE_LABELS[nextMode];
    indicator.title = (MODE_TOOLTIPS[nextMode] || MODE_TOOLTIPS.plan) + ' (shift+tab)';
    MODE_ORDER.forEach(function (m) { indicator.classList.remove('mode-stat--' + m); });
    indicator.classList.remove('mode-stat--default');
    indicator.classList.add('mode-stat--' + nextMode);

    fetch('/api/agents/' + sessionId + '/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nextMode })
    }).then(function (res) {
      if (!res.ok) throw new Error('Mode change failed');
    }).catch(function () {
      // Rollback optimistic update on failure
      indicator.textContent = MODE_LABELS[currentMode];
      indicator.title = (MODE_TOOLTIPS[currentMode] || MODE_TOOLTIPS.plan) + ' (shift+tab)';
      MODE_ORDER.forEach(function (m) { indicator.classList.remove('mode-stat--' + m); });
      indicator.classList.add('mode-stat--' + currentMode);
    });
  };

  // Shift+Tab cycles permission mode — handled in handleMessageKeydown on textarea

  // --- Optimistic User Message ---

  function escapeHtmlClient(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function createOptimisticUserMessage(text) {
    var container = document.getElementById("conversation-stream");
    if (!container) return;
    var msg = document.createElement("div");
    msg.className = "message message--user";
    msg.id = "optimistic-user-msg";
    msg.innerHTML = '<div class="message-content">' + escapeHtmlClient(text) + '</div>';
    container.appendChild(msg);
    container.scrollTop = 0;
  }

  // --- Finishing Indicator (shown while stop hooks run after model reply) ---

  function showFinishingIndicator() {
    var container = document.getElementById("conversation-stream");
    if (!container) return;
    removeFinishingIndicator();
    var indicator = document.createElement("div");
    indicator.className = "finishing-indicator";
    indicator.id = "finishing-indicator";
    indicator.innerHTML =
      '<span class="finishing-indicator-text">Finishing up</span>' +
      '<span class="finishing-indicator-dot"></span>' +
      '<span class="finishing-indicator-dot"></span>' +
      '<span class="finishing-indicator-dot"></span>';
    container.appendChild(indicator);
    container.scrollTop = 0;
  }

  function removeFinishingIndicator() {
    var indicator = document.getElementById("finishing-indicator");
    if (indicator) indicator.remove();
  }

  // Handle hook-status SSE events
  document.body.addEventListener("htmx:sseMessage", function (e) {
    if (e.detail.type !== "hook-status") return;
    try {
      var data = JSON.parse(e.detail.data);
      if (data.state === "running") showFinishingIndicator();
      else if (data.state === "done") removeFinishingIndicator();
    } catch (err) {
      // ignore parse errors
    }
  });

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
    container.appendChild(indicator);
    container.scrollTop = 0;
  }

  function removeTypingIndicator() {
    var indicator = document.getElementById("typing-indicator");
    if (indicator) indicator.remove();
  }

  // Remove typing indicator when first agent response arrives (skip user messages)
  // Also scroll to top when new content arrives (unless user is actively scrolling)
  document.body.addEventListener("htmx:sseMessage", function (e) {
    if (e.detail.type === "stream-append") {
      // Remove empty conversation hint when first message arrives
      var emptyHint = document.getElementById("empty-conversation-hint");
      if (emptyHint) emptyHint.remove();

      var data = e.detail.data || "";
      var temp = document.createElement("div");
      temp.innerHTML = data;
      var root = temp.firstElementChild;
      var isUserMessage = root && root.classList.contains("message--user");
      if (!isUserMessage) {
        removeTypingIndicator();
        removeFinishingIndicator();
      }
      // Store whether we should scroll after the swap completes
      var shouldScroll = !isUserScrolling || isUserMessage;
      var scrollAfterSwap = function() {
        var container = document.getElementById("conversation-stream");
        if (container && shouldScroll) {
          container.scrollTop = 0;
        }
      };
      // Use setTimeout to ensure the DOM has been updated by HTMX
      setTimeout(scrollAfterSwap, 10);
    }
  });

  // Handle turn-complete: inject stats footer into first (newest) assistant message
  document.body.addEventListener("htmx:sseMessage", function (e) {
    if (e.detail.type !== "turn-complete") return;
    var container = document.getElementById("conversation-stream");
    if (!container) return;

    // Target the FIRST assistant message (visual order — newest at top due to column-reverse)
    var allAssistants = container.querySelectorAll(".message--assistant");
    var firstAssistant = allAssistants[0] || null;
    if (firstAssistant) {
      var content = firstAssistant.querySelector(".message-content");
      if (content) {
        // Remove any existing footer first
        var existing = content.querySelector(".turn-complete-footer");
        if (existing) existing.remove();
        content.insertAdjacentHTML("beforeend", e.detail.data);
      }
    }
    removeTypingIndicator();
    removeFinishingIndicator();
    // Scroll to top after footer injected (column-reverse layout: newest at top)
    // Only auto-scroll if user is not actively scrolling
    if (!isUserScrolling) {
      requestAnimationFrame(function () {
        container.scrollTop = 0;
      });
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

  // --- Starred Repos ---

  function getStarredRepos() {
    try {
      var raw = localStorage.getItem("claudesk:starred-repos");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) {
      return new Set();
    }
  }

  function saveStarredRepos(set) {
    localStorage.setItem("claudesk:starred-repos", JSON.stringify(Array.from(set)));
  }

  window.toggleStar = function (repoName) {
    var starred = getStarredRepos();
    if (starred.has(repoName)) {
      starred.delete(repoName);
    } else {
      starred.add(repoName);
    }
    saveStarredRepos(starred);
    applyStarredState();
  };

  function applyStarredState() {
    var starred = getStarredRepos();

    // Update star button icons and classes
    var starBtns = document.querySelectorAll(".star-btn");
    starBtns.forEach(function (btn) {
      var group = btn.closest("[data-repo]");
      if (!group) return;
      var repo = group.getAttribute("data-repo");
      var isStarred = starred.has(repo);
      btn.innerHTML = isStarred ? "&#9733;" : "&#9734;";
      btn.classList.toggle("starred", isStarred);
    });

    // Reorder repo-group elements within sidebar
    var sidebarScroll = document.querySelector(".sidebar-scroll");
    if (sidebarScroll) {
      var container = sidebarScroll.querySelector("[sse-swap]") || sidebarScroll;
      var groups = Array.from(container.querySelectorAll(":scope > .repo-group"));
      if (groups.length > 1) {
        groups.sort(function (a, b) {
          var aStarred = starred.has(a.getAttribute("data-repo")) ? 0 : 1;
          var bStarred = starred.has(b.getAttribute("data-repo")) ? 0 : 1;
          if (aStarred !== bStarred) return aStarred - bStarred;
          return (a.getAttribute("data-repo") || "").localeCompare(b.getAttribute("data-repo") || "");
        });
        var launchEl = container.querySelector(".launch-section");
        groups.forEach(function (g) {
          if (launchEl) {
            container.insertBefore(g, launchEl);
          } else {
            container.appendChild(g);
          }
        });
      }
    }

    // Reorder launch-item elements within launch-section
    var launchSection = document.querySelector(".launch-section");
    if (launchSection) {
      var items = Array.from(launchSection.querySelectorAll(".launch-item"));
      if (items.length > 1) {
        items.sort(function (a, b) {
          var aStarred = starred.has(a.getAttribute("data-repo")) ? 0 : 1;
          var bStarred = starred.has(b.getAttribute("data-repo")) ? 0 : 1;
          if (aStarred !== bStarred) return aStarred - bStarred;
          return (a.getAttribute("data-repo") || "").localeCompare(b.getAttribute("data-repo") || "");
        });
        items.forEach(function (item) { launchSection.appendChild(item); });
      }
    }
  }

  // --- Init ---

  var app = document.querySelector(".app");
  if (app) {
    var sseUrl = app.getAttribute("sse-connect") || "";
    var match = sseUrl.match(/session=([^&]+)/);
    if (match) {
      currentSessionId = match[1];
    }
  }

  updateNeedsAttentionBadge();
  applyStarredState();

  // Hash-based session routing (e.g. #session=<id> from open fallback)
  var hash = window.location.hash;
  if (hash) {
    var sessionMatch = hash.match(/session=([^&]+)/);
    if (sessionMatch && sessionMatch[1]) {
      setTimeout(function () {
        switchSession(sessionMatch[1], { skipEditorFocus: true });
        htmx.ajax("GET", "/sessions/" + sessionMatch[1] + "/detail", "#session-detail");
      }, 200);
    }
  }
})();
