// Session detail — everything one Claude Code session is doing, on the tallest
// view of the island. Opened from the ⤢ button on the overview card. Hook events
// fill AgentTask.detail; model, context and Claude's last reply come from the
// tail of the transcript, read only while this view is on screen.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type UsageToday } from "../core/bridge";
import { PROJECT_PALETTE, setSessionHeight } from "../core/layout";
import { State, contextShare, type AgentTask, type ToolRun } from "../core/state";
import { CONTEXT_WARN, refreshTail } from "../island/hooks";
import type { ViewActions, ViewHost } from "./views";
import { ACCESSORIES, BotEngine, hexToRGB, type Accessory } from "../mochi/engine";
import { accessoryOf } from "../mochi/minibots";

/** Seconds between two reads of the transcript while the view is open. */
const TRANSCRIPT_EVERY_MS = 3000;
/** Today's usage across every session is re-read this often while open. */
const USAGE_EVERY_MS = 30_000;

const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  working: "Working",
  thinking: "Thinking",
  searching: "Searching",
  approval: "Needs permission",
  question: "Asking you",
  error: "Stopped on an error",
  finished: "Finished",
  ratelimit: "Rate limited",
  sleeping: "Idle",
  dizzy: "Idle",
};

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
function shortModel(model: string): string {
  const [family, ...version] = model.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  if (!family) return model;
  const name = family[0].toUpperCase() + family.slice(1);
  return version.length ? `${name} ${version.join(".")}` : name;
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function section(label: string, ...children: (Node | null)[]): HTMLElement {
  return h("div", { class: "ss-section" }, h("div", { class: "ss-label", text: label }), ...children);
}

function runRow(run: ToolRun, now: number, live: boolean): HTMLElement {
  const icon = live
    ? h("span", { class: "ss-ico live" }, svg(ICONS.chevronRight, 8, { stroke: 2.6 }))
    : h(
      "span",
      { class: run.failed ? "ss-ico fail" : "ss-ico" },
      svg(run.failed ? ICONS.xmark : ICONS.check, 8, run.failed ? {} : { stroke: 2.6 }),
    );
  const took = (run.endedAt ?? now) - run.startedAt;
  return h(
    "div",
    { class: live ? "ss-run live" : "ss-run" },
    icon,
    h("span", { class: "ss-tool", text: run.tool }),
    h("span", { class: "ss-target", text: run.target }),
    h("span", { class: "ss-time", text: duration(took) }),
  );
}

// ── Colour picker (shared with the overview pills) ────────────────────────────

/** A still Mochi in the session's colour wearing `acc`, drawn once. */
function accessoryThumb(color: string, acc: Accessory): HTMLCanvasElement {
  const css = 22;
  const dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  const c = h("canvas", { class: "cp-acc-canvas" }) as HTMLCanvasElement;
  c.width = Math.round(css * dpr);
  c.height = Math.round(css * dpr);
  const e = new BotEngine();
  e.isMini = true;
  e.bodyColor = hexToRGB(color);
  e.accessory = acc;
  const x = c.getContext("2d");
  if (x) {
    // Drawn a bit larger than the button and lowered, so a hat fits above her.
    x.scale(dpr, dpr);
    x.translate(-3, -1);
    e.draw(x, css + 6, css + 6);
  }
  return c;
}

/** One small Mochi per accessory; the one she wears is ringed. */
function accessoryRow(task: AgentTask, actions: ViewActions): HTMLElement | null {
  if (!task.sessionId) return null;
  const worn = accessoryOf(task);
  return h(
    "div",
    { class: "cp-accs" },
    ...ACCESSORIES.map((acc) =>
      h(
        "button",
        {
          class: acc === worn ? "cp-acc on" : "cp-acc",
          title: acc === "none" ? "Nothing" : acc,
          onclick: () => actions.setSessionAccessory(task.sessionId!, acc === "none" ? null : acc),
        },
        accessoryThumb(task.color, acc),
      ),
    ),
  );
}

/** Eight swatches, a free colour and Reset, for the project a session runs in. */
export function buildColorPicker(
  task: AgentTask,
  actions: ViewActions,
  onDone: () => void,
): HTMLElement {
  const cwd = task.sessionCwd ?? "";
  const pick = (color: string | null) => {
    actions.setProjectColor(cwd, color);
    onDone();
  };
  const swatches = PROJECT_PALETTE.map((c) => {
    const b = h("button", {
      class: c.toLowerCase() === task.color.toLowerCase() ? "cp-swatch on" : "cp-swatch",
      title: c,
      onclick: () => pick(c),
    });
    b.style.background = c;
    return b;
  });
  const custom = h("input", { type: "color", value: task.color }) as HTMLInputElement;
  // The native colour dialog needs the window to accept focus (it is
  // non-activating by default, see platform::set_activating).
  custom.addEventListener("click", () => void Bridge.focusWindow(true));
  custom.addEventListener("change", () => {
    void Bridge.focusWindow(false);
    pick(custom.value);
  });
  // The name is typed in place. Typing needs the window to take keyboard focus,
  // like the colour dialog below.
  const name = h("input", {
    class: "cp-title cp-name",
    value: task.name,
    maxlength: "24",
    spellcheck: "false",
    title: "Rename this session",
  }) as HTMLInputElement;
  let named = false;
  const commit = () => {
    if (named) return;
    named = true;
    void Bridge.focusWindow(false);
    const typed = name.value.trim();
    if (task.sessionId && typed !== task.name) {
      actions.setSessionName(task.sessionId, typed && typed !== task.autoName ? typed : null);
    }
  };
  name.addEventListener("mousedown", () => {
    named = false;
    void Bridge.focusWindow(true);
  });
  name.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      commit();
      onDone();
    } else if (e.key === "Escape") {
      named = true;
      void Bridge.focusWindow(false);
      onDone();
    }
  });
  name.addEventListener("blur", commit);

  return h(
    "div",
    { class: "color-picker" },
    h(
      "div",
      { class: "cp-head" },
      dot(task.color, 7),
      name,
      h("button", { class: "icon-btn", title: "Close", onclick: onDone }, svg(ICONS.xmark, 8)),
    ),
    h("div", { class: "cp-swatches" }, ...swatches),
    accessoryRow(task, actions),
    h(
      "div",
      { class: "cp-foot" },
      h("label", { class: "cp-custom" }, custom, h("span", { text: "Custom…" })),
      h("button", { class: "link-btn", text: "Reset", onclick: () => pick(null) }),
    ),
  );
}

