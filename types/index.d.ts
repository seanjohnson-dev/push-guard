export type TestResult = { failing: number } // 0 when every test passed; -1 when the count is unknown

declare module 'claude-code' {
  interface PluginState {
    'push-guard': { last: TestResult | null; held: string | null; allowed: string | null }
  }
}
