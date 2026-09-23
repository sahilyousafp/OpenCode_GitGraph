import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { RGBA, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { JSX } from "@opentui/solid/jsx-runtime";
import { createSignal, For, Show } from "solid-js";
import { execFile, execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function abbreviateHome(input: string, home: string): string {
  if (!home || !input) return input;
  const relative = path.relative(home, input);
  if (relative === "") return "~";
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return input;
  }
  return "~" + path.sep + relative;
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

function hasCommand(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function runGitSync(args: string[], cwd: string): string | undefined {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveIdeCommand(cwd: string): string | undefined {
  const envEditor = process.env.VISUAL || process.env.EDITOR;
  if (envEditor) return envEditor;
  const configured = runGitSync(["config", "--get", "core.editor"], cwd);
  if (configured) return configured;
  const candidates = [
    "code",
    "cursor",
    "code-insiders",
    "subl",
    "idea",
    "zed",
    "nvim",
    "vim",
  ];
  for (const candidate of candidates) {
    if (hasCommand(candidate)) return candidate;
  }
  return undefined;
}

async function openDiffInIde(sha: string, cwd: string): Promise<void> {
  const diff = await runGit(
    ["show", "--patch", "--stat", "--find-renames", sha],
    cwd,
  );
  if (diff === undefined) return;
  const file = path.join(
    os.tmpdir(),
    `opencode-commit-${sha.slice(0, 8)}.diff`,
  );
  await writeFile(file, diff, "utf8");

  const editor = resolveIdeCommand(cwd);
  if (editor) {
    const parts = editor.split(/\s+/u).filter(Boolean);
    const child = spawn(parts[0] ?? editor, [...parts.slice(1), file], {
      cwd,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
    return;
  }

  if (process.platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", file], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else if (process.platform === "darwin") {
    const child = spawn("open", [file], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else {
    const child = spawn("xdg-open", [file], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}

export interface CommitInfo {
  sha: string;
  short: string;
  date: string;
  ts: number;
  author: string;
  subject: string;
  parents: string[];
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  current: boolean;
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
  headSha: string;
  dirty: boolean;
  isRepo: boolean;
  isWorktree: boolean;
  worktrees: WorktreeInfo[];
  error: string;
}

function branchColor(
  section: BranchCommitSection,
  theme: TuiThemeCurrent,
): RGBA {
  if (section.current) return theme.primary;
  return BRANCH_COLORS[section.order % BRANCH_COLORS.length];
}

function parseWorktrees(porcelain: string | undefined): WorktreeInfo[] {
  if (!porcelain) return [];
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice("worktree ".length),
        head: "",
        branch: "",
        detached: false,
        current: false,
      };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//u, "");
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.path = `${current.path} (bare)`;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

async function collectRepo(cwd: string): Promise<GitGraphState> {
  const isWorktree =
    (await runGit(["rev-parse", "--is-inside-work-tree"], cwd))?.trim() ===
    "true";
  const headBranch = (
    (await runGit(["branch", "--show-current"], cwd)) ?? ""
  ).trim();
  const headSha = ((await runGit(["rev-parse", "HEAD"], cwd)) ?? "").trim();
  const porcelain = await runGit(["status", "--porcelain"], cwd);
  const dirty =
    !!porcelain && porcelain.split("\n").some((line) => line.trim().length > 0);
  const worktrees = parseWorktrees(
    await runGit(["worktree", "list", "--porcelain"], cwd),
  );
  const cwdResolved = path.resolve(cwd);
  for (const worktree of worktrees) {
    try {
      worktree.current = path.resolve(worktree.path) === cwdResolved;
    } catch {
      worktree.current = false;
    }
  }

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
          `--pretty=format:%H%x1f%h%x1f%ct%x1f%ad%x1f%an%x1f%s%x1f%P`,
          "--date=short",
          name,
        ],
        cwd,
      );
      const commits: CommitInfo[] = [];
      if (out) {
        for (const line of out.split("\n")) {
          const [sha, short, ts, date, author, subject, parents] =
            line.split(FIELD_SEP);
          if (!sha) continue;
          const parsedTs = Number.parseInt(ts ?? "", 10);
          commits.push({
            sha,
            short: short ?? "",
            date: date ?? "",
            ts: Number.isFinite(parsedTs) ? parsedTs : 0,
            author: stripAnsi(author ?? ""),
            subject: stripAnsi(subject ?? ""),
            parents: (parents ?? "")
              .split(/\s+/u)
              .map((parent) => parent.trim())
              .filter(Boolean),
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
    headSha,
    dirty,
    isRepo: isWorktree,
    isWorktree,
    worktrees,
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
  isMerge: boolean;
  isHead: boolean;
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

  sorted.forEach((entry, index) => {
    if (entry.commit.parents.length < 2) return;
    for (const parentSha of entry.commit.parents) {
      const parent = bySha.get(parentSha);
      if (!parent) continue;
      for (const order of parent.lanes) {
        const existing = laneStart.get(order);
        if (existing === undefined || index < existing) {
          laneStart.set(order, index);
        }
      }
    }
  });

  const rows: LogRow[] = sorted.map((entry, index) => {
    const primary = Math.min(...entry.lanes);
    const isMerge = entry.commit.parents.length > 1;
    const bridgeLanes = new Set(entry.lanes);
    if (isMerge) {
      for (const parentSha of entry.commit.parents) {
        const parent = bySha.get(parentSha);
        if (!parent) continue;
        for (const order of parent.lanes) bridgeLanes.add(order);
      }
    }
    const bridgeCols = [...bridgeLanes].sort((a, b) => a - b);
    const minCol = bridgeCols[0] ?? primary;
    const maxCol = bridgeCols[bridgeCols.length - 1] ?? primary;
    const cells: LogCell[] = [];
    const isHead = !!state.headSha && entry.commit.sha === state.headSha;
    for (let col = 0; col < lanes.length; col++) {
      const start = laneStart.get(col);
      if (entry.lanes.includes(col)) {
        cells.push({
          char: isHead ? "\u25c9" : "\u25cf",
          color: lanes[col].color,
        });
      } else if (start !== undefined && index >= start) {
        cells.push({ char: "\u2502", color: lanes[col].color });
      } else {
        cells.push({ char: " " });
      }
    }
    if (bridgeCols.length > 1 || (isMerge && maxCol > minCol)) {
      for (let col = minCol + 1; col < maxCol; col++) {
        if (cells[col]?.char === " " || cells[col]?.char === "\u2502") {
          cells[col] = { char: "\u2500", color: lanes[primary].color };
        }
      }
    }
    return { commit: entry.commit, primary, cells, isMerge, isHead };
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
  const [mergeBase, setMergeBase] = createSignal("");
  let listScroll: ScrollBoxRenderable | undefined;

  const state = () => props.repo();
  const theme = () => props.theme;
  const width = () => Math.min(116, Math.max(40, dimensions().width - 2));
  const layout = () => buildLog(state(), theme());

  // Dialog backdrop pads top by termH/4; cap content at ~0.6*termH (+20% on
  // the old termH/2 cap) so the panel stays centered and never cut off.
  const contentMax = () =>
    Math.max(14, Math.floor(dimensions().height * 0.6) - 2);

  const chromeRows = () => {
    const header = 2;
    const gaps = 3;
    const legend = 5;
    return header + gaps + legend;
  };

  const listHeight = () => {
    const budget = Math.max(6, contentMax() - chromeRows());
    const rows = layout().rows.length;
    return Math.max(6, Math.min(rows || 6, budget));
  };

  const detailWidth = () =>
    Math.max(36, Math.min(56, Math.floor(width() * 0.45)));

  const bodyHeight = () => {
    const row = selected();
    if (!row) return 0;
    const parentLines =
      row.commit.parents.length > 1 ? row.commit.parents.length : 1;
    const baseLines = mergeBase() ? 1 : 0;
    const worktreeLines = showWorktrees()
      ? 4 + worktrees().length
      : 0;
    // meta + subject + parents + merge-base + loading + gaps + worktrees
    const innerChrome = 6 + parentLines + baseLines + worktreeLines;
    return Math.max(2, listHeight() - innerChrome);
  };

  const scrollList = (delta: number) => {
    listScroll?.scrollBy(delta, "viewport");
  };

  const select = (row: LogRow) => {
    setSelected(row);
    setMessage("");
    setMergeBase("");
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
    if (row.commit.parents.length >= 2) {
      const [first, second] = row.commit.parents;
      void runGit(["merge-base", first!, second!], cwd).then((baseSha) => {
        const sha = (baseSha ?? "").trim();
        if (!sha) return;
        void runGit(["log", "-1", "--format=%h %s", sha], cwd).then((info) => {
          setMergeBase((info ?? "").trim());
        });
      });
    }
  };

  const clearSelection = () => setSelected(null);

  const openSelectedDiff = (event?: MouseEvent) => {
    event?.stopPropagation?.();
    const row = selected();
    if (!row) return;
    const cwd =
      props.api.state.path.worktree || props.api.state.path.directory;
    void openDiffInIde(row.commit.sha, cwd);
  };

  const selectedLane = () => {
    const row = selected();
    if (!row) return undefined;
    return layout().lanes.find((lane) => lane.order === row.primary);
  };

  const worktrees = () => state().worktrees;
  const showWorktrees = () => worktrees().length > 1;

  return (
    <box
      flexDirection="column"
      width="100%"
      gap={1}
      maxHeight={contentMax()}
    >
      <box
        flexDirection="row"
        width="100%"
        justifyContent="space-between"
        paddingBottom={1}
      >
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
          <Show when={!state().headBranch && state().headSha}>
            <text selectable={false} flexShrink={0} wrapMode="none" fg={theme().warning}>
              {"  "}
              HEAD → {state().headSha.slice(0, 7)}
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

      <box
        flexDirection="row"
        width="100%"
        gap={2}
        height={listHeight()}
        minHeight={listHeight()}
      >
        <box
          flexDirection="column"
          flexShrink={0}
          height={listHeight()}
          justifyContent="space-between"
          paddingRight={1}
        >
          <box
            onMouseUp={(event) => {
              event?.stopPropagation?.();
              scrollList(-3);
            }}
          >
            <text selectable={false} fg={theme().primary}>
              ▲
            </text>
          </box>
          <box
            onMouseUp={(event) => {
              event?.stopPropagation?.();
              scrollList(3);
            }}
          >
            <text selectable={false} fg={theme().primary}>
              ▼
            </text>
          </box>
        </box>

        <box flexGrow={1} minWidth={0}>
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
            <scrollbox
              width="100%"
              height={listHeight()}
              ref={(el: ScrollBoxRenderable) => {
                listScroll = el;
              }}
            >
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
                      <text
                        selectable={false}
                        flexShrink={0}
                        wrapMode="none"
                        fg={row.isHead ? theme().primary : theme().textMuted}
                      >
                        {" "}
                        {row.isHead ? "→ " : ""}
                        {row.commit.short}
                        {"  "}
                      </text>
                      <Show when={row.isMerge}>
                        <text selectable={false} flexShrink={0} fg={theme().primary}>
                          ⑂{" "}
                        </text>
                      </Show>
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
        </box>

        <Show when={selected()}>
          <box
            width={detailWidth()}
            flexShrink={0}
            height={listHeight()}
            flexDirection="column"
            borderStyle="rounded"
            borderColor={theme().border}
            backgroundColor={theme().backgroundPanel}
            paddingX={1}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
            onMouseUp={(event) => {
              event?.stopPropagation?.();
            }}
          >
            <box flexDirection="row" width="100%" justifyContent="space-between">
              <box flexDirection="row" flexShrink={1} minWidth={0}>
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
                <Show when={selectedLane()}>
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
                <Show when={selected()!.isMerge}>
                  <text selectable={false} flexShrink={0} fg={theme().primary}>
                    {"  "}
                    ⑂ merge
                  </text>
                </Show>
              </box>
              <box flexDirection="row" flexShrink={0} gap={1}>
                <box onMouseUp={(event) => openSelectedDiff(event)}>
                  <text selectable={false} fg={theme().primary}>
                    ↗
                  </text>
                </box>
                <box
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
            </box>
            <text selectable={false} wrapMode="word" fg={theme().text}>
              <b>{selected()!.commit.subject}</b>
            </text>
            <Show when={selected()!.commit.parents.length > 0}>
              <box flexDirection="column" width="100%" gap={0}>
                <For each={selected()!.commit.parents}>
                  {(parent, index) => {
                    const branchNames = state().branches
                      .filter((branch) =>
                        branch.commits.some((c) => c.sha === parent),
                      )
                      .map((branch) => branch.name);
                    const label =
                      selected()!.commit.parents.length > 1
                        ? index() === 0
                          ? "first: "
                          : `merged${index() > 1 ? ` ${index()}` : ""}: `
                        : "parent: ";
                    return (
                      <text selectable={false} wrapMode="none" truncate fg={theme().textMuted}>
                        {label}
                        {parent.slice(0, 7)}
                        {branchNames.length > 0
                          ? ` (${branchNames.join(", ")})`
                          : ""}
                      </text>
                    );
                  }}
                </For>
              </box>
            </Show>
            <Show when={mergeBase()}>
              <text selectable={false} wrapMode="none" truncate fg={theme().textMuted}>
                merge-base: {mergeBase()}
              </text>
            </Show>
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

            <Show when={showWorktrees()}>
              <box
                flexDirection="column"
                width="100%"
                flexShrink={0}
                gap={0}
                borderStyle="rounded"
                borderColor={theme().border}
                backgroundColor={theme().backgroundElement}
                paddingX={1}
                paddingTop={1}
                paddingBottom={1}
              >
                <text selectable={false} wrapMode="none" fg={theme().textMuted}>
                  <b>worktrees</b>
                </text>
                <For each={worktrees()}>
                  {(worktree) => (
                    <text
                      selectable={false}
                      wrapMode="none"
                      truncate
                      fg={worktree.current ? theme().primary : theme().textMuted}
                    >
                      {worktree.current ? "◉ " : "◌ "}
                      {worktree.branch ||
                        (worktree.detached
                          ? "detached"
                          : worktree.head.slice(0, 7))}
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>
      </box>

      <box
        flexDirection="column"
        width="100%"
        gap={1}
        borderStyle="rounded"
        borderColor={theme().border}
        backgroundColor={theme().backgroundElement}
        paddingX={1}
        paddingTop={1}
        paddingBottom={1}
        marginTop={1}
      >
        <text selectable={false} wrapMode="none" fg={theme().textMuted}>
          branches
        </text>
        <box flexDirection="row" width="100%" flexWrap="wrap" gap={2}>
          <For each={layout().lanes}>
            {(lane) => (
              <box flexDirection="row" flexShrink={0}>
                <text selectable={false} wrapMode="none" fg={lane.color}>
                  <b>
                    {lane.current ? "◉" : "◌"} {lane.name}
                  </b>
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
    </box>
  );
}

function createGitGraph(api: TuiPluginApi) {
  const [repo, setRepo] = createSignal<GitGraphState>({
    branches: [],
    headBranch: "",
    headSha: "",
    dirty: false,
    isRepo: false,
    isWorktree: false,
    worktrees: [],
    error: "",
  });
  const [revision, setRevision] = createSignal(0);

  const openGraph = (theme?: TuiThemeCurrent) => {
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
    // replace() resets size to "medium" - set after so xlarge sticks.
    api.ui.dialog.setSize("xlarge");
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
      sidebar_footer(_ctx: unknown, props?: { session_id?: string }) {
        const theme = () => api.theme.current;
        const session = () =>
          props?.session_id
            ? api.state.session.get(props.session_id)
            : undefined;
        const pathInfo = () => {
          const dir =
            session()?.directory ||
            api.state.path.directory ||
            os.homedir();
          const out = abbreviateHome(dir, os.homedir());
          const branch =
            session()?.directory === api.state.path.directory
              ? api.state.vcs?.branch
              : undefined;
          const text = branch ? out + ":" + branch : out;
          const list = text.split("/");
          return {
            parent: list.slice(0, -1).join("/"),
            name: list.at(-1) ?? "",
          };
        };
        return (
          <box flexDirection="column" width="100%" gap={1}>
            <text>
              <span style={{ fg: theme().textMuted }}>
                {pathInfo().parent}/
              </span>
              <span style={{ fg: theme().text }}>{pathInfo().name}</span>
            </text>
            <box
              flexDirection="row"
              width="100%"
              justifyContent="space-between"
              paddingRight={1}
            >
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().success }}>•</span> <b>Open</b>
                <span style={{ fg: theme().text }}>
                  <b>Code</b>
                </span>{" "}
                <span>{api.app.version}</span>
              </text>
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