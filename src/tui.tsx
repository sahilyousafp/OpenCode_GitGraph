import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { RGBA, StyledText, TextChunk } from "@opentui/core";
import { createSignal, For, Show } from "solid-js";
import { execFile } from "node:child_process";
import { basename } from "node:path";
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
const KV_EXPANDED = "git-graph.sidebar.expanded";
const GIT_TIMEOUT_MS = 5000;
const DIFF_MAX_CHARS = 12000;

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
  return parsePositiveInt(process.env.OPENCODE_GIT_GRAPH_COMMITS, 10);
}

function parseMaxBranches(): number {
  return parsePositiveInt(process.env.OPENCODE_GIT_GRAPH_BRANCHES, 8);
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
    const limit = parseCommitsPerBranch();
    const seen = new Set<string>();
    for (const [index, name] of ordered.slice(0, parseMaxBranches()).entries()) {
      const out = await runGit(
        [
          "log",
          "-n",
          String(limit),
          "--pretty=format:%H%x1f%h%x1f%ad%x1f%an%x1f%s",
          "--date=short",
          name,
        ],
        cwd,
      );
      const commits: CommitInfo[] = [];
      if (out) {
        for (const line of out.split("\n")) {
          const [sha, short, date, author, subject] = line.split("\u001f");
          if (!sha || seen.has(sha)) continue;
          seen.add(sha);
          commits.push({
            sha,
            short: short ?? "",
            date: date ?? "",
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

function commitRowContent(
  commit: CommitInfo,
  color: RGBA,
  theme: TuiThemeCurrent,
): StyledText {
  const chunks: TextChunk[] = [
    { __isChunk: true, text: "  ", fg: theme.textMuted },
    { __isChunk: true, text: commit.subject, fg: color },
    { __isChunk: true, text: ` ${commit.date}`, fg: theme.textMuted },
  ];
  return new StyledText(chunks);
}

function CommitDialog(props: {
  api: TuiPluginApi;
  theme: TuiThemeCurrent;
  commit: CommitInfo;
  branchName: string;
  branchColor: RGBA;
}) {
  const [message, setMessage] = createSignal("");
  const [diff, setDiff] = createSignal("");
  let loaded = false;

  const load = async () => {
    if (loaded) return;
    loaded = true;
    const cwd =
      props.api.state.path.worktree || props.api.state.path.directory;
    const [log, patch] = await Promise.all([
      runGit(["log", "-1", "--format=%B", props.commit.sha], cwd),
      runGit(["show", "--format=", "--no-color", props.commit.sha], cwd),
    ]);
    setMessage(stripAnsi(log ?? ""));
    setDiff(stripAnsi(patch ?? "").slice(0, DIFF_MAX_CHARS));
  };
  void load();

  const truncated = () =>
    diff().length >= DIFF_MAX_CHARS;

  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%">
        <text selectable={false} fg={props.branchColor}>
          <b>{props.branchName}</b>
        </text>
        <text selectable={false} fg={props.theme.textMuted}>
          {"  "}
          {props.commit.short}
        </text>
        <text selectable={false} fg={props.theme.textMuted}>
          {"  "}
          esc to close
        </text>
      </box>
      <text selectable={false} wrapMode="word" fg={props.theme.text}>
        <b>{props.commit.subject}</b>
      </text>
      <box flexDirection="row" width="100%">
        <text selectable={false} fg={props.theme.textMuted}>
          {props.commit.author}
        </text>
        <text selectable={false} fg={props.theme.textMuted}>
          {"  "}
          {props.commit.date}
        </text>
        <text selectable={false} fg={props.theme.textMuted}>
          {"  "}
          {props.commit.sha}
        </text>
      </box>
      <Show when={message()}>
        <text selectable={false} wrapMode="word" fg={props.theme.text}>
          {message()}
        </text>
      </Show>
      <Show when={diff()}>
        <box
          flexDirection="column"
          width="100%"
          paddingTop={0}
          borderStyle="rounded"
          borderColor={props.theme.borderSubtle}
        >
          <diff diff={diff()} view="unified" wrapMode="word" />
          <Show when={truncated()}>
            <text selectable={false} fg={props.theme.warning}>
              … diff truncated
            </text>
          </Show>
        </box>
      </Show>
    </box>
  );
}

function CollapsibleHeader(props: {
  expanded: () => boolean;
  label: string;
  color: string | RGBA;
  onToggle: () => void;
}) {
  return (
    <box
      flexDirection="row"
      width="100%"
      onMouseDown={(event) => {
        event?.stopPropagation?.();
        props.onToggle();
      }}
    >
      <text selectable={false} fg={props.color}>
        {props.expanded() ? "▼" : "▶"}
      </text>
      <text selectable={false} fg={props.color}>
        <b>{props.label}</b>
      </text>
    </box>
  );
}

function GitGraphPanel(props: {
  api: TuiPluginApi;
  context: TuiSlotContext;
  repo: () => GitGraphState;
  revision: () => number;
  sidebarExpanded: () => boolean;
  toggleSidebar: () => void;
}) {
  props.revision();
  const theme = () => props.context.theme.current;

  const openCommit = (section: BranchCommitSection, commit: CommitInfo) => {
    props.api.ui.dialog.setSize("xlarge");
    props.api.ui.dialog.replace(
      () => (
        <CommitDialog
          api={props.api}
          theme={theme()}
          commit={commit}
          branchName={section.name}
          branchColor={branchColor(section, theme())}
        />
      ),
      () => undefined,
    );
  };

  return (
    <box
      flexDirection="column"
      width="100%"
      borderStyle="rounded"
      paddingLeft={1}
      paddingRight={1}
      borderColor={theme().border}
    >
      <CollapsibleHeader
        expanded={props.sidebarExpanded}
        label={`Git · ${basename(
          props.api.state.path.worktree || props.api.state.path.directory,
        )}`}
        color={theme().primary}
        onToggle={props.toggleSidebar}
      />
      <Show when={props.sidebarExpanded()}>
        <box flexDirection="column" width="100%">
          <box flexDirection="row" width="100%">
            <Show when={props.repo().headBranch}>
              <text selectable={false} wrapMode="none" fg={theme().primary}>
                <b>⑂ {props.repo().headBranch}</b>
              </text>
            </Show>
            <Show when={props.repo().dirty}>
              <text selectable={false} wrapMode="none" fg={theme().warning}>
                <b>✎ dirty</b>
              </text>
            </Show>
          </box>
          <Show
            when={props.repo().branches.length > 0}
            fallback={
              <text selectable={false} wrapMode="none" fg={theme().textMuted}>
                {!props.repo().isRepo
                  ? "not a git repo"
                  : props.repo().error || "no commits"}
              </text>
            }
          >
            <For each={props.repo().branches}>
              {(section) => {
                const color = branchColor(section, theme());
                return (
                  <box flexDirection="column" width="100%">
                    <box flexDirection="row" width="100%">
                      <text selectable={false} wrapMode="none" fg={color}>
                        <b>
                          {section.current ? "◉" : "◌"} {section.name}
                        </b>
                      </text>
                      <Show when={section.commits[0]}>
                        <text selectable={false} wrapMode="none" fg={theme().textMuted}>
                          {" "}
                          {section.commits[0]?.short}
                        </text>
                      </Show>
                      <Show when={section.commits.length === 0}>
                        <text selectable={false} wrapMode="none" fg={theme().textMuted}>
                          {" "}
                          merged
                        </text>
                      </Show>
                    </box>
                    <Show when={section.commits.length > 0}>
                      <For each={section.commits}>
                        {(commit) => (
                          <box
                            flexDirection="row"
                            width="100%"
                            onMouseDown={(event) => {
                              event?.stopPropagation?.();
                              openCommit(section, commit);
                            }}
                          >
                            <text
                              selectable={false}
                              wrapMode="none"
                              truncate
                              content={commitRowContent(commit, color, theme())}
                            />
                          </box>
                        )}
                      </For>
                    </Show>
                  </box>
                );
              }}
            </For>
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
  const [sidebarExpanded, setSidebarExpanded] = createSignal(
    api.kv.get(KV_EXPANDED, true),
  );

  const toggleSidebar = () => {
    const next = !sidebarExpanded();
    setSidebarExpanded(next);
    api.kv.set(KV_EXPANDED, next);
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
      sidebar_content(context: TuiSlotContext) {
        return (
          <GitGraphPanel
            api={api}
            context={context}
            repo={repo}
            revision={revision}
            sidebarExpanded={sidebarExpanded}
            toggleSidebar={toggleSidebar}
          />
        );
      },
    },
  };
}

const tui: TuiPlugin = async (api) => {
  api.slots.register(createGitGraph(api));
};

const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;