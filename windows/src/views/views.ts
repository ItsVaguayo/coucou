// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, contextShare, type AgentTask } from "../core/state";
import {
  APPROVAL_MAX_H, APPROVAL_MIN_H, setApprovalHeight, washRGBA, type IslandViewName, type Wash,
} from "../core/layout";
import { createMiniBot, pruneMiniBots, reactMini } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { buildColorPicker, buildSession } from "./session";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "always" | "deny"): void;
  /** AskUserQuestion: question text → chosen label(s), joined with commas. */
  answer(answers: Record<string, string>): void;
  /** Hands the request back to the terminal (Claude Code asks there). */
  answerInTerminal(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** Bring forward the terminal window a Claude Code session runs in. */
  focusSession(id: string): void;
  /** Colour for every session in this folder; null goes back to the automatic one. */
  setProjectColor(cwd: string, color: string | null): void;
  /** What a session's Mochi wears; null takes it off. */
  setSessionAccessory(sessionId: string, accessory: string | null): void;
  /** Names a Claude Code session by hand; null goes back to the folder's name. */
  setSessionName(sessionId: string, name: string | null): void;
  /** Keeps the open island open (header pin), or lets it close again. */
  togglePin(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  const pinBtn = h("button", { class: "pin-btn", title: "Keep open", onclick: () => actions.togglePin() }, svg(ICONS.pin, 13, { stroke: 1.8 }));
  // Shrink right away instead of waiting for the auto-close countdown.
  const closeBtn = h("button", { title: "Minimise", onclick: () => actions.collapse() }, svg(ICONS.chevronUp, 13, { stroke: 2.4 }));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, pinBtn, gearBtn, soundBtn, closeBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      pinBtn.classList.toggle("on", State.userPinned);
      pinBtn.title = State.userPinned ? "Unpin" : "Keep open";
      clear(pinBtn);
      pinBtn.append(State.userPinned ? svg(ICONS.pin, 13) : svg(ICONS.pin, 13, { stroke: 1.8 }));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  // ⤢ — the focused session in detail (Claude Code sessions only).
  const openDetail = () => {
    actions.blip();
    actions.setView("session");
  };
  const expand = h(
    "button",
    { class: "icon-btn jump", title: "Details", style: "right:34px", onclick: openDetail },
    svg(ICONS.expand, 9, { stroke: 2.4 }),
  );
  tickerBody.addEventListener("click", openDetail);
  tickerBody.style.cursor = "pointer";
  const left = card(null, leftBody, expand, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  // Double-click on a session pill = go to its terminal. The first click already
  // moves that session to the big Mochi and reshuffles the pills, so the second
  // click lands elsewhere: it is caught anywhere on the overview, by timing.
  let lastPill: { id: string; at: number } | null = null;
  el.addEventListener("click", (e) => {
    if (lastPill && performance.now() - lastPill.at < 450) {
      e.stopPropagation();
      e.preventDefault();
      const id = lastPill.id;
      lastPill = null;
      actions.focusSession(id);
    }
  }, true);
  const pillClicked = (task: AgentTask) => {
    lastPill = task.detail ? { id: task.id, at: performance.now() } : null;
  };

  let pillIds = "";
  /** Session whose colour picker replaces the pills, if any. */
  let pickerFor: string | null = null;
  /** The "All" tab: every pill, scrollable, instead of the four most recent. */
  let showAll = false;
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.source === "claudeCode" &&
        (!!task.sessionId || task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // Room for the ⤢ button beside ↗.
        who.style.paddingRight = task.detail ? "58px" : "";
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";
      expand.style.display = mode === "ticker" && task?.detail ? "" : "none";

      // Most recently used first. With more than four, the fourth slot opens
      // the full list instead.
      const recent = State.recentTasks;
      if (recent.length <= 4) showAll = false;
      const others = showAll ? recent : recent.length > 4 ? recent.slice(0, 3) : recent;
      const picking = pickerFor ? State.tasks.find((t) => t.id === pickerFor) ?? null : null;
      if (pickerFor && !picking) pickerFor = null;
      const pillKey = picking
        ? `picker:${picking.id}:${picking.color}:${State.settings.mochiAccessories?.[picking.sessionId ?? ""] ?? ""}`
        : `${showAll}~${recent.length}~` +
          others.map((t) => `${t.id}:${t.pillBadge ?? ""}:${t.color}:${t.name}:${t.detail?.contextWarned ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        const openPicker = (id: string) => {
          pickerFor = id;
          State.notify();
        };
        if (picking) {
          pills.append(buildColorPicker(picking, actions, () => {
            pickerFor = null;
            State.notify();
          }));
        } else if (showAll) {
          pills.append(buildListPill("‹ Back", () => {
            showAll = false;
            State.notify();
          }));
          for (const t of others) {
            pills.append(buildPill(t, actions, openPicker, () => {
              showAll = false;
              pillClicked(t);
            }));
          }
        } else {
          for (const t of others) pills.append(buildPill(t, actions, openPicker, () => pillClicked(t)));
          if (recent.length > 4) {
            pills.append(buildListPill(`All · ${recent.length}`, () => {
              showAll = true;
              State.notify();
            }));
          }
        }
        pills.classList.toggle("picking", !!picking);
        pills.classList.toggle("listing", showAll && !picking);
        pruneMiniBots();
      }
    },
  };
}

/** A pill with no Mochi: the "All" tab and its way back. */
function buildListPill(label: string, onClick: () => void): HTMLElement {
  return h("div", { class: "pill list-pill", onclick: onClick }, h("span", { class: "lbl", text: label }));
}

function buildPill(
  task: AgentTask,
  actions: ViewActions,
  openPicker: (id: string) => void,
  onPicked?: () => void,
): HTMLElement {
  const label = task.id === "integration_claude" && !task.sessionId ? "VS Code" : task.name;
  // Context nearly full: say how full, it is the cue to /compact or start over.
  const share = task.detail?.contextWarned ? contextShare(task.detail) : null;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    {
      class: "pill",
      onclick: () => {
        onPicked?.();
        actions.setFocus(task.id);
      },
    },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  // The mini Mochi notices the cursor, and gets squashed by a click.
  pill.addEventListener("mouseenter", () => reactMini(canvas, "hover"));
  pill.addEventListener("mousedown", (e) => {
    if (e.button === 0) reactMini(canvas, "press");
  });
  if (share != null) {
    pill.classList.add("has-ctx");
    pill.append(h("span", { class: "pill-ctx", text: `${Math.round(share * 100)}%`, title: "Context nearly full" }));
  }
  // A faint wash of the pill's colour at rest, so it reads before the hover.
  const rest = `${task.color}12`;
  pill.style.background = rest;
  pill.style.borderColor = `${task.color}24`;
  // The name in the pill's own colour, lightened until it reads (4.5:1) on the wash.
  const lbl = pill.querySelector<HTMLElement>(".lbl")!;
  const labelRest = readableOn(task.color, 0x12 / 255, 4.5);
  const labelHover = readableOn(task.color, 0x2e / 255, 7);
  lbl.style.color = labelRest;
  // Right-click a Claude Code session: pick the colour of its project.
  pill.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (task.source === "claudeCode" && task.sessionId && task.sessionCwd) openPicker(task.id);
  });
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    lbl.style.color = labelHover;
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = rest;
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    lbl.style.color = labelRest;
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

/** `/home/me/Claude/coucou/windows` → `~/…/coucou/windows`. */
function shortPath(p: string): string {
  const home = p.replace(/^\/(home|Users)\/[^/]+/, "~");
  const parts = home.split("/").filter(Boolean);
  return parts.length > 3 ? `${parts[0]}/…/${parts.slice(-2).join("/")}` : home;
}

const CARD_RGB = [0x14, 0x15, 0x18];

function rgbOf(hex: string): number[] {
  const v = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** WCAG relative luminance. */
function luminance(c: number[]): number {
  const [r, g, b] = c.map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The colour, mixed towards white just enough to reach `ratio` against the card
 * washed with `wash` of the same colour. A dark project colour used to leave its
 * pill's name grey on grey.
 */
function readableOn(hex: string, wash: number, ratio: number): string {
  const c = rgbOf(hex);
  const bg = CARD_RGB.map((x, i) => x + (c[i] - x) * wash);
  const lb = luminance(bg);
  for (let t = 0.25; t <= 1.0001; t += 0.05) {
    const fg = c.map((x) => Math.round(x + (255 - x) * t));
    const lf = luminance(fg);
    if ((Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05) >= ratio) return `rgb(${fg.join(",")})`;
  }
  return "#fff";
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const list = h("div", { class: "qa-list" });
  const row = h("div", { class: "actions" });
  const body = stack(116, 16, who, code, list, row);
  const el = h("div", { class: "view" }, card("amber", body));
  // The buttons are built once per request. Rebuilding them between a
  // mouse-down and a mouse-up would swallow the click.
  let rowKey = "";
  return {
    el,
    sync() {
      const req = State.pendingApproval;
      const questions = req?.questions;
      clear(who);
      const whoRow = agentWho(State.focusTask, questions ? "is asking you" : "needs permission");
      // Where it runs: the same command means something else in another folder.
      if (req?.cwd) whoRow.append(h("span", { class: "who-cwd", text: `in ${shortPath(req.cwd)}`, title: req.cwd }));
      if (req?.destructive) whoRow.append(h("span", { class: "danger-chip", text: "destructive" }));
      who.append(whoRow);
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = req?.command || req?.tool || "…";
      code.title = code.textContent;
      code.classList.toggle("danger", !!req?.destructive);
      code.style.display = questions ? "none" : "";
      list.style.display = questions ? "" : "none";

      const key = questions ? `q|${req!.requestId}` : `allow|${req?.requestId ?? ""}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      clear(list);
      if (!questions) {
        row.append(
          btn("Deny", "secondary", () => actions.decide("deny"), "N"),
          btn("Allow", "primary", () => actions.decide("allow"), "Y"),
        );
        // Claude Code's own "don't ask again", when it offered a rule worth keeping.
        if (req?.alwaysRule) {
          const always = btn("Always allow", "secondary", () => actions.decide("always"));
          always.title = `Allow and remember ${req.alwaysRule} for this project`;
          row.append(always);
        }
        if (setApprovalHeight(APPROVAL_MIN_H)) onHeightChange();
        return;
      }

      // One set of picked labels per question; single-choice keeps at most one.
      const picked = questions.map(() => new Set<string>());
      const send = btn("Send", "primary", () => {
        if (!picked.every((p) => p.size > 0)) return;
        const answers: Record<string, string> = {};
        questions.forEach((q, i) => {
          // In the order the options were offered, not the order they were clicked.
          answers[q.question] = q.options.map((o) => o.label).filter((l) => picked[i].has(l)).join(", ");
        });
        actions.answer(answers);
      });
      const refresh = () => send.toggleAttribute("disabled", !picked.every((p) => p.size > 0));

      questions.forEach((q, i) => {
        const opts = h("div", { class: "qa-opts" });
        for (const o of q.options) {
          const b = h(
            "button",
            { class: "qa-opt", title: o.description },
            h("span", { class: "qa-label", text: o.label }),
            o.description ? h("span", { class: "qa-desc", text: o.description }) : null,
          );
          b.addEventListener("click", () => {
            const set = picked[i];
            if (q.multiSelect) {
              if (set.has(o.label)) set.delete(o.label);
              else set.add(o.label);
            } else {
              const was = set.has(o.label);
              set.clear();
              if (!was) set.add(o.label);
            }
            for (const other of opts.children) {
              const label = other.querySelector(".qa-label")?.textContent ?? "";
              other.classList.toggle("on", set.has(label));
            }
            refresh();
          });
          opts.append(b);
        }
        list.append(
          h(
            "div",
            { class: "qa" },
            h(
              "div",
              { class: "qa-head" },
              q.header ? h("span", { class: "qa-chip", text: q.header }) : null,
              h("span", { class: "qa-q", text: q.question }),
              q.multiSelect ? h("span", { class: "qa-multi", text: "pick any" }) : null,
            ),
            opts,
          ),
        );
      });
      row.append(btn("Answer in terminal", "secondary", () => actions.answerInTerminal()), send);
      refresh();

      // As tall as the questions need, up to APPROVAL_MAX_H; past that the list
      // scrolls. Measured once it is laid out.
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        // What the island adds around the view (header, margins). Both heights
        // are read in the same frame, so this holds mid-animation too.
        const island = el.closest<HTMLElement>("#island");
        const chrome = island ? island.offsetHeight - el.offsetHeight : 52;
        // The stack centres its children: its own height says nothing, so add
        // them up — the card's 1 px border and 4 px padding, top and bottom,
        // and a 5 px gap between each.
        const rest = 2 + 8 + who.offsetHeight + row.offsetHeight + 2 * 5;
        const room = APPROVAL_MAX_H - chrome - rest;
        list.style.maxHeight = `${Math.max(60, room)}px`;
        if (setApprovalHeight(chrome + rest + Math.min(list.scrollHeight, room))) onHeightChange();
      });
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code finished"));
      // What Claude actually said at the end beats the name of its last tool.
      const said = State.focusTask?.detail?.tail?.lastText;
      title.textContent = said ?? State.focusTask?.steps.at(-1) ?? "Session finished";
      title.classList.toggle("said", !!said);
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions, onChatHeightChange));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("session", buildSession(actions, onChatHeightChange));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
