import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.integration.test.ts",
        "src/acceptance-fixtures/**",
        "src/main.ts",
      ],
      reporter: ["text", "text-summary", "json-summary"],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 75,
        branches: 60,
      },
    },
  },
});
