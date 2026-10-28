# push-guard

A Claude Code plugin that runs `npm test` before Claude runs any `git push`.

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
- The last result shows above the prompt: `push-guard: all tests passing` or
  `push-guard: 2 tests failing` (for checks: `push-guard: typecheck, lint passing`).

It only checks pushes Claude makes. Pushes you type in your own terminal are not checked.

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

each as `npm run <script>`, in the folder being pushed (10 minutes at most each). `build` is not run:
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
  `push-guard: nothing was checked: this project has no test, typecheck or lint script` and the line
  `push-guard: nothing checked (no test, typecheck or lint script)` above the prompt. Claude gets a note on
  the push's result that nothing was checked, so it tells you.
- push-guard does not make up a test command. A project with `node:test` files but no `test` script
  is treated as having no tests.
- The hold for pushes that change existing tests applies on all of these paths.

The option `checks`: `auto` (the default; a mistyped value counts as `auto`), `all` (also `build`),
or `off` (as before: a project with no `test` script is pushed with nothing run and nothing said).
A project that has a `test` script is not affected: only `npm test` runs, as before.

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

How it runs: `baseline check --json --base <B> -- npm test`, in the folder being pushed. `<B>` is what
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

push-guard runs `npm test` as it always did, and any failing test blocks the push, when:

- the option `baseline` is `off`, or Baseline isn't found (then nothing at all changes, not even a note);
- there is nothing new to push (`HEAD` is already on the upstream), or no upstream or remote default
  branch to compare with (a first push);
- Baseline exits 2 (it couldn't run the tests) or 3 (no trusted result on the base commit), says
  UNKNOWN for a test, prints something other than its JSON report, crashes or takes over 10 minutes;
- Baseline can't tell the tests apart (see Limits) and would only judge the whole command;
- the report doesn't hold together: it compares other commits than the push's, its exit code and verdicts
  disagree, or a verdict that would let the push through lacks the runs that show it (a pre-existing
  failure with no failing run on the base commit, a flaky test that never passed, an environment
  failure with no environment class). push-guard never decides on its own that a failure is old.

The block then ends with a line saying why Baseline wasn't used.

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

- For tests, Baseline reads results per test when the `test` script is a plain call to a runner it
  knows (`vitest run`, `jest`, `pytest`, ...). A script with `&&`, a pipe or `VAR=value` in front, or a runner it doesn't know (`node --test`, mocha,
  tap, ava) gets a whole-command answer, which push-guard doesn't use: those projects block on any
  failure, as before.
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
  test), so a push with failing tests takes longer than one `npm test`. If Baseline then fails or times
  out, `npm test` runs once more.
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
