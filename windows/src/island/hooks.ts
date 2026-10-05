// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { PROJECT_PALETTE, colorForProject } from "../core/layout";
import {
  State, contextShare, type AgentTask, type AskQuestion, type SessionDetail, type TodoItem, type ToolRun,
} from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";
/** What integration_claude looks like with no session on it. */
const CLAUDE_IDLE_NAME = "VS Code";
const CLAUDE_IDLE_COLOR = "#F5F6F8";
/** A session silent this long is presumed gone (terminal closed without SessionEnd). */
const STALE_MS = 45 * 60_000;

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PermissionRequest: Claude Code's "don't ask again" options. */
  permission_suggestions?: unknown;
  tool_use_id?: string;
  transcript_path?: string;
  /** The `claude` process behind the hook (Linux relay only). */
  claude_pid?: number;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** What a tool is doing, as the step line and the compact island show it. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Running",
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Glob: "Finding",
  Grep: "Searching",
  WebSearch: "Searching the web",
  WebFetch: "Fetching",
  TodoWrite: "Planning",
  Task: "Agent",
  Agent: "Agent",
  LS: "Listing",
  MultiEdit: "Editing",
  NotebookEdit: "Editing notebook",
  PowerShell: "Running",
  AskUserQuestion: "Asking you",
  ExitPlanMode: "Plan ready",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

/**
 * Commands that delete, overwrite history or reach outside the project. The card
 * shows them in red so they are not approved on reflex, and never offers
 * "Always" for them. A guard for the eye, not a sandbox.
 */
const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\b|--recursive|--force)/,
  /\bgit\s+push\b.*(\s--force\b|\s-f\b|--force-with-lease|\s\+\S)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/,
  /\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b/i,
  /\bmkfs(\.\w+)?\b|\bdd\s+if=|>\s*\/dev\/(sd|nvme|disk)/,
  /\bchmod\s+-R\b|\bchown\s+-R\b/,
  /\bsudo\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\bkill(all)?\s+-9\b/,
  /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)/,
  /\bRemove-Item\b.*-Recurse/i,
];

export function isDestructive(tool: string, input: Record<string, unknown>): boolean {
  if (tool !== "Bash" && tool !== "PowerShell") return false;
  const cmd = typeof input.command === "string" ? input.command : "";
  return DESTRUCTIVE.some((re) => re.test(cmd));
}

/**
 * The rule "Always" would add, from Claude Code's own suggestions — only allow
 * rules kept for the session or in the project's settings.local.json, the same
 * filter coucou-hook applies. Undefined when none qualifies.
 */
function alwaysRuleOf(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rules: string[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const e = s as Record<string, unknown>;
    if (e.type !== "addRules" || e.behavior !== "allow") continue;
    if (e.destination !== "session" && e.destination !== "localSettings") continue;
    for (const r of Array.isArray(e.rules) ? e.rules : []) {
      const { toolName, ruleContent } = (r ?? {}) as Record<string, unknown>;
      if (typeof toolName !== "string") continue;
      rules.push(typeof ruleContent === "string" && ruleContent ? `${toolName}(${ruleContent})` : toolName);
    }
  }
  return rules.length ? rules.join(", ") : undefined;
}

/** AskUserQuestion's questions, or undefined when the input is not what we expect. */
function askQuestions(input: Record<string, unknown>): AskQuestion[] | undefined {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") return undefined;
    const { question, header, multiSelect, options } = q as Record<string, unknown>;
    if (typeof question !== "string" || !question || !Array.isArray(options) || options.length === 0) {
      return undefined;
    }
    const opts = options
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({
        label: typeof o.label === "string" ? o.label : "",
        description: typeof o.description === "string" ? o.description : "",
      }))
      .filter((o) => o.label);
    if (opts.length === 0) return undefined;
    out.push({ question, header: typeof header === "string" ? header : "", multiSelect: multiSelect === true, options: opts });
  }
  return out;
}

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

// ── One pill per Claude Code session ──────────────────────────────────────────
//
// The first live session rides integration_claude (a stable pill ID, never
// renamed); each further one gets its own claude_<id> pill. A session that ends
// gives its pill back.

const sessions = new Map<string, { taskId: string; lastSeen: number }>();

function projectNameOf(cwd: string): string {
  return aliasProjectName(lastPathComponent(cwd) || "Session");
}

/**
 * The colour a session gets: the one picked for its folder, else the colour of
 * another live session in the same folder, else the project's hashed colour —
 * moved to the first free palette entry if a different project already wears it.
 */
