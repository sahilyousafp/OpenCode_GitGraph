import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { RGBA } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { JSX } from "@opentui/solid/jsx-runtime";
import { createSignal, For, Show } from "solid-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLUGIN_ID = "git-graph";
const REFRESH_EVENTS = [
  "message.part.updated",
  "todo.updated",
  "session.updated",
  "session.idle",
  "file.edited",
  "vcs.branch.updated",
] as const;
const GIT_TIMEOUT_MS = 5000;
const COMMITS_PER_BRANCH = 10;
const MAX_BRANCHES = 8;
const MESSAGE_MAX_CHARS = 4000;
const FIELD_SEP = String.fromCharCode(31);

const BRANCH_COLORS = [
  "#5b9bf5",
  "#40c9a2",
  "#f2815a",
  "#b48ef7",
  "#f76b6b",
  "#e2c15c",
  "#53c8f5",
  "#f79ad0",
].map((hex) => RGBA.fromHex(hex));

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCommitsPerBranch(): number {
  return parsePositiveInt(
    process.env.OPENCODE_GIT_GRAPH_COMMITS,
    COMMITS_PER_BRANCH,
  );
}

function parseMaxBranches(): number {
  return parsePositiveInt(
    process.env.OPENCODE_GIT_GRAPH_BRANCHES,
    MAX_BRANCHES,
  );
}

function parseRefreshMs(): number {
  return parsePositiveInt(process.env.OPENCODE_GIT_GRAPH_REFRESH_MS, 3000);
}

export function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/gu, "");
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

export interface CommitInfo {
  sha: string;
  short: string;
  date: string;
  ts: number;
  author: string;
  subject: string;
}

export type BranchCommitSection = {
  name: string;
  order: number;
  current: boolean;
  commits: CommitInfo[];
};

export interface GitGraphState {
  branches: BranchCommitSection[];
  headBranch: string;
  dirty: boolean;
  isRepo: boolean;
  isWorktree: boolean;
  error: string;
}

function branchColor(
  section: BranchCommitSection,
  theme: TuiThemeCurrent,
): RGBA {
  if (section.current) return theme.primary;
  return BRANCH_COLORS[section.order % BRANCH_COLORS.length];
}

async function collectRepo(cwd: string): Promise<GitGraphState> {
  const isWorktree =
    (await runGit(["rev-parse", "--is-inside-work-tree"], cwd))?.trim() ===
    "true";
  const headBranch = (
    (await runGit(["branch", "--show-current"], cwd)) ?? ""
  ).trim();
  const porcelain = await runGit(["status", "--porcelain"], cwd);
  const dirty =
    !!porcelain && porcelain.split("\n").some((line) => line.trim().length > 0);

  const branches: BranchCommitSection[] = [];
  let error = "";
  const refs = await runGit(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    cwd,
  );
  const names = refs
    ? refs
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];

  if (isWorktree && names.length === 0) {
    error = "no branches";
  }
  if (names.length > 0) {
    const ordered = headBranch
      ? [headBranch, ...names.filter((name) => name !== headBranch)]
      : names;
    for (const [index, name] of ordered.slice(0, parseMaxBranches()).entries()) {
      const out = await runGit(
        [
          "log",
          "-n",
          String(parseCommitsPerBranch()),
          `--pretty=format:%H%x1f%h%x1f%ct%x1f%ad%x1f%an%x1f%s`,
          "--date=short",
          name,
        ],
        cwd,
      );
      const commits: CommitInfo[] = [];
      if (out) {
        for (const line of out.split("\n")) {
          const [sha, short, ts, date, author, subject] = line.split(FIELD_SEP);
          if (!sha) continue;
          const parsedTs = Number.parseInt(ts ?? "", 10);
          commits.push({
            sha,
            short: short ?? "",
            date: date ?? "",
            ts: Number.isFinite(parsedTs) ? parsedTs : 0,
            author: stripAnsi(author ?? ""),
            subject: stripAnsi(subject ?? ""),
          });
        }
      }
      branches.push({
        name,
        order: index,
        current: name === headBranch,
        commits,
      });
    }
  }

  return {
    branches,
    headBranch,
    dirty,
    isRepo: isWorktree,
    isWorktree,
    error,
  };
}

