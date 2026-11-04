import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees; never run their copies of the tests.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
