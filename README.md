# push-guard

A Claude Code plugin that runs the project's tests before Claude runs any `git push`: `npm test`,
or `npm run test:all` when the project has one, plus the `test:*` suites beside `test` (see
[What runs, and for how long](#what-runs-and-for-how-long)).

- If a test fails, the push is blocked and Claude is told which tests failed.
  With Baseline installed, only a failure this push caused blocks it (see [With Baseline](#with-baseline)).
- If the tests pass, the push goes ahead.
- If the project has no `test` script (or only the placeholder `npm init` writes), its own checks
  run instead: `typecheck`, `lint` and the like (see [Projects without a test script](#projects-without-a-test-script)).
  If it has none of those either, the push goes ahead, but you and Claude are told nothing was checked.
  With no `package.json` at all, push-guard does nothing.
- `git -C <dir> push` and `cd <dir> && git push` are checked in `<dir>`, the project being pushed.
  If the folder is written with `~` or a `$VARIABLE`, the session's folder is checked instead.
- If the tests pass but the push changes existing tests, the push is held until you OK it
  (see below).
- Nothing it runs can wait for a person: every command gets `CI=true` and an empty stdin, so jest,
  vitest and Create React App run once instead of watching. A script that still has not finished after
  5 minutes (the option `timeoutMinutes`) blocks the push, saying so.
- The last result shows above the prompt: `push-guard: all tests passing` or
  `push-guard: 2 tests failing` (for checks: `push-guard: typecheck, lint passing`; for more than one
  test script: `push-guard: test, test:api passing`).

It only checks pushes Claude makes. Pushes you type in your own terminal are not checked.

## What runs, and for how long

`npm test` often does not cover the whole project: a `test:api` beside it for the serverless code,
npm workspaces, an `api/` folder with its own `package.json`. With the option `suites` at `auto` (the
default), push-guard runs, in the folder being pushed:

1. `npm run test:all`, if `package.json` has it: the project's own "everything" script, **instead of**
   `npm test`;
2. otherwise `npm test` and each `test:*` script that looks like a suite (`test:api`, `test:unit`,
   `test:integration`, ...), as `npm run <script>`. Left out: names with `watch`, `e2e`, `ui`, `playwright`,
   `cypress`, `storybook`, `coverage`, `update`, `snapshot`, `dev`, `ios`, `android`, `native`, `visual`,
   `bench` or `lint-staged` in them, scripts with `--watch`, and suites the `test` script already runs
   (`npm run test:unit` or `test:*` in it). With no `test` script, the suites alone run as the tests;
3. with `workspaces` in `package.json`, also `npm test --workspaces --if-present`, unless the scripts above
   already run the workspaces (`--workspaces`, `-ws`, turbo, lerna, nx, `pnpm -r`).

push-guard does not run a nested project's tests on its own. When a folder one level down (`api/`) or
in `packages/`, `apps/`, `services/`, `libs/`, `modules/` or `functions/` has a `package.json` with a
`test` script that none of the above covers (a workspace run, or a script that names the folder, like
`cd api && npm test`), you get a toast, Claude gets a note, and the line above the prompt says so:

```
push-guard ran npm test; these test scripts were NOT run: api (api/package.json: test)
```

When a push is blocked, the message lists every script that ran and how it came out
(`push-guard ran: npm test passed, npm run test:api failed.`), then the failures of each one that failed.

**Never waiting.** Every command push-guard runs (the tests, the checks, Baseline) gets `CI=true` and an
empty, closed stdin. Each script then has `timeoutMinutes` (5 by default, 1 to 15) for Baseline and, if
Baseline gives no answer, the plain run together; Claude Code itself stops any one command after 10
minutes. A script that has not finished by then blocks the push:

```
push-guard: npm test did not finish within 5 minutes (watch mode? a hung test?), so the push was blocked.
Run it yourself to see why, or raise the `timeoutMinutes` option.
```

If Baseline used up the time, the script is not run again; if Baseline gave up early, the plain run gets
what is left, at least a minute. After a script that did not finish, the scripts after it are not run
(the push is blocked already). `CI=true` also changes what some tools do: jest refuses to write new
snapshots, for one, which is what a pre-push check wants.

### Options

| Option | Values | Default | What it does |
|---|---|---|---|
| `testChanges` | `block`, `warn`, `off` | `block` | a push that changes existing tests waits for `/push-guard allow`, goes through with a note, or is not looked at |
| `baseline` | `auto`, `off` | `auto` | run the tests through Baseline when it is installed, so only failures this push caused block it |
| `checks` | `auto`, `all`, `off` | `auto` | with no `test` script, run the typecheck, lint and format scripts instead (`all`: also `build`; `off`: nothing) |
| `suites` | `auto`, `root` | `auto` | `auto`: `test:all`, or `test` plus its `test:*` suites, plus workspaces; `root`: only `npm test` (the scripts it leaves out are named, loudly) |
| `timeoutMinutes` | 1 to 15 | 5 | how long each script may take, Baseline and the plain run together; a number outside is brought into the range (a value that is not a number stops Claude Code loading the plugin, so push-guard would be off) |

Set them in Claude Code's plugin settings (`/plugin`), or in `settings.json` under
`"pluginConfigs": { "push-guard": { "options": { "timeoutMinutes": 10 } } }`. A mistyped `testChanges`,
`checks` or `suites` value counts as the safe default.

## Pushes that change tests

A failing test can be made to pass by changing what it expects instead of fixing the code.
So when the tests pass, push-guard also looks at the commits being pushed: from where your branch
left its upstream to `HEAD` (on a new branch with no upstream, from where it left the remote's
default branch; on a first push, every commit).

- If a test file **loses lines, is deleted or is renamed** in those commits, the push is held.
  Claude is told which test files changed, to put a test back if it edited it to pass, and
  otherwise to ask you.
- If test files are only **added, or only gain lines** (new tests), the push goes ahead with a note.

To let a held push through, read the test changes and type, at the prompt:

```
/push-guard allow
```

then ask Claude to push again. Only an OK you type counts: Claude can't give it. The OK is for that one commit: a new commit that changes tests is
held again.

Test files are `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, files named `test.js` or `tests.py` and the like, and
anything in a `test/`, `tests/`, `spec/`, `specs/`, `__tests__/` or `__snapshots__/` folder.
A project can add its own in `package.json`:

```json
"pushGuard": { "testFiles": ["e2e/**", "cypress/**"] }
```

The plugin option `testChanges` sets what happens: `block` (the default) holds the push, `warn`
lets it through with a note, `off` does not look.

### What it does not catch

- It counts lines, it does not read them. A line added to a test that weakens it (an early
  `return`, a new mock, a `skip` on its own line) counts as an addition and goes through with a note.
  Any removed line holds the push, even a harmless one (a reworded test name, a tidy-up).
  A binary test file (an image snapshot, a fixture) has no line count, so any change to one holds
  the push, a new one too.
- Tests outside the names and folders above are not seen unless `package.json` names them.
- It looks at commits, from `HEAD`. A change already on the remote, a push of a branch other than
  the one checked out (`git push origin other`), or tests changed only in the working tree are not
  judged. On a force push it compares from where the branch left its upstream, so rewritten
  commits are still looked at.
- If git can't say what the push changes (no commit yet, a broken repo), the push goes ahead with
  a note rather than being held with nothing to allow.
- `/push-guard allow` only counts when a person runs it: typed at the prompt or sent from the app.
  Run by Claude, another plugin or a script (`claude -p`), it allows nothing. But Claude can still
  switch the `testChanges` option to `warn` or `off`, edit the plugin, or push from your terminal's
  shell some other way push-guard does not see. It is a guard against a quiet test edit, not a lock.

## Projects without a test script

Many projects have no tests but do have checks: a type check, a linter, a format check. Pushing
such a project used to run nothing at all. Now, when `package.json` has no usable `test` script,
push-guard runs whichever of these scripts it has, in this order:

`typecheck`, `type-check`, `tsc`, `lint`, `check`, `format:check`

each as `npm run <script>`, in the folder being pushed (within `timeoutMinutes` each, with `CI=true`). `build` is not run:
it is often slow and may write files or deploy. Set the option `checks` to `all` to run it too, last.

- **Without Baseline**, any check that exits non-zero blocks the push. Claude is told which checks
  failed and which passed, with the last 15 lines of each failing check's output.
- **With Baseline**, each check runs as `baseline check --json --base <B> -- npm run <script>`.
  Baseline reads `tsc`, eslint, `prettier --check` and `next build` output error by error and runs the
  check on the commit the push builds on too. Only errors that are **new** with this push block it.
  Claude gets each new error, and the old ones are only counted. If every error was already there, the
  push goes ahead, with a toast, a note to Claude and `push-guard: typecheck: 0 new, 2 still failing (not yours)`
  above the prompt.
  If Baseline can't read the check error by error, push-guard runs the script itself and blocks on any
  failure, ending with a `push-guard did not use Baseline: <why>` line. That covers a script that is
  not a plain call to one of those tools (`node scripts/check.js`, `tsc && eslint .`), an UNKNOWN
  verdict, and any of the other reasons under [When Baseline is not used](#when-baseline-is-not-used).
- A script npm can't find (`Missing script`) is skipped and never blocks.
- **If there is none of these scripts**, the push goes ahead, but loudly. You get the toast
  `push-guard: nothing was checked: this project has no test, typecheck or lint script` (naming any
  `test:*` scripts it found and does not run, such as `test:e2e`) and the line
  `push-guard: nothing checked (no test, typecheck or lint script)` above the prompt. Claude gets a note on
  the push's result that nothing was checked, so it tells you.
- push-guard does not make up a test command. A project with `node:test` files but no `test` script
  is treated as having no tests.
- The hold for pushes that change existing tests applies on all of these paths.

The option `checks`: `auto` (the default; a mistyped value counts as `auto`), `all` (also `build`),
or `off` (as before: a project with no `test` script is pushed with nothing run and nothing said).
A project that has a `test` script (or `test:all`, or a `test:*` suite) runs its tests instead, as above.

## With Baseline

"Any error and it just fails": a test that was already red before your change, or one that fails
now and then, blocks every push. If Baseline (`baseline check`, which reruns each failing test on the
commit a change builds on) is installed, push-guard runs the tests through it and blocks only on
failures **this push caused**.

| The push's tests | Without Baseline | With Baseline |
|---|---|---|
| all pass | goes ahead | goes ahead (unchanged) |
| one fails that passed before the push (NEW), a new test fails, or a test file no longer loads | blocked | blocked; Claude is told each NEW failure with its evidence (passed n/n runs on the base commit, fails n/n on `HEAD`, the error) and not to call it pre-existing |
| only failures that were already there: PRE-EXISTING (same or changed error), FLAKY, ENVIRONMENT | blocked | goes ahead, with a short list of what is still red and why |
| NEW and old failures together | blocked, all listed | blocked, only the NEW ones listed, the others counted |
| Baseline can't say (see below) | blocked | blocked, as without Baseline, with one line saying why Baseline wasn't used |

How it runs: `baseline check --json --base <B> --timeout <s> -- npm test` (or `-- npm run <script>`, once
per script push-guard runs; any one that says NEW blocks the push), in the folder being pushed, with
`CI=true`. `<s>` is the time budget less 15 seconds, so Baseline stops a hung test command itself. `<B>` is what
the push builds on: where `HEAD` left its upstream (on a new branch, the remote's default branch), the
same commits the test-changes check looks at. Not Baseline's own default, which on `main` with a clean
tree would compare `HEAD` with itself.

When a push goes ahead with tests still red:

- a toast: `push-guard: pushed with 2 tests still red, none from this push: 1 pre-existing (already failing on 76a4782), 1 flaky`,
  then up to three of the tests, one per line;
- the line above the prompt: `push-guard: 0 new, 2 still failing (not yours)` (after a block: `1 new, 2 still failing (not yours)`);
- Claude is told the same, with Baseline's reason per test, as extra context on the `git push` result
  that only the model reads, so it can tell you.

A push that changes existing tests is still held for `/push-guard allow` (see above), also when the only
failures are old ones.

### When Baseline is not used

push-guard runs the script itself as it always did, and any failing test blocks the push, when:

- the option `baseline` is `off`, or Baseline isn't found (then nothing at all changes, not even a note);
- there is nothing new to push (`HEAD` is already on the upstream), or no upstream or remote default
  branch to compare with (a first push);
- Baseline exits 2 (it couldn't run the tests) or 3 (no trusted result on the base commit), says
  UNKNOWN for a test, prints something other than its JSON report, or does not start;
- Baseline can't tell the tests apart (see Limits) and would only judge the whole command, or the report
  fails any of the rules under [How it decides](#how-it-decides).

The block then ends with a line saying why Baseline wasn't used. The plain run gets what is left of the
time budget (at least a minute). If Baseline itself does not finish in time, or stops the test command
at its `--timeout`, the push is blocked as not finished, without a second wait.

### How it decides

A push goes ahead past a failing test only on Baseline's word, and only when the report holds together.
push-guard reads `baseline check --json` (schema 1) and takes its verdicts only if **all** of these hold;
otherwise it runs the script itself and blocks on any failure:

1. the report is Baseline's (`tool`, `schema` 1), its `exit_code` is the process's, and it compares
   exactly the push's commits (`base.sha`, `head.sha`);
2. `runner.per_test` is `true`. A report that judges the whole command (`generic`) is only taken when it
   says the command **passed** on `HEAD` (exit 0, no results): nothing to compare then. Any other
   whole-command answer, NEW, ENVIRONMENT or UNKNOWN, is not used, because one verdict for a whole command
   can hide failures this push caused (a suite that fails on both commits for an environment reason, and
   a new one beside it);
3. each verdict that lets the push through (`pre_existing`, `pre_existing_error_changed`, `flaky`,
   `environment`) is about **one unit**: a `test` or `load_error` from a test runner, or a `check_error`
   from a check Baseline parsed error by error (`runner.check` true: tsc, eslint, `prettier --check`,
   `next build`, and only for a project's check scripts). A `command` unit, `(command)` (a check whose
   output Baseline could not parse) or `(test session)` (the runner crashed) is a whole, and is not taken;
4. that verdict has the runs to show for it: failing on both commits (ENVIRONMENT also needs an
   environment class), or passing and failing on the same commit for FLAKY;
5. every failure Baseline counted on `HEAD` has a verdict: `summary.tests_failed` + `summary.load_errors`
   (for checks, `summary.check_errors`) is not more than the results it lists. A failure left out could be new;
6. the exit code fits the verdicts: exit 1 names a NEW failure, exit 0 names no NEW or UNKNOWN one, and a
   passing test report saw tests pass.

NEW verdicts block the push whatever the unit. push-guard never decides on its own that a failure is old.

### How Baseline is found

Once per session (the answer is kept in the session's state, so a Baseline installed mid-session is
seen in the next session), push-guard takes the first of these that exists and answers
`baseline version` with `baseline <version>` within 5 seconds:

1. `$BASELINE_BIN`, when set: that file and nothing else;
2. `baseline` in each folder of `$PATH`, as Claude Code's own process sees it;
3. `bin/baseline` of a Baseline plugin installed in Claude Code: an entry `baseline@<marketplace>` in
   `plugins/installed_plugins.json` under `$CLAUDE_CONFIG_DIR` (else `~/.claude`). That file is Claude
   Code's own and may change; a Baseline loaded with `--plugin-dir` is not found this way.

The option `baseline`: `auto` (the default) uses Baseline when it is found; `off` never looks for it.

### Limits

- For tests, Baseline reads results per test when the script is a plain call to a runner it
  knows (`vitest run`, `jest`, `node --test`, `pytest`, ...). A script with `&&`, a pipe or `VAR=value` in
  front, Create React App's `react-scripts test`, or a runner it doesn't know (mocha, tap, ava) gets a
  whole-command answer, which push-guard only uses when the command passed: those projects block on
  any failure, as before. A `test:all` that chains suites is such a script.
- For checks (a project with no `test` script), an error counts as old when the same file, code and
  message is reported on the base commit. The line number is not compared, so moving code doesn't make
  an error new, but a second identical error in the same file does. A check that fails on both commits
  for an environment reason (the tool isn't installed) lets the push through as ENVIRONMENT, as a test
  would.
- **FLAKY lets the push through.** A bug this push brings in that fails only some of the time (a race,
  a timing change) looks flaky and goes ahead.
- **ENVIRONMENT lets the push through**: a test failing on both commits for a missing service, variable,
  module or tool. So does **PRE-EXISTING (error changed)**: the test was red before but now fails
  differently, so the push may have made it worse. Both are named in the toast and to Claude.
- The verdicts rest on reruns (by default 5 on `HEAD` and 5 to 10 on the base commit for each failing
  test), so a push with failing tests takes longer than one `npm test`. If Baseline then gives no answer,
  the script runs once more, within what is left of `timeoutMinutes`.
- Baseline runs the tests on the working tree, so uncommitted changes count, as they did before. The
  base commit runs in a temporary git worktree, and Baseline keeps a cache under `.git/baseline/`.
- Baseline's own limits apply: see its `docs/VERDICTS.md` (a flaky test that passes in the full run is
  not reported; jest is parser-tested only; Windows is best effort, and there push-guard finds Baseline
  only through `BASELINE_BIN`).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install push-guard --marketplace seanjohnson-dev/push-guard
```

Answer `y` to add the marketplace, then pick a scope (Enter picks user, so it runs in every session).

From a shell:

```
claude plugin install push-guard --marketplace seanjohnson-dev/push-guard
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with
`seanjohnson-dev/push-guard`, then Add plugin.

## It runs with your access

push-guard runs `npm test` (or, with no `test` script, `npm run` of the check scripts above), and, to see which files a push changes, read-only `git` commands, on your computer, as you, in the project Claude is working in.
That runs whatever those scripts say, with the same access to your files,
network and credentials that you have. With Baseline, the test script of the commit the push builds
on runs too, several times, in a temporary git worktree. Only install it, and only push from projects,
whose scripts you trust. Read `hooks/register.tsx` before installing: it is short.

## Licence

MIT. See [LICENSE](LICENSE).
