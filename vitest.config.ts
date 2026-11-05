import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees and evidence copies under .artifacts; never run
    // their copies of the tests. Tests that launch Chromium run with `npm run test:browser`, so
    // `npm test` works inside a sandbox that cannot start a browser.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", ".artifacts/**", "test/browser/**"],
  },
});