function sessionColor(cwd: string, projectName: string, taskId = ""): string {
  const picked = cwd && State.settings.projectColors[cwd];
  if (picked) return picked;
  const live = State.tasks.filter((t) => t.id !== taskId && t.sessionId && t.sessionCwd);
  const sibling = live.find((t) => t.sessionCwd === cwd);
  if (sibling) return sibling.color;
  const taken = new Set(live.map((t) => t.color.toLowerCase()));
  const hashed = colorForProject(projectName);
  if (!taken.has(hashed.toLowerCase())) return hashed;
  return PROJECT_PALETTE.find((c) => !taken.has(c.toLowerCase())) ?? hashed;
}

function claimTask(sessionId: string): string {
  const known = sessions.get(sessionId);
  if (known) {
    known.lastSeen = Date.now();
    return known.taskId;
  }
  const primaryBusy = [...sessions.values()].some((s) => s.taskId === CLAUDE_ID);
  const taskId = primaryBusy
    ? `claude_${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`
    : CLAUDE_ID;
  sessions.set(sessionId, { taskId, lastSeen: Date.now() });
  return taskId;
}

/** Long enough for the mini Mochi to wave goodbye before its pill goes. */
const GOODBYE_MS = 1400;

function releaseSession(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  const t = State.tasks.find((x) => x.id === s.taskId);
  if (!t) return;
  t.leaving = true;
  State.notify();
  window.setTimeout(() => {
    // The same session came back meanwhile (upsert clears the flag).
    if (!t.leaving) return;
    t.leaving = false;
    if (s.taskId === CLAUDE_ID) {
      clearSession();
      State.notify();
    } else {
      State.removeTask(s.taskId);
    }
  }, GOODBYE_MS);
}

function pruneStale(now: number) {
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen < STALE_MS) continue;
    if (State.pendingApproval?.taskId === s.taskId) continue;
    releaseSession(sid);
  }
}

/** "coucou", then "coucou 2" for a second live session in the same folder. */
function numberedName(taskId: string, projectName: string, cwd: string): string {
  const others = State.tasks.filter(
    (t) => t.id !== taskId && t.sessionId && t.sessionCwd === cwd,
  ).length;
  return others > 0 ? `${projectName} ${others + 1}` : projectName;
}

/** The name typed for this session, else the folder's ("coucou 2"). */
function sessionName(t: AgentTask): string {
  const typed = t.sessionId ? State.settings.sessionNames?.[t.sessionId] : undefined;
  return typed || t.autoName || t.name;
}

function newDetail(): SessionDetail {
  return {
    startedAt: Date.now(), lastPrompt: null, running: [], history: [],
    todos: [], files: [], subagents: 0, transcriptPath: null,
    claudePid: null, tail: null, waitingSince: null, nudged: false, contextWarned: false,
  };
}

function upsert(taskId: string, sessionId: string, projectName: string, cwd: string) {
  if (taskId !== CLAUDE_ID) {
    State.upsertClaudeSession(taskId, projectName, sessionColor(cwd, projectName, taskId));
  }
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.leaving = false;
  const sid = sessionId || null;
  // Named once, from the folder the session was first heard from: a `cd` inside
  // the chat must not rename it or change its colour.
  if (t.name === CLAUDE_IDLE_NAME || t.sessionId !== sid) {
    if (cwd) t.sessionCwd = cwd;
    t.sessionId = sid;
    t.autoName = numberedName(taskId, projectName, t.sessionCwd ?? "");
    t.name = sessionName(t);
    t.color = sessionColor(t.sessionCwd ?? "", projectName, taskId);
    t.pickedColor = !!State.settings.projectColors[t.sessionCwd ?? ""];
  }
  if (!t.detail) t.detail = newDetail();
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = CLAUDE_IDLE_NAME;
  t.color = CLAUDE_IDLE_COLOR;
  t.sessionId = null;
  t.detail = null;
  t.pillBadge = null;
  t.state = "idle";
}

/**
 * Re-applies the colour and name of every live session (after a pick, a rename
 * or a settings change).
 */
export function applySessionPrefs() {
  for (const t of State.tasks) {
    if (t.source !== "claudeCode" || !t.sessionId || !t.sessionCwd) continue;
    t.name = sessionName(t);
    const picked = State.settings.projectColors[t.sessionCwd];
    if (picked) t.color = picked;
    else if (t.pickedColor) t.color = sessionColor(t.sessionCwd, projectNameOf(t.sessionCwd), t.id);
    t.pickedColor = !!picked;
  }
  State.notify();
}

