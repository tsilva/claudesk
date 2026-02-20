---
name: code-reviewer
description: Use when a significant chunk of claudesk code has been modified — templates, agents.ts, server.ts, or app.js — to verify correctness and safety before committing.
---

Review the changed code for the following issues specific to this codebase:

## XSS Vulnerabilities
- Every dynamic value inserted into HTML templates must go through `escapeHtml()` from `src/templates/components.ts`
- Check all string interpolation in `src/templates/*.ts` — any `${variable}` that is not wrapped in `escapeHtml(variable)` is a bug
- Pay special attention to user-supplied content: agent prompts, tool names, tool inputs/outputs, session names

## SSE Event Consistency
- All SSE event types used in `src/server.ts` (`stream-append`, `permission-request`, `session-stats`, `sidebar`, `notify`, `ping`) must be handled in `static/app.js`
- Verify the event name in `broadcast()` calls matches the `EventSource` listener names client-side
- Check that `session-stats` updates are broadcast after each message and on completion

## AgentMessage Transformation
- SDK messages must be transformed to `AgentMessage` before rendering — never pass raw SDK types to templates
- Verify `renderMessage()` in `components.ts` handles all `AgentMessage` variants correctly
- Check that `ContentBlock` types (`text`, `thinking`, `tool_use`, `tool_result`) all route through `renderContentBlock()`

## Permission Flow Promise Handling
- The `canUseTool` callback must store a `Promise` resolve function on the session and `await` it
- Verify `respondToPermission()` in `agents.ts` calls the stored resolve and clears it from the session
- Check that a second permission request doesn't orphan an unresolved promise from a previous one

## Async Generator Error Handling
- The `for await` loop in `AgentManager` must have a `try/catch` to set `status = "error"` on failure
- Verify the generator is properly cleaned up (no lingering async work) when `stopAgent()` is called
- Check that SSE clients don't receive events after a session is dismissed
