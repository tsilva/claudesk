---
name: typecheck
description: Use when TypeScript errors may have been introduced, after editing .ts files, or when debugging unexpected runtime behavior that could be a type mismatch.
---

# typecheck

## Overview

Run TypeScript type checking on the project to catch type errors before they reach runtime.

## Steps

1. Run: `bunx tsc --noEmit`
2. Report any type errors found with file path and line number
3. If errors are found and they are in code you modified, fix them
4. Re-run to confirm clean

## Notes

- `--noEmit` checks types without producing output files (no build step needed)
- This project has `strict: true` in `tsconfig.json` — all strict checks are active
- Bun runs TypeScript directly, so type errors won't prevent startup, but they indicate real bugs