// ── Session detail bookkeeping ────────────────────────────────────────────────

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

/** The argument worth showing for a tool call, with paths made relative to the session. */
function runTarget(input: Record<string, unknown>, cwd: string): string {
  for (const field of [...APPROVAL_FIELDS, "notebook_path", "description"]) {
    const value = input[field];
    if (typeof value !== "string" || !value.trim()) continue;
    let v = value.trim();
    if (cwd && v.startsWith(cwd + "/")) v = v.slice(cwd.length + 1);
    return oneLine(v, 200);
  }
  return "";
}

function readTodos(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content : "";
    const status = o.status;
    if (!content) continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    out.push({ content: oneLine(content, 160), status });
  }
  return out;
}

function finishRun(d: SessionDetail, id: string, tool: string, failed: boolean) {
  let idx = id ? d.running.findIndex((r) => r.id === id) : -1;
  if (idx < 0) idx = d.running.findIndex((r) => r.tool === tool);
  if (idx < 0) return;
  const [run] = d.running.splice(idx, 1);
  run.endedAt = Date.now();
  run.failed = failed;
  d.history.push(run);
  if (d.history.length > 12) d.history.shift();
}

function closeAllRuns(d: SessionDetail) {
  for (const r of [...d.running]) finishRun(d, r.id, r.tool, false);
}

function trackDetail(taskId: string, name: string, payload: HookPayload, cwd: string) {
  const d = State.tasks.find((x) => x.id === taskId)?.detail;
  if (!d) return;
  if (payload.transcript_path) d.transcriptPath = payload.transcript_path;
  if (typeof payload.claude_pid === "number") d.claudePid = payload.claude_pid;
  // Waiting for the user from the moment Claude stops or asks, until it works again.
  if (name === "Stop" || name === "StopFailure" || name === "PermissionRequest" ||
    (name === "Notification" && (payload.message ?? "").endsWith("?"))) {
    if (d.waitingSince == null) d.waitingSince = Date.now();
    d.nudged = State.mode === "expanded" && State.focusId === taskId;
  } else if (name === "UserPromptSubmit" || name === "PreToolUse") {
    d.waitingSince = null;
  }
  const tool = payload.tool_name ?? "Tool";
  const input = payload.tool_input ?? {};
  switch (name) {
    case "SessionStart":
      d.startedAt = Date.now();
      break;
    case "UserPromptSubmit": {
      const asked = payload.prompt ?? payload.message;
      if (asked) d.lastPrompt = asked.trim().slice(0, 400);
      break;
    }
    case "PreToolUse": {
      const run: ToolRun = {
        id: payload.tool_use_id ?? "", tool, target: runTarget(input, cwd),
        startedAt: Date.now(), endedAt: null, failed: false,
      };
      d.running.push(run);
      if (d.running.length > 8) d.running.shift();
      if (tool === "TodoWrite") {
        const todos = readTodos(input.todos);
        if (todos) d.todos = todos;
      }
      const file = input.file_path ?? input.notebook_path;
      if (FILE_TOOLS.has(tool) && typeof file === "string" && file) {
        const rel = cwd && file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : file;
        d.files = d.files.filter((f) => f !== rel);
        d.files.push(rel);
        if (d.files.length > 40) d.files.shift();
      }
      break;
    }
    case "PostToolUse":
      finishRun(d, payload.tool_use_id ?? "", tool, false);
      break;
    case "PostToolUseFailure":
      finishRun(d, payload.tool_use_id ?? "", tool, true);
      break;
    case "SubagentStart":
      d.subagents++;
      break;
    case "SubagentStop":
      d.subagents = Math.max(0, d.subagents - 1);
      break;
    case "Stop":
    case "StopFailure":
      closeAllRuns(d);
      d.subagents = 0;
      break;
  }
}

// ── Transcript tail, context warning, forgotten chats ─────────────────────────

/** Context share at which the session's pill and detail turn amber. */
export const CONTEXT_WARN = 0.8;
/** A session waiting this long for you, unlooked-at, gets a nudge. */
const NUDGE_AFTER_MS = 10 * 60_000;

const tailReadAt = new Map<string, number>();
const tailInFlight = new Set<string>();

/**
 * Re-reads the end of a session's transcript (model, context, last reply,
 * title), at most once every `minGapMs`. Driven by hook events and by the open
 * detail view only, so nothing is read while every session sits idle.
 */
