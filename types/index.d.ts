// failing: 0 when every test passed; -1 when the count is unknown. Through Baseline also `new`, the failures
// this push caused, and `old`, those that were red already (pre-existing, flaky or environment). For a project
// with no `test` script: `checks`, the check scripts that ran (failing counts their errors), `failed`, those
// that blocked the push; `nothing` when there was nothing to run. `checks` and `failed` also name the test
// scripts when more than `test` ran (test, test:api). `notRun`: test scripts found and not run (api, test:api);
// `timedOut` when a command did not finish within `timeoutMinutes`
export type TestResult = {
  failing: number; new?: number; old?: number; checks?: string[]; failed?: string[]; nothing?: boolean; notRun?: string[]; timedOut?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'push-guard': { last: TestResult | null; held: string | null; allowed: string | null; baseline: string | null }
  }
}
