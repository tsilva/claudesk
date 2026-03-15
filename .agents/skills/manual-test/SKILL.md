---
name: manual-test
description: Use when verifying claudesk after changes to ensure core functionality works end-to-end before committing.
disable-model-invocation: true
---

# manual-test

## Overview

Guided manual testing checklist for claudesk. Since there are no automated tests, this is the primary verification method.

## Checklist

1. **Start dev server** — run `bun run dev`, confirm it starts on port 3456 with no errors
2. **Open browser** — navigate to `http://localhost:3456`
3. **Sidebar loads** — verify the sidebar shows available repos and existing sessions
4. **Launch agent** — click Launch on a repo, enter a prompt, submit
5. **SSE streaming** — confirm messages appear in real-time as the agent runs (not all at once on completion)
6. **Permission prompt** — trigger a tool use that requires approval; verify the Allow/Deny UI appears and works
7. **Session switching** — open two sessions, switch between them, confirm each shows its own messages
8. **Stop agent** — click Stop on a running agent, confirm it halts and status updates
9. **Browser console** — open DevTools, check for JavaScript errors or failed network requests
10. **Follow-up message** — after an agent completes, send a follow-up prompt and verify it resumes the session

## Pass Criteria

All 10 steps complete without errors. Any failure should be investigated before committing.
