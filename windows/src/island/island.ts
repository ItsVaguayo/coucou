// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { createNowPlaying, spotifyPlaying, spotifyShown, NOW_PLAYING_W } from "../views/nowplaying";
import { createVoiceStrip, discordInCall, VOICE_W } from "../views/voicecall";
import { createToasts, TOAST_W, type ToastMessage } from "../views/toast";
import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine, hexToRGB, randomMood } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import {
  accessoryOf,
  REACTION, createMiniBot, miniBotsReacting, moodRandomMini, pruneMiniBots, setMiniGridScale,
  syncMiniBotStates, tickMiniBots,
} from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { applySessionPrefs } from "./hooks";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

/** How long the cursor has to sit still before Mochi stops watching it. */
const BORED_AFTER_MS = 5000;
/** A Mochi makes a face for no reason every 7–17 s. */
const MOOD_MIN_MS = 7000;
const MOOD_SPREAD_MS = 10000;
/** Controls keep their own clicks; the rest of the island can be dragged. */
const NO_DRAG = "button, input, select, textarea, a, label, [contenteditable], .pill, .color-picker";
/** Longest name a session can be given, and how many typed names are kept. */
const SESSION_NAME_MAX = 24;
const SESSION_NAMES_KEPT = 40;
/** How far a press has to travel before it is a drag rather than a click. */
const DRAG_SLOP = 5;
/** Frame rate for a Mochi that is only breathing or living her idle life. */
const AMBIENT_FPS = 30;
/** Sizes offered for the compact island, picked in Settings. */
export const COMPACT_SCALES = [0.85, 1, 1.2] as const;

/** Scale of the compact island; the expanded one is always drawn at 1. */
/**
 * Canvas pixels per CSS pixel for a Mochi shown at scale `k`, in steps of 0.25
 * so an easing scale does not reallocate the canvas every frame.
 */
function renderScale(k: number): number {
  const exact = (window.devicePixelRatio || 1) * Math.max(1, k);
  // Capped at 2: each extra step is ~2× the pixels, all painted on the CPU in WebKitGTK.
  return Math.min(2, Math.ceil(exact * 4) / 4);
}

