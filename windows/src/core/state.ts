// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { TranscriptTail } from "./bridge";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Date.now() of the last thing this pill did or was picked for. */
  lastActiveAt?: number;
  /** True while the colour comes from Settings.projectColors (session pills only). */
  pickedColor?: boolean;
  /** Claude Code session this pill follows (session pills only). */
  sessionId?: string | null;
  /** What the session has been doing, for the session detail view. */
  detail?: SessionDetail | null;
}

/** One tool call seen between PreToolUse and PostToolUse. */
export interface ToolRun {
  /** tool_use_id, to pair PostToolUse with its PreToolUse when calls run in parallel. */
  id: string;
  tool: string;
  target: string;
  startedAt: number;
  endedAt: number | null;
  failed: boolean;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SessionDetail {
  /** Date.now() of the first event seen for this session. */
  startedAt: number;
  lastPrompt: string | null;
  /** Tool calls started and not finished yet (Claude can run several at once). */
  running: ToolRun[];
  /** Finished tool calls, newest last. */
  history: ToolRun[];
  /** Claude's own task list, from its last TodoWrite. */
  todos: TodoItem[];
  /** Files written or edited, most recent last. */
  files: string[];
  subagents: number;
  transcriptPath: string | null;
  /** The `claude` process, to find its terminal window (Linux). */
  claudePid: number | null;
  /** Last read of the transcript's tail: model, context, last reply, title. */
  tail: TranscriptTail | null;
  /** Since when the session waits for the user (finished, asking, permission). */
  waitingSince: number | null;
  /** The user was nudged about this wait, or has looked at the session since. */
  nudged: boolean;
  /** Context already flagged as nearly full (cleared when it drops again). */
  contextWarned: boolean;
}

/** Context window of a model, in tokens. */
export function contextWindow(model: string | null | undefined): number {
  return model && /haiku/i.test(model) ? 200_000 : 1_000_000;
}

/** Share of the context window in use, or null when unknown. */
export function contextShare(d: SessionDetail | null | undefined): number | null {
  const used = d?.tail?.contextTokens;
  if (!used) return null;
  return used / contextWindow(d?.tail?.model);
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** Pill the request belongs to. */
  taskId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
  task("integration_spotify", "Spotify", "#1DB954", "n8n"),
  task("integration_whatsapp", "WhatsApp", "#25D366", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe", "integration_spotify",
  "integration_whatsapp",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** Colour picked for each Claude Code project, keyed by its working directory. */
  projectColors: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  projectColors: {},
};

type Listener = () => void;

/** States in which a Claude Code session counts as doing something right now. */
const BUSY_STATES: ReadonlySet<BotStateName> = new Set([
  "working", "thinking", "searching", "approval", "question",
]);
/** With no session busy and nothing touched for this long, the island opens on Spotify. */
const QUIET_MS = 2 * 60_000;

const isSession = (t: AgentTask) => t.source === "claudeCode" && !!t.sessionId;
const byRecent = (a: AgentTask, b: AgentTask) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  /** Other pills, most recently used first — Claude Code sessions ahead of the rest. */
  get recentTasks(): AgentTask[] {
    const others = this.otherTasks;
    return [...others.filter(isSession).sort(byRecent), ...others.filter((t) => !isSession(t)).sort(byRecent)];
  }

  touch(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (t) t.lastActiveAt = Date.now();
  }

  /**
   * Which pill the island opens on: a busy session if there is one, else Spotify
   * when nothing has happened for a while, else whatever was in focus.
   */
  autoFocus() {
    const busy = this.tasks.filter((t) => isSession(t) && BUSY_STATES.has(t.state)).sort(byRecent);
    if (busy.length) {
      if (!busy.some((t) => t.id === this.focusId)) this.focusId = busy[0].id;
      return;
    }
    const spotify = this.tasks.find((t) => t.id === "integration_spotify");
    if (!spotify) return;
    const since = Date.now() - QUIET_MS;
    const quiet = !this.tasks.some((t) => t !== spotify && (t.lastActiveAt ?? 0) > since);
    if (quiet) this.focusId = spotify.id;
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    t.lastActiveAt = Date.now();
    if (t.detail) t.detail.nudged = true;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    t.lastActiveAt = Date.now();
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    t.lastActiveAt = Date.now();
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_") || a.id.startsWith("claude_");
      const isAgentB = b.id.startsWith("agent_") || b.id.startsWith("claude_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  /** Creates a pill for an extra Claude Code session, after integration_claude and
   *  the other sessions so it lands in the visible slice(0,4). */
  upsertClaudeSession(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    let at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    while (this.tasks[at]?.id.startsWith("claude_")) at++;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      // Counted as an integration so the big Mochi takes the session colour.
      source: "claudeCode", isIntegration: true,
    });
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