// ── The view ──────────────────────────────────────────────────────────────────

/** Island height around the card: 8 + 34 header above, 10 below. */
const ISLAND_EXTRA = 52;
/** Card height around the head and the taller column: borders, paddings, gaps. */
const CARD_EXTRA = 44;

/** Natural height of a column: its sections, not the space it was stretched to. */
function columnHeight(col: Element): number {
  const kids = [...col.children] as HTMLElement[];
  return kids.reduce((sum, k) => sum + k.offsetHeight, 0) + Math.max(0, kids.length - 1) * 8;
}

export function buildSession(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const body = h("div", { class: "ss-body" });
  const back = h(
    "button",
    { class: "icon-btn jump", title: "Back", onclick: () => actions.setView("overview") },
    svg(ICONS.shrink, 9, { stroke: 2.4 }),
  );
  // ↗ — the terminal this session runs in.
  const goto = h(
    "button",
    {
      class: "icon-btn jump",
      title: "Go to this chat",
      style: "right:34px",
      onclick: () => {
        const id = State.focusTask?.id;
        if (id) actions.focusSession(id);
      },
    },
    svg(ICONS.arrowUpRight, 8),
  );
  const el = h("div", { class: "view session" }, h("div", { class: "card" }, body, goto, back));

  let usage: UsageToday | null = null;
  let usageAt = -Infinity;
  let lastRead = 0;
  let lastRender = 0;
  let pickerOpen = false;
  let lastTask: string | null = null;
  // Rebuilding the body between a mouse-down and its mouse-up swallows the click.
  let pressing = false;
  el.addEventListener("pointerdown", () => (pressing = true));
  window.addEventListener("pointerup", () => (pressing = false));

  async function readUsage() {
    // Local midnight: "today" is the user's day, not UTC's.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const u = await Bridge.usageToday(midnight.getTime());
    if (u) usage = u;
  }

  function render() {
    const task = State.focusTask;
    lastRender = performance.now();
    clear(body);
    if (!task || task.source !== "claudeCode" || !task.detail) {
      body.append(h("div", { class: "ss-empty", text: "This session has ended." }));
      return;
    }
    if (task.id !== lastTask) {
      lastTask = task.id;
      pickerOpen = false;
    }
    const d = task.detail;
    const now = Date.now();
    const tail = d.tail;

    // Header: who, state, how long, model and context.
    const colorDot = h("button", {
      class: "ss-color",
      title: "Change colour",
      onclick: () => {
        pickerOpen = !pickerOpen;
        render();
      },
    });
    colorDot.style.background = task.color;
    const meta: (Node | null)[] = [
      h("span", { class: "ss-state", text: STATE_LABELS[task.state] ?? task.state }),
      h("span", { class: "ss-meta", text: duration(now - d.startedAt) }),
    ];
    if (tail?.model) meta.push(h("span", { class: "ss-chip", text: shortModel(tail.model) }));
    if (tail?.contextTokens) {
      const share = contextShare(d) ?? 0;
      meta.push(h("span", {
        class: share >= CONTEXT_WARN ? "ss-chip warn" : "ss-chip",
        text: `${tokens(tail.contextTokens)} context · ${Math.round(share * 100)}%`,
        title: share >= CONTEXT_WARN ? "Nearly full: /compact or start a new chat" : "",
      }));
    }
    if (d.subagents > 0) {
      meta.push(h("span", { class: "ss-chip", text: `${d.subagents} subagent${d.subagents > 1 ? "s" : ""}` }));
    }
    if (usage && usage.inputTokens + usage.outputTokens > 0) {
      meta.push(h("span", {
        class: "ss-chip",
        text: `Today · ${tokens(usage.inputTokens + usage.outputTokens)} tokens`,
        title: `Every chat on this computer since midnight: ${tokens(usage.inputTokens)} read, ` +
          `${tokens(usage.outputTokens)} written.`,
      }));
    }
    const head = h(
      "div",
      { class: "ss-head" },
      h("div", { class: "ss-who" }, colorDot, h("span", { class: "ss-name", text: task.name }), ...meta),
      pickerOpen
        ? buildColorPicker(task, actions, () => {
          pickerOpen = false;
          render();
        })
        : h("div", { class: "ss-prompt", text: d.lastPrompt ?? "No prompt yet in this session." }),
    );

    // Left: what runs now, what just ran, files touched.
    const live = d.running.map((r) => runRow(r, now, true));
    const nowSection = section(
      "Now",
      ...(live.length
        ? live.slice(-2)
        : [h("div", { class: "ss-quiet", text: task.state === "thinking" ? "Thinking…" : "No tool running." })]),
    );
    const recent = d.history.slice(-3).reverse().map((r) => runRow(r, now, false));
    const left = h(
      "div",
      { class: "ss-col" },
      nowSection,
      recent.length ? section("Recent", ...recent) : null,
      d.files.length
        ? section(
          `Files · ${d.files.length}`,
          h("div", {
            class: "ss-files",
            text: d.files.slice(-4).reverse().map(lastSegment).join("  ·  "),
            title: d.files.slice().reverse().join("\n"),
          }),
        )
        : null,
    );

    // Right: Claude's plan and the last thing it wrote.
    const todos = d.todos;
    let shown = todos;
    if (todos.length > 5) {
      // Keep the current item in the window rather than the first five.
      const at = Math.max(0, todos.findIndex((t) => t.status === "in_progress"));
      const start = Math.min(Math.max(0, at - 1), todos.length - 5);
      shown = todos.slice(start, start + 5);
    }
    const done = todos.filter((t) => t.status === "completed").length;
    const right = h(
      "div",
      { class: "ss-col" },
      todos.length
        ? section(
          `Plan · ${done}/${todos.length}`,
          ...shown.map((t) =>
            h(
              "div",
              { class: `ss-todo ${t.status}` },
              h("span", { class: "ss-box" }, t.status === "completed" ? svg(ICONS.check, 8, { stroke: 2.6 }) : null),
              h("span", { class: "ss-todo-text", text: t.content }),
            ),
          ),
        )
        : null,
      tail?.lastText ? section("Claude said", h("div", { class: "ss-said", text: tail.lastText })) : null,
      !todos.length && !tail?.lastText
        ? section("Plan", h("div", { class: "ss-quiet", text: "No task list in this session yet." }))
        : null,
    );

    const grid = h("div", { class: "ss-grid" }, left, right);
    body.append(head, grid);

    // As tall as the content, between SESSION_MIN_H and SESSION_MAX_H: a chat
    // that just started does not leave half the island empty.
    if (State.view === "session" && el.isConnected) {
      const content = head.offsetHeight + Math.max(columnHeight(left), columnHeight(right));
      if (setSessionHeight(content + CARD_EXTRA + ISLAND_EXTRA)) onHeightChange();
    }
  }

  return {
    el,
    sync() {
      const task = State.focusTask;
      if (task && task.id !== lastTask) lastRead = 0;
      render();
    },
    tick(nowMs: number) {
      // Live timers move once a second; the transcript is re-read every 3 s.
      if (nowMs - lastRender >= 1000 && !pressing && !pickerOpen) render();
      const task = State.focusTask;
      if (task?.detail?.transcriptPath && nowMs - lastRead >= TRANSCRIPT_EVERY_MS) {
        lastRead = nowMs;
        void refreshTail(task, TRANSCRIPT_EVERY_MS - 100);
      }
      if (nowMs - usageAt >= USAGE_EVERY_MS) {
        usageAt = nowMs;
        void readUsage();
      }
    },
  };
}
