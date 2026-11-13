import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only *.test.ts are suites; helpers/ holds shared harness code.
    include: ["src/**/__tests__/**/*.test.ts"],
    // jsdom has no structuredClone, but Vitest keeps Node's, which throws for
    // uncloneable values as a browser does. The multi-tab bus relies on that.
    environment: "jsdom",
  },
});