export async function refreshTail(task: AgentTask, minGapMs = 15_000) {
  const d = task.detail;
  if (!d?.transcriptPath || tailInFlight.has(task.id)) return;
  const now = Date.now();
  if (now - (tailReadAt.get(task.id) ?? 0) < minGapMs) return;
  tailReadAt.set(task.id, now);
  tailInFlight.add(task.id);
  try {
    const tail = await Bridge.sessionTranscriptTail(d.transcriptPath);
    if (!tail) return;
    d.tail = tail;
    const share = contextShare(d);
    if (share != null && share >= CONTEXT_WARN && !d.contextWarned) {
      d.contextWarned = true;
      Sound.play("rate");
    } else if (share != null && share < CONTEXT_WARN * 0.75) {
      // Compacted or cleared: arm the warning again.
      d.contextWarned = false;
    }
    State.notify();
  } catch {
    // A moved or unreadable transcript just leaves those details out.
  } finally {
    tailInFlight.delete(task.id);
  }
}

/** Once a minute: a session left waiting for you for ten minutes gets one nudge. */
function nudgeForgotten(island: Island) {
  const now = Date.now();
  for (const t of State.tasks) {
    const d = t.detail;
    if (!d || d.nudged || d.waitingSince == null || now - d.waitingSince < NUDGE_AFTER_MS) continue;
    d.nudged = true;
    if (State.mode === "expanded" && State.focusId === t.id) continue;
    island.nudge(t.id);
  }
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // A minute apart and a few comparisons long: nothing to measure while hidden.
  window.setInterval(() => nudgeForgotten(island), 60_000);
}

export function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const projectName = projectNameOf(cwd);
  const sessionId = payload.session_id ?? "";

  pruneStale(Date.now());

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → this session's Claude Code pill.
  const validAgent = validateAgent(payload.coucou_agent);
  const isExternalAgent = validAgent !== null;
  const agentId = isExternalAgent
    ? `agent_${validAgent}`
    : name === "SessionEnd"
      ? sessions.get(sessionId)?.taskId ?? CLAUDE_ID
      : sessionId ? claimTask(sessionId) : CLAUDE_ID;

  const focused = State.focusId === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists. */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      upsert(agentId, sessionId, projectName, cwd);
    }
  };

  // A session already running when Coucou started is first heard of mid-turn.
  if (!isExternalAgent && name !== "SessionEnd") ensurePill();
  if (!isExternalAgent) {
    trackDetail(agentId, name, payload, cwd);
    const t = State.tasks.find((x) => x.id === agentId);
    if (t && (name === "Stop" || name === "StopFailure")) {
      void refreshTail(t, 0);
      // The last reply can land in the transcript a moment after the hook fires;
      // a session out of focus announces itself once it is read.
      const outOfFocus = State.focusId !== t.id;
      const failed = name === "StopFailure";
      window.setTimeout(() => {
        void refreshTail(t, 0).then(() => {
          if (outOfFocus) island.sessionDone(t.id, failed);
        });
      }, 1800);
    }
    else if (t && name === "PostToolUse") void refreshTail(t);
  }

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      // Out of focus, a Claude Code session plays its sound with its notice, in
      // turn with the others (Island.sessionDone).
      if (focused || isExternalAgent) Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(agentId, "error");
      if (focused || isExternalAgent) Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else if (sessionId && sessions.has(sessionId)) {
        releaseSession(sessionId);
      } else {
        State.updateTask(agentId, "idle");
        if (agentId === CLAUDE_ID) clearSession();
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      ensurePill();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      const questions = tool === "AskUserQuestion" ? askQuestions(input) : undefined;
      // A question the card cannot show (no options, odd shape) goes back to
      // the terminal: a bare Allow would not answer it.
      if (tool === "AskUserQuestion" && !questions) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      const destructive = isDestructive(tool, input);
      State.pendingApproval = {
        requestId,
        sessionId,
        taskId: agentId,
        tool,
        command: questions ? questions[0].question : approvalTarget(tool, input),
        questions,
        cwd,
        destructive,
        alwaysRule: questions || destructive ? undefined : alwaysRuleOf(payload.permission_suggestions),
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(agentId, "approval");
      State.isPinned = true;
      Sound.play("approval");
      // With one pill per session the request usually comes from a pill that is
      // not in focus. Bring it forward — unless the chat is open, where the card
      // would yank the text field away; the badge waits there, and clicking the
      // pill opens the card (Island's setFocus action).
      if (focused || State.view !== "prompt" || State.mode !== "expanded") {
        if (!focused) State.setFocus(agentId);
        island.alert("approval");
      } else {
        State.setPillBadge(agentId, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(agentId, "working");
        State.setPillBadge(agentId, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
