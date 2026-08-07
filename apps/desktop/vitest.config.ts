import { defineConfig } from "vitest/config";

/**
 * Unit tests for the money math only — no component rendering.
 *
 * These cover the pure functions where a wrong number renders as a completely
 * plausible figure: payoff schedules, trend projections, budget flows. A
 * rendering test suite would cost far more and catch far less.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