export interface LogLane {
  name: string;
  order: number;
  current: boolean;
  color: RGBA;
}

export interface LogCell {
  char: string;
  color?: RGBA;
}

export interface LogRow {
  commit: CommitInfo;
  primary: number;
  cells: LogCell[];
}

export interface LogLayout {
  lanes: LogLane[];
  rows: LogRow[];
}

function buildLog(state: GitGraphState, theme: TuiThemeCurrent): LogLayout {
  const bySha = new Map<string, { commit: CommitInfo; lanes: number[] }>();
  for (const branch of state.branches) {
    for (const commit of branch.commits) {
      let entry = bySha.get(commit.sha);
      if (!entry) {
        entry = { commit, lanes: [] };
        bySha.set(commit.sha, entry);
      }
      if (!entry.lanes.includes(branch.order)) {
        entry.lanes.push(branch.order);
      }
    }
  }

  const sorted = [...bySha.values()].sort(
    (a, b) =>
      b.commit.ts - a.commit.ts || a.commit.sha.localeCompare(b.commit.sha),
  );

  const lanes: LogLane[] = state.branches.map((branch) => ({
    name: branch.name,
    order: branch.order,
    current: branch.current,
    color: branchColor(branch, theme),
  }));

  const laneStart = new Map<number, number>();
  sorted.forEach((entry, index) => {
    for (const order of entry.lanes) {
      if (!laneStart.has(order)) laneStart.set(order, index);
    }
  });

  const rows: LogRow[] = sorted.map((entry, index) => {
    const primary = Math.min(...entry.lanes);
    const minCol = Math.min(...entry.lanes);
    const maxCol = Math.max(...entry.lanes);
    const cells: LogCell[] = [];
    for (let col = 0; col < lanes.length; col++) {
      const start = laneStart.get(col);
      if (entry.lanes.includes(col)) {
        cells.push({ char: "\u25cf", color: lanes[col].color });
      } else if (start !== undefined && index >= start) {
        cells.push({ char: "\u2502", color: lanes[col].color });
      } else {
        cells.push({ char: " " });
      }
    }
    if (entry.lanes.length > 1) {
      for (let col = minCol + 1; col < maxCol; col++) {
        if (cells[col].char === " ") {
          cells[col] = { char: "\u2500", color: lanes[primary].color };
        }
      }
    }
    return { commit: entry.commit, primary, cells };
  });

  return { lanes, rows };
}