function compactScale(): number {
  const z = State.settings.islandScale;
  return COMPACT_SCALES.find((k) => Math.abs(k - z) < 0.01) ?? 1;
}

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private nowPlaying = createNowPlaying();
  private voiceStrip = createVoiceStrip();
  private compactLayout = "";
  private toasts = createToasts(() => State.notify(), () => void Bridge.openWhatsApp());
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  /** Compact-size preset, eased to 1 while expanded. */
  private zoom = new Tracked(1);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  /** When the Mochis were last drawn, and the time gathered since for their update. */
  private lastDraw = 0;
  private drawDt = 0;
  private dirty = true;
  private canvasDpr = 0;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private pushedAt = 0;
  private geoKey = "";
  private glowKey = "";
  private lastHoverFace = 0;
  private homeCollapseAt: number | null = null;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.scheduleMood();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      togglePin: () => this.togglePin(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A session waiting on a permission: its pill is the way to the card.
        if (State.pendingApproval?.taskId === id) this.setView("approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        const cwd = task?.sessionCwd ?? null;
        if (!task?.detail) {
          void Bridge.openInVSCode(cwd);
          return;
        }
        void this.focusSession(task.id).then((ok) => {
          if (!ok) void Bridge.openInVSCode(cwd);
        });
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.source === "claudeCode") {
          // The chat's own terminal first; VS Code on the folder when none is found.
          void this.focusSession(task.id).then((ok) => {
            if (!ok) void Bridge.openInVSCode(task.sessionCwd ?? null);
          });
        }
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        State.pendingApproval = null;
        State.isPinned = false;
        this.fsm.pinned = State.userPinned;
        State.updateTask(req.taskId, "working");
        State.setPillBadge(req.taskId, null);
        this.setView(State.defaultView());
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      focusSession: (id) => {
        Sound.play("blip");
        void this.focusSession(id);
      },
      setProjectColor: (cwd, color) => {
        if (!cwd) return;
        const colors = { ...State.settings.projectColors };
        if (color) colors[cwd] = color;
        else delete colors[cwd];
        State.settings.projectColors = colors;
        void Bridge.saveSettings(State.settings);
        applySessionPrefs();
        Sound.play("blip");
      },
      setSessionAccessory: (sessionId, accessory) => {
        if (!sessionId) return;
        const worn = { ...State.settings.mochiAccessories };
        delete worn[sessionId];
        if (accessory && accessory !== "none") worn[sessionId] = accessory;
        const keys = Object.keys(worn);
        for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_NAMES_KEPT))) delete worn[k];
        State.settings.mochiAccessories = worn;
        void Bridge.saveSettings(State.settings);
        State.notify();
        Sound.play("blip");
      },
      setSessionName: (sessionId, name) => {
        if (!sessionId) return;
        const names = { ...State.settings.sessionNames };
        delete names[sessionId];
        const typed = name?.trim().slice(0, SESSION_NAME_MAX);
        if (typed) names[sessionId] = typed;
        // Session ids never come back once a chat is gone: keep the newest few.
        const keys = Object.keys(names);
        for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_NAMES_KEPT))) delete names[k];
        State.settings.sessionNames = names;
        void Bridge.saveSettings(State.settings);
        applySessionPrefs();
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.nowPlaying.el,
      this.voiceStrip.el,
      this.toasts.el,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    // While a song plays the compact island stays up to show it.
    // A queue of notices keeps it up too, until the last one has had its turn.
    this.fsm.holdPetit = () => spotifyPlaying() || this.toasts.active;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          // Opened by the user: start on whatever deserves it. An alert opens on
          // its own subject instead (see alert()).
          if (!this.alerting) State.autoFocus();
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      State.userPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    State.isPinned = false;
    State.userPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.keepOpen;
    this.alerting = true;
    try {
      this.fsm.forceHome();
    } finally {
      this.alerting = false;
    }
    this.expand(view);
  }

  /** True while an alert drives the state machine: no auto-focus then. */
  private alerting = false;

  reveal() {
    this.fsm.reveal();
  }

  /** A browser is the focused window (X11): fade so its tabs show through. */
  private browserFocus = false;

  setBrowserFocus(on: boolean) {
    this.browserFocus = on;
    this.updateDim();
  }

  /** Faded only while nobody is using it: the pointer over it or an open card wins. */
  private updateDim() {
    const dim =
      this.browserFocus && !this.wasInIsland && State.mode !== "expanded" && !this.toasts.active;
    this.islandEl.classList.toggle("dim", dim);
  }

  /** A WhatsApp message: on the compact island for a few seconds. */
  showMessage(m: ToastMessage, pill = "integration_whatsapp") {
    if (State.paused) return;
    Sound.play("pop");
    this.engine.triggerEmote("surprised");
    const task = State.tasks.find((t) => t.id === pill);
    if (task && State.focusId !== task.id) task.pillBadge = "finished";
    if (task) State.touch(task.id);
    this.toasts.push(m);
    if (State.mode === "hidden") this.fsm.reveal();
    State.notify();
  }

  /**
   * A session out of focus finished (or failed): its notice joins the queue on
   * the compact island, so several finishing together show one after another.
   * With the island open, the pill's badge already says it.
   */
  sessionDone(taskId: string, failed: boolean) {
    if (State.paused || State.mode === "expanded") return;
    const task = State.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const said = task.detail?.tail?.lastText?.split("\n").find((l) => l.trim())?.trim();
    this.toasts.push({
      kind: "session",
      from: task.name,
      text: failed ? "Stopped on an error" : said || "Finished",
      at: Date.now(),
      color: failed ? "#F4505E" : task.color,
      icon: failed ? "xmark" : "check",
      // The chat's own Mochi, happy or not, with the ✓ / ✕ as a badge.
      makeNode: () => {
        // Drop the previous notice's Mochi first: this one is not in the page yet.
        pruneMiniBots();
        return createMiniBot({ ...task, state: failed ? "error" : "finished" }, 18);
      },
      ms: 4500,
      onShow: () => Sound.play(failed ? "error" : "finish"),
      onOpen: () => {
        State.setFocus(task.id);
        void this.focusSession(task.id);
      },
    });
    if (State.mode === "hidden") this.fsm.reveal();
    State.notify();
  }

  /** A session has waited ten minutes for you: show it, once, without opening. */
  nudge(taskId: string) {
    if (State.paused) return;
    const task = State.tasks.find((t) => t.id === taskId);
    if (!task) return;
    Sound.play("pop");
    if (State.focusId === taskId) this.engine.triggerEmote("surprised");
    else task.pillBadge = "approval";
    if (State.mode === "hidden") this.fsm.reveal();
    State.notify();
  }

  /** Brings the session's terminal forward; false when no window was found. */
  async focusSession(taskId: string): Promise<boolean> {
    const task = State.tasks.find((t) => t.id === taskId);
    const d = task?.detail;
    if (!task || !d) return false;
    d.nudged = true;
    const ok = await Bridge.focusSession(d.claudePid, d.transcriptPath, task.sessionCwd ?? null);
    void Bridge.log(`focus session ${taskId} pid=${d.claudePid ?? "?"} → ${ok}`);
    return !!ok;
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = State.userPinned;
  }

  /** Header pin: keep the open island open until unpinned or minimised. */
  togglePin() {
    State.userPinned = !State.userPinned;
    if (State.userPinned) {
      this.fsm.pin();
      this.homeCollapseAt = null;
    } else {
      this.fsm.pinned = State.keepOpen;
      // Unpinned with the cursor away: start the usual countdown.
      if (!this.wasInIsland && this.fsm.state === "home") {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
        this.fsm.mouseLeft();
      }
    }
    Sound.play("blip");
    State.notify();
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const size = islandSize(State.mode, State.view, State.chatHistory.length);
    const h = size.h;
    const w =
      State.mode !== "compact" ? size.w
        : this.toasts.active ? TOAST_W
          : discordInCall() ? VOICE_W
          : spotifyShown() ? NOW_PLAYING_W
            : size.w;
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private targetZoom(): number {
    return State.mode === "expanded" ? 1 : compactScale();
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    const z = this.targetZoom();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
      this.zoom.curveTowards(z);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
      this.zoom.springTo(z);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    // Called every frame; once the island has settled there is nothing to
    // write, and each style write made WebKit lay the island out again.
    const geoKey = `${w}|${hh}|${r}|${this.zoom.value}|${this.targetZoom()}|${window.devicePixelRatio}`;
    if (geoKey === this.geoKey) return;
    this.geoKey = geoKey;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    const k = this.zoom.value;
    setMiniGridScale(this.targetZoom());
    // Scaled from the top centre, so the island stays glued to the screen edge.
    this.islandEl.style.transform = k === 1 ? "translateX(-50%)" : `translateX(-50%) scale(${k})`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    // Snapped to whole screen pixels like the big Mochi (see drawBot).
    this.miniGrid.style.left = `${this.snapX(w - 40 - 14.5)}px`;
    this.miniGrid.style.top = `${this.snapY(hh / 2 - 14.5)}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = this.islandRect();
    const p = this.pushedRect;
    const moving = this.width.animating || this.height.animating || this.zoom.animating;
    const now = performance.now();
    // While it morphs, the click-through region (an X11 request on the main
    // thread) follows at ~20 Hz; the frame it settles always goes through.
    if (moving && now - this.pushedAt < 50) return;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      this.pushedAt = now;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  /**
   * A position inside the island moved to the nearest whole screen pixel once
   * the compact scale (from the top centre) is applied.
   */
  private snapX(local: number): number {
    const k = this.zoom.value;
    const half = this.width.value / 2;
    const screen = window.devicePixelRatio || 1;
    const page = PANEL_W / 2 + (local - half) * k;
    return (Math.round(page * screen) / screen - PANEL_W / 2) / k + half;
  }

  private snapY(local: number): number {
    const k = this.zoom.value;
    const screen = window.devicePixelRatio || 1;
    return Math.round(local * k * screen) / screen / k;
  }

  /** As drawn, so with the compact scale applied. */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const k = this.zoom.value;
    const w = this.width.value * k;
    const hh = this.height.value * k;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      const press = () => {
        if (State.mode !== "expanded") {
          this.fsm.click();
          return;
        }
        if (this.isBotHit(e.clientX, e.clientY)) {
          this.cancelBotHover();
          this.engine.slap();
        }
      };
      // Anything that is not a control can be grabbed to slide the island
      // sideways; a press that does not move is the usual click.
      const target = e.target as Element | null;
      if (e.button === 0 && IS_TAURI && !target?.closest(NO_DRAG)) this.dragSideways(e, press);
      else press();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.keepOpen) {
        if (State.view === "session") this.setView("overview");
        else this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      // On X11 the global poll keeps reporting where the pointer really is.
      if (performance.now() - this.polledAt < 1000) return;
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Last cursor event from Rust's poll (Windows, or X11 on Linux). */
  private polledAt = -Infinity;

  /** Cursor from Rust's poll. */
  onPolledCursor(x: number, y: number) {
    this.polledAt = performance.now();
    this.onCursor(x, y);
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    this.noticeCursor(x, y);
    State.mouse = { x, y };
    const rect = this.islandRect();
    const k = this.zoom.value;
    State.mouseInIsland = { x: (x - rect.x) / k, y: (y - rect.y) / k };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.keepOpen) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;
    this.updateDim();

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const k = this.zoom.value;
    const cx = rect.x + this.botCx.value * k;
    const cy = rect.y + this.botCy.value * k;
    const radius = (this.botSize.value / 2) * k;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    this.botHoverStart = { x, y };
    this.engine.tgEs = 1.08;
    // The same happy face the minis make, right away. Not again within a second,
    // so a cursor resting on her edge doesn't make her hop over and over.
    const t = performance.now() / 1000;
    if (t - this.lastHoverFace > 1) {
      this.lastHoverFace = t;
      this.engine.miniReact("hover");
      Sound.play("hover");
    }
    // Staying on her still earns the hearts (scheduleLove keeps its own 6 s gap).
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.zoom.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    }

    // Breathing and idle life alone are drawn at AMBIENT_FPS: every canvas is
    // painted on the CPU in WebKitGTK, and 60 fps of a Mochi that only breathes
    // kept a core busy. Anything that moves for real still gets every frame.
    const lively =
      !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
      this.engine.active || miniBotsReacting() || UploadSeq.isActive ||
      this.width.animating || this.height.animating;
    this.drawDt = Math.min(0.1, this.drawDt + dt);
    const drawNow = lively || nowMs - this.lastDraw >= 1000 / AMBIENT_FPS - 2;
    if (drawNow) {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      if (!greetingActive) this.drawBot(this.drawDt);
      tickMiniBots(this.drawDt);
      this.lastDraw = nowMs;
      this.drawDt = 0;
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating || this.zoom.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || miniBotsReacting() ||
        // A frame skipped by the ambient cap still owes its draw: stopping here
        // left the eyes where they were until the next cursor event.
        !drawNow;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      // Written only when something changed: this runs every frame, and a
      // restyled glow is a repaint of everything under it.
      const key = `${d}|${this.botCx.value}|${this.botCy.value}|${color}|${State.effectiveState}`;
      if (key !== this.glowKey) {
        this.glowKey = key;
        this.botGlow.style.display = "block";
        this.botGlow.style.width = `${d * 2.2}px`;
        this.botGlow.style.height = `${d * 2.2}px`;
        this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
        this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
        // A wider fade instead of a CSS blur, which WebKitGTK re-rasterized on
        // every move of the glow.
        this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 70%)`;
        this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
      }
    } else if (this.glowKey !== "off") {
      this.glowKey = "off";
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    // Drawn at the size it is shown: the compact scale enlarges the canvas, and
    // a 1× canvas blown up to 1.2× is what looked blurry.
    const k = this.zoom.value;
    const dpr = renderScale(k);
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    // On whole screen pixels, or every pixel of her is resampled across two.
    this.botCanvas.style.left = `${this.snapX(this.botCx.value - w / 2)}px`;
    this.botCanvas.style.top = `${this.snapY(this.botCy.value - BOT_OVERHANG / 2 - hCss / 2)}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.wumpus = focus?.id === "integration_discord";
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    if (this.bored) return this.boredLook.x;
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value * this.zoom.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    if (this.bored) return this.boredLook.y;
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  // ── Losing interest in a still cursor ───────────────────────────────────────

  private bored = false;
  private boredLook = { x: 0, y: 0 };
  private boredTimer: number | null = null;

  /**
   * Mochi follows the cursor while it moves. Once it has sat still for a few
   * seconds she looks somewhere else; moving it again gets a blink and her
   * attention back.
   */
  private noticeCursor(x: number, y: number) {
    const last = State.mouse;
    if (Math.abs(x - last.x) + Math.abs(y - last.y) < 2) return;
    if (this.bored) {
      this.bored = false;
      this.engine.blink();
    }
    if (this.boredTimer != null) window.clearTimeout(this.boredTimer);
    this.boredTimer = window.setTimeout(() => {
      this.boredTimer = null;
      if (State.mode === "hidden") return;
      this.bored = true;
      const side = Math.random() < 0.5 ? -1 : 1;
      this.boredLook = { x: side * (0.35 + Math.random() * 0.45), y: -0.35 + Math.random() * 0.4 };
      this.ensureRunning();
    }, BORED_AFTER_MS);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.keepOpen || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid — or, while a song is loaded, the player in its place.
    const compact = State.mode === "compact";
    const toastOn = compact && this.toasts.active;
    // A Discord call takes the strip before the song does.
    const callOn = compact && !toastOn && discordInCall();
    const playerOn = compact && !toastOn && !callOn && spotifyShown();
    const layoutKey = `${toastOn}|${playerOn}|${callOn}`;
    if (layoutKey !== this.compactLayout) {
      this.compactLayout = layoutKey;
      if (compact) this.animateGeometry(!toastOn && !playerOn && !callOn);
    }
    const showGrid = compact && !playerOn && !toastOn && !callOn;
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.recentTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    this.updateDim();
    this.nowPlaying.sync(compact && !toastOn && !callOn);
    this.voiceStrip.sync(callOn);
    this.toasts.sync(compact);
    this.engine.headphones = spotifyPlaying();
    // In a Discord call she wears its headphones; muted, a plaster; deafened, red cups.
    const dc = State.settings.activeIntegrations.includes("integration_discord")
      ? State.integrations.integration_discord?.data
      : undefined;
    const inCall = dc?.running === true && dc?.channel != null;
    this.engine.call = inCall;
    this.engine.micMuted = inCall && (dc?.mute === true || dc?.deaf === true);
    this.engine.deafened = inCall && dc?.deaf === true;
    const focused = State.focusTask;
    this.engine.accessory = focused ? accessoryOf(focused) : "none";

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
    this.reactBigMochi();
  }

  private moodTimer: number | null = null;

  /**
   * Every so often a Mochi — the big one or a mini — makes a face for no reason:
   * a glare or a nap when left alone, something playful while its chat works. A timer, not the frame loop: between faces nothing is drawn, and a
   * hidden island skips its turn.
   */
  private scheduleMood() {
    if (this.moodTimer != null) window.clearTimeout(this.moodTimer);
    this.moodTimer = window.setTimeout(() => {
      this.moodTimer = null;
      this.playMood();
      this.scheduleMood();
    }, MOOD_MIN_MS + Math.random() * MOOD_SPREAD_MS);
  }

  private playMood() {
    if (State.mode === "hidden" || this.uploadActive || State.stateOverride != null) return;
    if (State.mode === "expanded" && State.view !== "overview" && State.view !== "session") return;
    // The minis get a turn too, when there are any on screen.
    if (Math.random() < 0.45 && moodRandomMini()) {
      this.ensureRunning();
      return;
    }
    if (performance.now() / 1000 < this.engine.reactingUntil) return;
    const mood = randomMood(State.effectiveState);
    if (!mood) return;
    this.engine.mood(mood);
    this.ensureRunning();
  }

  /** What the big Mochi last showed, to react the way the minis do. */
  private seenFocus: { id: string; state: string; leaving: boolean; session: string | null } | null = null;

  /**
   * The focused session gets the minis' reactions on the big Mochi too: with a
   * single chat open it is the only Mochi on screen.
   */
  private reactBigMochi() {
    this.engine.idleLife = State.mode === "expanded";
    const t = State.focusTask;
    if (!t) return;
    const prev = this.seenFocus;
    this.seenFocus = { id: t.id, state: t.state, leaving: !!t.leaving, session: t.sessionId ?? null };
    if (State.stateOverride != null || !prev || prev.id !== t.id) return;
    if (t.leaving && !prev.leaving) this.engine.miniReact("bye");
    else if (t.sessionId && t.sessionId !== prev.session) this.engine.miniReact("hello");
    else if (t.state !== prev.state) {
      const r = REACTION[t.state];
      if (r) this.engine.miniReact(r);
    }
  }

  /** Applies settings coming from Rust at boot. */
  /**
   * Follows a press that may become a sideways drag. Measured in screen
   * coordinates, which do not move with the window, and sent at most once per
   * frame with only the newest position, so the window never runs behind.
   */
  private dragSideways(down: MouseEvent, onClick: () => void) {
    const startX = down.screenX;
    const startOffset = State.settings.islandOffset || 0;
    let target = startOffset;
    let used = startOffset;
    let moved = false;
    let inFlight = false;
    let queued = false;

    const send = () => {
      queued = false;
      if (inFlight || target === used) return;
      inFlight = true;
      const sent = target;
      void Bridge.moveIsland(sent).then((kept) => {
        inFlight = false;
        used = kept ?? sent;
        // Pushed against the screen edge: carry on from there, not from the cursor.
        if (used !== sent && target === sent) target = used;
        if (target !== used) schedule();
      });
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(send);
    };
    const onMove = (e: MouseEvent) => {
      const dx = e.screenX - startX;
      if (!moved && Math.abs(dx) < DRAG_SLOP) return;
      moved = true;
      target = Math.round(startOffset + dx);
      schedule();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      if (!moved) {
        onClick();
        return;
      }
      // The click that ends a drag is not a click on whatever lies under it.
      const eat = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener("click", eat, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", eat, true), 0);
      const finish = () => {
        if (inFlight || queued) {
          window.setTimeout(finish, 30);
          return;
        }
        State.settings.islandOffset = used;
        void Bridge.saveSettings(State.settings);
      };
      finish();
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  }

  applySettings() {
    if (Math.abs(this.zoom.value - this.targetZoom()) > 0.001) this.animateGeometry(false);
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
