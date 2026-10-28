// failing: 0 when every test passed; -1 when the count is unknown. Through Baseline also `new`, the failures
// this push caused, and `old`, those that were red already (pre-existing, flaky or environment)
export type TestResult = { failing: number; new?: number; old?: number }

declare module 'claude-code' {
  interface PluginState {
    'push-guard': { last: TestResult | null; held: string | null; allowed: string | null; baseline: string | null }
  }
}
