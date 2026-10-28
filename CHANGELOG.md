# Changelog

## 0.5.0

- New: with Baseline installed, a push is blocked only by test failures it caused. push-guard runs
  `baseline check --json --base <B> -- npm test`, `<B>` being where `HEAD` left its upstream (or the
  remote's default branch). NEW failures, NEW load errors included, block the push, each listed with
  its evidence. Failures that were already there (pre-existing, pre-existing with a changed error,
  flaky, environment) let it through, with a short toast, `0 new, 3 still failing (not yours)` above
  the prompt, and a note to Claude on the push's result.
- Whenever Baseline can't answer clearly (exit 2 or 3, UNKNOWN, output that isn't its JSON report, a
  crash or timeout, a runner it can't read per test, a verdict without the runs to show for it, nothing
  new to push, a first push), push-guard runs `npm test` as before and blocks on any failure, adding a
  line saying why Baseline wasn't used.
- New: the `baseline` option, `auto` (default) or `off`. Baseline is found once per session through
  `BASELINE_BIN`, `$PATH`, or an installed Baseline plugin; without it nothing changes.
- The hold for pushes that change existing tests still applies, also when the only failures are old.
- New: projects with no npm `test` script are no longer pushed unchecked. Their `typecheck`,
  `type-check`, `tsc`, `lint`, `check` and `format:check` scripts run instead (`npm run <script>`, in
  that order). Without Baseline, any failing check blocks the push, with the last lines of its output.
  With Baseline, each runs as `baseline check --json --base <B> -- npm run <script>` and only errors new
  with this push block it. A check Baseline can't read error by error runs as is, and any failure blocks.
  A missing script never blocks. With none of these scripts, the push goes ahead loudly: a toast
  (`push-guard: nothing was checked: ...`), a note to Claude and a line above the prompt. The new option
  `checks` is `auto` (default), `all` (also `build`) or `off` (as before: nothing run). The line above the
  prompt names the checks (`push-guard: typecheck, lint passing`). Projects with a `test` script are
  unchanged.
- Limits: Baseline judges per test only runners it reads (vitest, jest including `react-scripts test`
  and `craco test`, `node --test`, pytest and others). A chained script is judged part by part; a part
  with `||`, a pipe, `$(...)` or a redirect is not judged, and then push-guard runs the script and blocks
  on any failure. Other runners (mocha, tap, ava, `make test`) get a whole-command answer, used only when
  the command passed. Flaky and environment failures go through. See "With Baseline" in the README.
- Fixed: a push could hang for 20 minutes. `npm test` in Create React App (and jest/vitest watch scripts)
  waits for input unless `CI=true`, and push-guard waited 10 minutes for Baseline and then 10 more for
  `npm test`. Every command push-guard runs (tests, checks, Baseline) now gets `CI=true` and an empty,
  closed stdin. New option `timeoutMinutes` (default 5, 1 to 15; above 15 counts as 15, between 0 and 1
  as 1, 0 or less as 5): one budget per script for Baseline and the plain run together. Baseline gets
  `--timeout` just under it. A script that doesn't finish blocks
  the push with `push-guard: <command> did not finish within N minutes (watch mode? a hung test?), so the
  push was blocked. Run it yourself to see why, or raise the timeoutMinutes option.`; if Baseline used up
  the time, the script is not run a second time. On a project whose `npm test` starts watch mode, with
  `CI` unset, push-guard before the fix hung (Baseline's 10-minute limit ran out, then a second 10-minute
  `npm test`; the session was cut off after about 13 minutes); after the fix it blocked in 86s with
  "26 failures are new with this push" (Baseline took 70.1s of that).
- Fixed: a push that broke only code `npm test` doesn't cover went through silently. With the new option
  `suites` at `auto` (default), push-guard runs `test:all` when `package.json` has one, instead of `test`;
  otherwise `test` plus the `test:*` scripts that look like suites (not watch, e2e, UI, coverage, snapshot,
  device or benchmark ones, nor ones `test` already runs); with npm workspaces also
  `npm test --workspaces --if-present`. With Baseline, each runs as its own `baseline check`. A folder
  one or two levels down (`api/`, `packages/*`, `apps/*`) with a `test` script nothing ran is named in a
  toast, a note to Claude, the deny and the line above the prompt:
  `push-guard ran npm test; these test scripts were NOT run: api (api/package.json: test)`. `suites: root`
  runs only `npm test` and names the suites it left out.
- Baseline reports are trusted less: a verdict that lets a push through must be about one test, load
  error or (for a parsed check) check error. Whole-command, `(command)` and `(test session)` verdicts,
  units of the wrong kind for the runner, and reports whose summary counts more failures on `HEAD`
  than they give verdicts for make push-guard run the script itself (blocking on any failure). A
  whole-command report that says the command passed is taken as a pass, so it isn't run twice. The rules
  are in "How it decides" in the README.
- Fixed: a chained `test:all` (`react-scripts test && jest --config jest.api.config.js && npm run check:x`)
  could be pushed with a break in a later part when Baseline reported only the first part clean. push-guard
  now reads Baseline's chain report (`runner.name` `chain`, `runner.parts`, `part` on each result) part by
  part with the same rules as any report: a NEW failure in any trusted part blocks (listed with its part),
  and the chain is let through only when every part was judged and every part's report holds up;
  otherwise the script runs as is and blocks on any failure. On a push that broke only the api code of a
  Create React App project (local bare remote, real headless Claude session), push-guard before the fix
  pushed silently; after the fix it blocked with "part 2 ... passed 5/5 runs on <sha>, fails 5/5 runs on
  HEAD", the remote unchanged, and Baseline answered in 23.9s.
- Messages name every script that ran and how it came out (`push-guard ran: npm test passed, npm run
  test:api failed.`); the nothing-checked toast names the `test:*` scripts it found and did not run.
- Tests now run with `claude plugin test` (165 pass, up from 157, with 8 new for chained scripts in
  `hooks/baseline.test.ts`); three "no test script" tests had a fixture that still gave them a `test` script.

## 0.4.0

- New: a push whose commits change existing tests is held, even when the tests pass. When a test
  file loses lines, is deleted or is renamed between where the branch left its upstream (or the
  remote's default branch, for a new branch) and `HEAD`, Claude is told which files changed and to
  ask you. Type `/push-guard allow` to let that commit through; it only counts when a person runs
  it, not Claude, another plugin or `claude -p`. New test files, and lines only added
  to a test file, go through with a note.
- New: the `testChanges` option: `block` (default), `warn` or `off`.
- New: `"pushGuard": { "testFiles": [globs] }` in `package.json` adds a project's own test paths
  (`*`, `?` and `**`).
- Limits: it counts removed lines, it does not read them; tests outside the usual names and folders
  are not seen unless named; only the checked-out branch's commits are judged. See the README.
  Suggested by u/kaijurules on r/ClaudeCode.

## 0.3.1

- Fixed: `git -C <dir> push`, `cd <dir> && git push` and `cd <dir>; git push` now read
  `<dir>/package.json` and run `npm test` in `<dir>`, the project being pushed. Before, they were
  checked against the folder the session was started in, so the push was judged on the wrong project.
  Relative folders are taken from the session's folder, quoted folders (with spaces) work, and
  several `-C` options combine the way git combines them.
  When the folder can't be told from the command (a `$VARIABLE`, `~`, a wildcard, `cd -`), the session's
  folder is used, as before.
  Reported by u/atp_studio_coll on r/ClaudeCode.
