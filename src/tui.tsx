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
const MAX_GRAPH_COLUMNS = 60;
const MESSAGE_MAX_CHARS = 4000;
const LINE_ALPHA = 140;

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

function fade(color: RGBA, alpha: number): RGBA {
  const faded = RGBA.clone(color);
  faded.a = alpha;
  return faded;
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
    const seen = new Set<string>();
    for (const [index, name] of ordered.slice(0, parseMaxBranches()).entries()) {
      const out = await runGit(
        [
          "log",
          "-n",
          String(parseCommitsPerBranch()),
          "--pretty=format:%H%x1f%h%x1f%ct%x1f%ad%x1f%an%x1f%s",
          "--date=short",
          name,
        ],
        cwd,
      );
      const commits: CommitInfo[] = [];
      if (out) {
        for (const line of out.split("\n")) {
          const [sha, short, ts, date, author, subject] = line.split("\u001f");
          if (!sha || seen.has(sha)) continue;
          seen.add(sha);
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

interface GraphNode {
  commit: CommitInfo;
  lanes: number[];
  primary: number;
  x: number;
  y: number;
  hit: number;
}

interface GraphLane {
  name: string;
  order: number;
  current: boolean;
  color: RGBA;
  y: number;
}

type GraphSeg = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: RGBA;
};

interface GraphLayout {
  lanes: GraphLane[];
  nodes: GraphNode[];
  hy: number;
  truncated: number;
  segments: GraphSeg[];
}

function buildLayout(
  state: GitGraphState,
  width: number,
  theme: TuiThemeCurrent,
): GraphLayout {
  const laneCount = state.branches.length;
  const bySha = new Map<string, GraphNode>();
  for (const branch of state.branches) {
    for (const commit of branch.commits) {
      let node = bySha.get(commit.sha);
      if (!node) {
        node = { commit, lanes: [], primary: 0, x: 0, y: 0, hit: 1 };
        bySha.set(commit.sha, node);
      }
      node.lanes.push(branch.order);
    }
  }

  const nodes = [...bySha.values()].sort(
    (a, b) =>
      a.commit.ts - b.commit.ts || a.commit.sha.localeCompare(b.commit.sha),
  );

  const maxCols = Math.max(16, Math.min(MAX_GRAPH_COLUMNS, width - 4));
  const keepFrom = Math.max(0, nodes.length - maxCols);
  const kept = nodes.slice(keepFrom);
  const truncated = keepFrom;

  const usable = width - 2;
  kept.forEach((node, index) => {
    node.primary = Math.min(...node.lanes);
    node.y = laneCount - node.primary;
    node.x = 1 + Math.round((index * (usable - 1)) / Math.max(1, kept.length - 1));
    const spacing = kept.length > 1 ? (usable - 1) / (kept.length - 1) : 1;
    node.hit = Math.max(1, Math.min(3, Math.round(spacing)));
  });

  const lanes: GraphLane[] = state.branches.map((branch) => ({
    name: branch.name,
    order: branch.order,
    current: branch.current,
    color: branchColor(branch, theme),
    y: laneCount - branch.order,
  }));

  const segments: GraphSeg[] = [];
  for (const lane of lanes) {
    const owned = kept
      .filter((node) => node.primary === lane.order)
      .sort((a, b) => a.x - b.x);
    for (let i = 1; i < owned.length; i++) {
      const prev = owned[i - 1];
      const next = owned[i];
      segments.push({
        x: prev.x,
        y: lane.y,
        w: next.x - prev.x + 1,
        h: 1,
        color: fade(lane.color, LINE_ALPHA),
      });
    }
  }

  for (const node of kept) {
    if (node.lanes.length < 2) continue;
    const ys = node.lanes.map((order) => laneCount - order);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const lane = lanes.find((l) => l.order === node.primary);
    segments.push({
      x: node.x,
      y: bottom,
      w: 1,
      h: Math.max(1, top - bottom + 1),
      color: fade(lane?.color ?? RGBA.fromHex("#888888"), LINE_ALPHA),
    });
  }

  return {
    lanes,
    nodes: kept,
    hy: Math.max(1, laneCount),
    truncated,
    segments,
  };
}

function GraphPoint(props: {
  node: GraphNode;
  color: RGBA;
  selected: boolean;
  onSelect: (node: GraphNode) => void;
}) {
  return (
    <box
      position="absolute"
      left={props.node.x - Math.floor((props.node.hit - 1) / 2)}
      top={props.node.y}
      width={props.node.hit}
      height={1}
      justifyContent="center"
      onMouseUp={(event) => {
        event?.stopPropagation?.();
        props.onSelect(props.node);
      }}
      zIndex={3}
    >
      <box width={1} height={1} backgroundColor={props.color} />
    </box>
  );
}

function GraphWindow(props: {
  api: TuiPluginApi;
  theme: TuiThemeCurrent;
  repo: () => GitGraphState;
  revision: () => number;
}) {
  props.revision();
  const dimensions = useTerminalDimensions();
  const [selected, setSelected] = createSignal<GraphNode | null>(null);
  const [message, setMessage] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  const state = () => props.repo();
  const width = () => Math.min(116, Math.max(40, dimensions().width - 2));
  const layout = () => buildLayout(state(), width(), theme());
  const theme = () => props.theme;

  const select = (node: GraphNode) => {
    setSelected(node);
    setMessage("");
    setLoading(true);
    const cwd =
      props.api.state.path.worktree || props.api.state.path.directory;
    void runGit(["log", "-1", "--format=%B", node.commit.sha], cwd).then(
      (text) => {
        setLoading(false);
        setMessage(stripAnsi(text ?? "").slice(0, MESSAGE_MAX_CHARS));
      },
    );
  };

  const clearSelection = () => setSelected(null);

  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%">
        <text selectable={false} fg={theme().primary}>
          <b>⑂ Git Graph</b>
        </text>
        <Show when={state().headBranch}>
          <text selectable={false} fg={theme().textMuted}>
            {"  "}
            {state().headBranch}
          </text>
        </Show>
        <Show when={state().dirty}>
          <text selectable={false} fg={theme().warning}>
            {"  "}
            ✎ dirty
          </text>
        </Show>
        <text selectable={false} fg={theme().textMuted}>
          {"  "}
          click a point · esc closes
        </text>
      </box>

      <Show
        when={layout().nodes.length > 0}
        fallback={
          <text selectable={false} fg={theme().textMuted}>
            {!state().isRepo
              ? "not a git repo"
              : state().error || "no commits yet"}
          </text>
        }
      >
        <box flexDirection="column" width="100%">
          <box position="relative" width={width()} height={layout().hy}>
            <For each={layout().segments}>
              {(seg) => (
                <box
                  position="absolute"
                  left={seg.x}
                  top={seg.y}
                  width={seg.w}
                  height={seg.h}
                  backgroundColor={seg.color}
                  zIndex={1}
                />
              )}
            </For>
            <For each={layout().nodes}>
              {(node) => {
                const lane = layout().lanes.find(
                  (l) => l.order === node.primary,
                );
                return (
                  <GraphPoint
                    node={node}
                    color={lane?.color ?? theme().textMuted}
                    selected={selected()?.commit.sha === node.commit.sha}
                    onSelect={select}
                  />
                );
              }}
            </For>
          </box>

          <box flexDirection="row" width="100%" flexWrap="wrap">
            <For each={layout().lanes}>
              {(lane) => (
                <box flexDirection="row">
                  <text selectable={false} wrapMode="none" fg={lane.color}>
                    <b>
                      {lane.current ? "◉" : "◌"} {lane.name}
                    </b>
                  </text>
                  <text selectable={false} fg={theme().textMuted}>
                    {"  "}
                  </text>
                </box>
              )}
            </For>
          </box>
          <Show when={layout().truncated > 0}>
            <text selectable={false} fg={theme().warning}>
              … {layout().truncated} older commits hidden
            </text>
          </Show>
        </box>
      </Show>

      <Show when={selected()}>
        <box
          width={width()}
          flexDirection="column"
          borderStyle="rounded"
          borderColor={theme().border}
          backgroundColor={theme().backgroundPanel}
          paddingX={1}
          zIndex={10}
          onMouseUp={(event) => {
            event?.stopPropagation?.();
          }}
        >
          <box flexDirection="row" width="100%">
            <text selectable={false} fg={theme().textMuted}>
              {selected()!.commit.short}
            </text>
            <text selectable={false} fg={theme().textMuted}>
              {"  "}
              {selected()!.commit.author}
            </text>
            <text selectable={false} fg={theme().textMuted}>
              {"  "}
              {selected()!.commit.date}
            </text>
            <box
              onMouseUp={(event) => {
                event?.stopPropagation?.();
                clearSelection();
              }}
            >
              <text selectable={false} fg={theme().warning}>
                {"  "}
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
            <text selectable={false} wrapMode="word" fg={theme().text}>
              {message()}
            </text>
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
    order: 40,
    slots: {
      app_bottom() {
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