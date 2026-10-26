# Changelog

## 0.3.1

- Fixed: `git -C <dir> push`, `cd <dir> && git push` and `cd <dir>; git push` now read
  `<dir>/package.json` and run `npm test` in `<dir>`, the project being pushed. Before, they were
  checked against the folder the session was started in, so the push was judged on the wrong project.
  Relative folders are taken from the session's folder, quoted folders (with spaces) work, and
  several `-C` options combine the way git combines them.
  When the folder can't be told from the command (a `$VARIABLE`, `~`, a wildcard, `cd -`), the session's
  folder is used, as before.
  Reported by u/atp_studio_coll on r/ClaudeCode.
