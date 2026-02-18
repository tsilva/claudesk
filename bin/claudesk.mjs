#!/usr/bin/env bun
import { join } from "path";
const dir = new URL("..", import.meta.url).pathname;
await Bun.spawn(["bun", join(dir, "src/server.ts"), ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
}).exited;
