# opencode-git-graph

**Branch-colour-coded git history for the OpenCode TUI sidebar.**

`opencode-git-graph` renders your repository's branches and commits in the sidebar as colour-coded sections and opens a diff overlay when you click a commit.

This package works as a **TUI sidebar plugin** for OpenCode.

---

## What you get

- A sidebar section (`Git · <repo-name>`) listing **local branches**, each in its own colour:
  - the current branch uses your theme's primary colour (`◉`);
  - other branches cycle through a palette (`◌`);
- The most recent commits **per branch**, deduplicated across branches, coloured to match their branch;
- A clean head/dirty indicator row (`⑂ <branch>` / `✎ dirty`);
- **Click a commit** to open an overlay with the full commit message, author/date/full hash, and the unified diff (`git show`), with a `… diff truncated` marker for very large diffs;
- Auto-refresh on message/todo/session/file/git events plus a periodic fallback.

## Screenshot

_TBD: add a screenshot of the sidebar and the commit overlay._

---

## Install

Add the plugin to your OpenCode TUI config:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-git-graph"]
}
```

Your TUI config usually lives at:

```txt
~/.config/opencode/tui.json
```

Restart OpenCode after editing the file.

### Install from source (git)

You can also point OpenCode at the plugin file directly:

```json
{
  "plugin": ["/path/to/OpenCode_GitGraph/src/tui.tsx"]
}
```

---

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_GIT_GRAPH_COMMITS` | `10` | Commits shown per branch |
| `OPENCODE_GIT_GRAPH_BRANCHES` | `8` | Branches shown (most recently committed first) |
| `OPENCODE_GIT_GRAPH_REFRESH_MS` | `3000` | Periodic refresh interval |

---

## Requirements

- OpenCode >= 1.14.50 (TUI peer dependency set)
- `git` available on `PATH`

## License

MIT © 2026 Sahil Yousaf

See [LICENSE](./LICENSE).