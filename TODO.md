# Claudesk Bug Fix TODO

Ranked by ROI (impact vs effort) - highest value fixes first.

## TIER 1: Quick Wins (High Impact, Low Effort)

### 1. XSS Protocol Filter Incomplete ✅
- **File**: `src/markdown.ts:30`
- **Issue**: Only blocks `javascript:` and `data:` protocols; missing `vbscript:`, `file:`, etc.
- **Impact**: Security vulnerability allowing malicious links
- **Effort**: 1 line change
- **Fix**: Expand regex to `/^(javascript|data|vbscript|file):/i`

### 2. Missing Boolean Validation ✅
- **File**: `src/server.ts:437`
- **Issue**: `body.allow` not validated as actual boolean
- **Impact**: API accepts malformed requests
- **Effort**: Add `typeof body.allow === 'boolean'` check
- **Fix**: Add validation before calling `respondToPermission`

## TIER 2: High Impact, Medium Effort

### 3. Footer Injection Logic Error ✅
- **File**: `src/templates/session-detail.ts:15-23`
- **Issue**: Uses `findIndex()` which returns first match in chronological order, but UI displays reverse order - injects footer into wrong message
- **Impact**: UI shows completion stats on wrong message
- **Effort**: Fix array iteration logic
- **Fix**: Use `findLastIndex()` or reverse iteration to find newest assistant message

### 4. Tool Result Matching Bug ✅
- **File**: `src/agents.ts:783-785`
- **Issue**: Searches incrementally-built `contentBlocks` array; tool_results may not find their tool_use if SDK messages arrive out of order
- **Impact**: Tool results display without tool name context
- **Effort**: Two-pass parsing approach
- **Fix**: First pass collect all tool_uses, second pass match tool_results

### 5. Status Race in Plan Approval ✅
- **File**: `src/agents.ts:461-465, 482-489`
- **Issue**: Sets status to "streaming" before async model switch/permission mode changes complete
- **Impact**: UI state inconsistent if async operations fail
- **Effort**: Reorder operations
- **Fix**: Move status change after async operations complete

## TIER 3: Medium Impact, Medium Effort

### 6. Permission Resolution Race Condition
- **File**: `src/agents.ts:402-405`
- **Issue**: Status transition check after `delete()` vulnerable to parallel resolution race conditions
- **Impact**: Session can get stuck in "needs_input" state
- **Effort**: Add synchronization
- **Fix**: Use mutex or queue for permission handling, or atomic check-and-set

### 7. SSE Client Memory Leak
- **File**: `src/server.ts:22-30`
- **Issue**: No heartbeat/timeout mechanism to clean up dead SSE connections
- **Impact**: Long-running server accumulates dead connections
- **Effort**: Add cleanup mechanism
- **Fix**: Add heartbeat timeout (30s) to remove stale clients

### 8. Stream Consumer Error Handling Gap
- **File**: `src/agents.ts:702-709`
- **Issue**: Added null check for `s`, but still checks `s.status` separately which could be inconsistent if session state changes between checks
- **Impact**: Error recovery may fail or show wrong state
- **Effort**: Consolidate checks
- **Fix**: Single read of session state with local variable

## TIER 4: Lower Priority / Refactoring

### 9. Unbounded Message Access
- **File**: `src/agents.ts:650-654`
- **Issue**: `getRecentMessages` loads entire history into memory
- **Impact**: Memory issues with huge conversation histories
- **Effort**: Add pagination or windowing
- **Fix**: Implement message windowing or pagination

### 10. Git Status Cache Stale
- **File**: `src/agents.ts:1131-1139`
- **Issue**: `scanLaunchableRepos` doesn't update `cachedPendingCounts`
- **Impact**: Git badges show stale data
- **Effort**: Sync cache updates
- **Fix**: Update cache after scanning repos

### 11. Type Safety Issues
- **Files**: `src/agents.ts` (multiple locations: 472-476, 485-488, 771, 782, 788-793)
- **Issue**: Multiple `as any` casts bypass TypeScript checking
- **Impact**: Maintainability, potential runtime errors from SDK changes
- **Effort**: Define proper SDK types
- **Fix**: Create type definitions for SDK message structures

## Fixed Issues (Already Resolved)

- ✅ **Timer Cleanup in dismissSession** - `clearTimeout()` now properly called before resolving promises
- ✅ **Stale Closure in File Upload** - IIFE pattern properly captures loop index

---

## Implementation Notes

1. Start with Tier 1 items for immediate security and stability improvements
2. Tier 2 items address user-facing bugs that affect experience
3. Tier 3 items fix race conditions and resource leaks
4. Tier 4 items are code quality improvements for long-term maintainability

## Testing Checklist

After each fix:
- [ ] Run `bun run dev` to verify no TypeScript errors
- [ ] Test the specific functionality that was changed
- [ ] Verify no regressions in session management
- [ ] Check browser console for JavaScript errors