function GraphWindow(props: {
  api: TuiPluginApi;
  theme: TuiThemeCurrent;
  repo: () => GitGraphState;
  revision: () => number;
}) {
  props.revision();
  const dimensions = useTerminalDimensions();
  const [selected, setSelected] = createSignal<LogRow | null>(null);
  const [message, setMessage] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const state = () => props.repo();
  const theme = () => props.theme;
  const width = () => Math.min(116, Math.max(40, dimensions().width - 2));
  const layout = () => buildLog(state(), theme());

  const listHeight = () => {
    const detailRows = selected() ? 10 : 0;
    return Math.max(
      6,
      Math.min(layout().rows.length, dimensions().height - 8 - detailRows),
    );
  };

  const bodyRows = () => {
    const charsPerLine = Math.max(40, width() - 4);
    return Math.max(1, Math.ceil(message().length / charsPerLine));
  };

  const bodyHeight = () => {
    const maxRows = Math.max(4, Math.floor(dimensions().height / 3));
    return Math.min(Math.max(bodyRows(), 2), maxRows);
  };

  const select = (row: LogRow) => {
    setSelected(row);
    setMessage("");
    setLoading(true);
    const cwd =
      props.api.state.path.worktree || props.api.state.path.directory;
    void runGit(["log", "-1", "--format=%B", row.commit.sha], cwd).then(
      (text) => {
        setLoading(false);
        const full = stripAnsi(text ?? "");
        const newline = full.indexOf("\n");
        const firstLine = newline >= 0 ? full.slice(0, newline) : full;
        const rest = newline >= 0 ? full.slice(newline + 1) : "";
        const body =
          firstLine.trim() === row.commit.subject
            ? rest.trim()
            : full.trim();
        setMessage(body.slice(0, MESSAGE_MAX_CHARS));
      },
    );
  };

  const clearSelection = () => setSelected(null);

  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%" justifyContent="space-between">
        <box flexDirection="row" flexShrink={1}>
          <text selectable={false} flexShrink={0} wrapMode="none" fg={theme().primary}>
            <b>⑂ Git Graph</b>
          </text>
          <Show when={state().headBranch}>
            <text selectable={false} flexShrink={1} truncate wrapMode="none" fg={theme().textMuted}>
              {"  "}
              {state().headBranch}
            </text>
          </Show>
          <Show when={state().dirty}>
            <text selectable={false} flexShrink={0} wrapMode="none" fg={theme().warning}>
              {"  "}
              ✎ dirty
            </text>
          </Show>
        </box>
        <text selectable={false} flexShrink={0} wrapMode="none" fg={theme().textMuted}>
          click a commit · esc closes
        </text>
      </box>

      <box flexDirection="row" width="100%" flexWrap="wrap">
        <For each={layout().lanes}>
          {(lane) => (
            <box flexDirection="row" flexShrink={0} paddingRight={2}>
              <text selectable={false} wrapMode="none" fg={lane.color}>
                <b>
                  {lane.current ? "◉" : "◌"} {lane.name}
                </b>
              </text>
            </box>
          )}
        </For>
      </box>

      <Show
        when={layout().rows.length > 0}
        fallback={
          <text selectable={false} fg={theme().textMuted}>
            {!state().isRepo
              ? "not a git repo"
              : state().error || "no commits yet"}
          </text>
        }
      >
        <scrollbox width="100%" height={listHeight()}>
          <For each={layout().rows}>
            {(row) => {
              const isSelected = () =>
                selected()?.commit.sha === row.commit.sha;
              return (
                <box
                  flexDirection="row"
                  width="100%"
                  onMouseUp={(event) => {
                    event?.stopPropagation?.();
                    select(row);
                  }}
                >
                  <box flexDirection="row" flexShrink={0}>
                    <For each={row.cells}>
                      {(cell) => (
                        <text selectable={false} fg={cell.color ?? theme().textMuted}>
                          {cell.char}
                        </text>
                      )}
                    </For>
                  </box>
                  <text selectable={false} flexShrink={0} fg={theme().textMuted}>
                    {" "}
                    {row.commit.short}
                    {"  "}
                  </text>
                  <text
                    selectable={false}
                    flexShrink={1}
                    truncate
                    wrapMode="none"
                    fg={isSelected() ? theme().primary : theme().text}
                  >
                    {row.commit.subject}
                  </text>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </Show>

      <Show when={selected()}>
        <box
          width="100%"
          flexDirection="column"
          borderStyle="rounded"
          borderColor={theme().border}
          backgroundColor={theme().backgroundPanel}
          paddingX={1}
          onMouseUp={(event) => {
            event?.stopPropagation?.();
          }}
        >
          <box flexDirection="row" width="100%">
            <text selectable={false} flexShrink={0} fg={theme().textMuted}>
              {selected()!.commit.short}
            </text>
            <text selectable={false} flexShrink={1} truncate wrapMode="none" fg={theme().textMuted}>
              {"  "}
              {selected()!.commit.author}
            </text>
            <text selectable={false} flexShrink={0} fg={theme().textMuted}>
              {"  "}
              {selected()!.commit.date}
            </text>
            <Show
              when={(() => {
                const row = selected();
                if (!row) return undefined;
                return layout().lanes.find(
                  (lane) => lane.order === row.primary,
                );
              })()}
            >
              {(lane: LogLane) => (
                <text
                  selectable={false}
                  flexShrink={1}
                  truncate
                  wrapMode="none"
                  fg={lane.color}
                >
                  {"  "}
                  ◉ {lane.name}
                </text>
              )}
            </Show>
            <box flexShrink={0}>
              <text selectable={false} fg={theme().warning}>
                {"  "}
                ⊗
              </text>
            </box>
            <box
              flexShrink={0}
              onMouseUp={(event) => {
                event?.stopPropagation?.();
                clearSelection();
              }}
            >
              <text selectable={false} fg={theme().warning}>
                ⊗
              </text>
            </box>
          </box>
          <text selectable={false} wrapMode="word" fg={theme().text}>
            <b>{selected()!.commit.subject}</b>
          </text>
          <Show when={loading()}>
            <text selectable={false} fg={theme().textMuted}>
              loading message…
            </text>
          </Show>
          <Show
            when={message()}
            fallback={
              <Show when={!loading()}>
                <text selectable={false} fg={theme().textMuted}>
                  (no message body)
                </text>
              </Show>
            }
          >
            <scrollbox width="100%" height={bodyHeight()}>
              <text selectable={false} wrapMode="word" fg={theme().text}>
                {message()}
              </text>
            </scrollbox>
          </Show>
        </box>
      </Show>
    </box>
  );
}

function createGitGraph(api: TuiPluginApi) {
  const [repo, setRepo] = createSignal<GitGraphState>({
    branches: [],
    headBranch: "",
    dirty: false,
    isRepo: false,
    isWorktree: false,
    error: "",
  });
  const [revision, setRevision] = createSignal(0);

  const openGraph = (theme?: TuiThemeCurrent) => {
    api.ui.dialog.setSize("xlarge");
    api.ui.dialog.replace(
      () => (
        <GraphWindow
          api={api}
          theme={theme ?? api.theme.current}
          repo={repo}
          revision={revision}
        />
      ),
      () => undefined,
    );
  };

  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const cwd = api.state.path.worktree || api.state.path.directory;
      setRepo(await collectRepo(cwd));
    } catch {
      // keep last good state
    } finally {
      refreshing = false;
      setRevision((value) => value + 1);
    }
  };

  let pending: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      refresh();
    }, 250);
  };

  const unsubscribers = REFRESH_EVENTS.map((type) =>
    api.event.on(type, scheduleRefresh),
  );
  const interval = setInterval(scheduleRefresh, parseRefreshMs());
  api.lifecycle.onDispose(() => {
    if (pending) clearTimeout(pending);
    clearInterval(interval);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
  refresh();

  return {
    order: 50,
    slots: {
      sidebar_footer() {
        const theme = () => api.theme.current;
        return (
          <box
            flexDirection="row"
            width="100%"
            justifyContent="flex-end"
            paddingRight={1}
          >
            <box
              onMouseUp={(event) => {
                event?.stopPropagation?.();
                openGraph(theme());
              }}
            >
              <text selectable={false} fg={theme().primary}>
                <u>⑂ Git Graph</u>
              </text>
            </box>
          </box>
        );
      },
    },
    openGraph,
  };
}

const tui: TuiPlugin = async (api) => {
  const git = createGitGraph(api);
  api.slots.register(git);
  const dispose = api.keymap.registerLayer({
    commands: [
      {
        name: "git-graph.open",
        title: "Open git graph",
        slashName: "gitgraph",
        category: "VCS",
        namespace: "palette",
        run() {
          git.openGraph(api.theme.current);
        },
      },
    ],
  });
  api.lifecycle.onDispose(() => {
    dispose?.();
  });
};

const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;