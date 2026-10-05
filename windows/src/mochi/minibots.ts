// Mini Mochis (pills + compact grid) — port of MiniBotCanvasView.
// Each canvas owns a BotEngine; the island's frame loop ticks every live one.

import { BotEngine, asAccessory, hexToRGB, moodsFor, randomMood, type Accessory, type AgentMark, type MiniReaction } from "./engine";
import type { BotStateName } from "../core/layout";
import { State, needsYou, type AgentTask } from "../core/state";

interface MiniBot {
  canvas: HTMLCanvasElement;
  engine: BotEngine;
  cssSize: number;
  taskId: string;
  /** Canvas pixels per CSS pixel it was allocated with. */
  dpr: number;
  /** Waiting on you: a ring pulses round her in the compact island. */
  attention: boolean;
}

/** One pulse of the attention ring, in seconds. */
const RING_PERIOD = 1.4;

/** Scale the compact island is drawn at; the grid's minis are enlarged by it. */
let gridScale = 1;

export function setMiniGridScale(k: number) {
  gridScale = k;
}

/** Canvas resolution for a mini: enough for the screen and for the compact scale. */
function miniDpr(canvas: HTMLCanvasElement): number {
  const k = canvas.closest("#mini-grid") ? Math.max(1, gridScale) : 1;
  // Never below 2: a 13 px Mochi drawn at 1× has no room for her eyes.
  return Math.min(3, Math.max(2, Math.ceil((window.devicePixelRatio || 1) * k * 4) / 4));
}

const live = new Map<HTMLCanvasElement, MiniBot>();

/** Last state seen per task, to react when it changes. */
const lastState = new Map<string, BotStateName>();
/** Session pills already greeted, so a re-render does not greet again. */
const greeted = new Set<string>();
/** Tasks already waved off. */
const waved = new Set<string>();
/** A session quiet this long dozes off (its mini only; the task keeps its state). */
const DOZE_AFTER_MS = 10 * 60_000;
let lastTasks: AgentTask[] = [];
let lastDozeCheck = 0;

const isSession = (t: AgentTask) => t.source === "claudeCode" && !!t.sessionId;

function dozing(t: AgentTask): boolean {
  return (
    isSession(t) &&
    (t.state === "idle" || t.state === "finished") &&
    Date.now() - (t.lastActiveAt ?? Date.now()) > DOZE_AFTER_MS
  );
}

const shownState = (t: AgentTask): BotStateName => (dozing(t) ? "sleeping" : t.state);

/** What this session's Mochi wears, picked in her pill's menu; integrations stay bare. */
export const accessoryOf = (t: AgentTask): Accessory =>
  isSession(t) ? asAccessory(State.settings.mochiAccessories?.[t.sessionId!]) : "none";

/** Which agent a pill follows, for the antenna on its Mochi; null for integrations. */
export function agentMarkOf(t: AgentTask | null): AgentMark | null {
  if (!t) return null;
  if (t.source === "claudeCode") return "claude";
  if (t.source !== "agent") return null;
  const name = t.id.replace(/^agent_/, "");
  if (name.includes("codex")) return "codex";
  if (name.includes("gemini")) return "gemini";
  return "agent";
}

export const REACTION: Partial<Record<BotStateName, MiniReaction>> = {
  finished: "done",
  approval: "ask",
  error: "fail",
};

/**
 * Creates a mini Mochi whose **body** is `bodySize` CSS pixels across.
 *
 * The engine draws the body at 60 % of its canvas, so the canvas is
 * `bodySize / 0.6` and is centred in a `bodySize` slot, overflowing it — the
 * same thing SwiftUI does with a `.frame(width: 22/0.6)` inside a
 * `.frame(width: 22)`. Sizing the canvas itself to `bodySize` would shrink the
 * whole drawing to 60 %, which is what used to happen.
 */
export function createMiniBot(task: AgentTask, bodySize: number): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "mini";
  slot.style.width = `${bodySize}px`;
  slot.style.height = `${bodySize}px`;

  const canvas = document.createElement("canvas");
  const engineSize = bodySize / 0.6;
  const dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(engineSize * dpr);
  canvas.height = Math.round(engineSize * dpr);
  canvas.style.width = `${engineSize}px`;
  canvas.style.height = `${engineSize}px`;
  slot.append(canvas);

  const engine = new BotEngine();
  engine.isMini = true;
  engine.bodyColor = hexToRGB(task.color);
  engine.accessory = accessoryOf(task);
  engine.agentMark = agentMarkOf(task);
  engine.agentMarkColor = task.color;
  engine.wumpus = task.id === "integration_discord";
  engine.setState(shownState(task), true);
  if (task.emote) engine.setPermanentEmote(task.emote);
  if (task.miniEye) {
    engine.permanentEye = task.miniEye;
    engine.eyeOverride = task.miniEye;
    engine.eyeOverrideUntil = Number.POSITIVE_INFINITY;
  }

  live.set(canvas, { canvas, engine, cssSize: engineSize, taskId: task.id, dpr, attention: needsYou(task) });
  if (isSession(task) && !greeted.has(task.id)) {
    greeted.add(task.id);
    // A session first heard from right now comes in with a hop; one already
    // running when the island started does not.
    if (Date.now() - (task.lastActiveAt ?? 0) < 5000) engine.miniReact("hello");
  }
  return slot;
}

export function releaseMiniBot(canvas: HTMLCanvasElement) {
  live.delete(canvas);
}

/** Drops every canvas no longer in the document (views are rebuilt wholesale). */
export function pruneMiniBots() {
  for (const [canvas] of live) {
    if (!canvas.isConnected) live.delete(canvas);
  }
}

export function syncMiniBotStates(tasks: AgentTask[]) {
  lastTasks = tasks;
  const changed = new Map<string, MiniReaction>();
  for (const t of tasks) {
    const before = lastState.get(t.id);
    lastState.set(t.id, t.state);
    const reaction = REACTION[t.state];
    if (before !== undefined && before !== t.state && reaction) changed.set(t.id, reaction);
    if (t.leaving && !waved.has(t.id)) {
      waved.add(t.id);
      changed.set(t.id, "bye");
    }
    if (!t.leaving) waved.delete(t.id);
  }
  for (const id of [...lastState.keys()]) {
    if (!tasks.some((t) => t.id === id)) {
      lastState.delete(id);
      greeted.delete(id);
      waved.delete(id);
    }
  }
  for (const mb of live.values()) {
    const task = tasks.find((t) => t.id === mb.taskId);
    if (!task) continue;
    if (!task.leaving) mb.engine.setState(shownState(task));
    mb.attention = needsYou(task);
    mb.engine.bodyColor = hexToRGB(task.color);
    mb.engine.accessory = accessoryOf(task);
    mb.engine.agentMark = agentMarkOf(task);
    mb.engine.agentMarkColor = task.color;
    const reaction = changed.get(task.id);
    if (reaction) mb.engine.miniReact(reaction);
  }
}

/** Mouse over or press on the pill holding this mini Mochi. */
export function reactMini(slot: HTMLElement, kind: MiniReaction) {
  const canvas = slot.querySelector("canvas");
  const mb = canvas ? live.get(canvas) : undefined;
  mb?.engine.miniReact(kind);
}

/** One mini Mochi, picked at random, makes a face that fits its state. */
export function moodRandomMini(): boolean {
  const free = [...live.values()].filter(
    (mb) =>
      mb.canvas.isConnected &&
      mb.engine.reactingUntil <= performance.now() / 1000 &&
      moodsFor(mb.engine.state).length > 0,
  );
  if (free.length === 0) return false;
  const mb = free[Math.floor(Math.random() * free.length)];
  const mood = randomMood(mb.engine.state);
  if (mood) mb.engine.mood(mood);
  return true;
}

/** True while a mini Mochi is in the middle of a reaction. */
export function miniBotsReacting(): boolean {
  const n = performance.now() / 1000;
  for (const mb of live.values()) if (mb.engine.reactingUntil > n) return true;
  return false;
}

function onScreen(canvas: HTMLCanvasElement): boolean {
  if (!canvas.isConnected || canvas.closest(".view:not(.on)")) return false;
  const grid = canvas.closest<HTMLElement>("#mini-grid");
  return !grid || grid.style.opacity !== "0";
}

export function tickMiniBots(dt: number) {
  // Dozing depends on the clock, not on an event: look again now and then.
  const ms = Date.now();
  if (ms - lastDozeCheck > 5000) {
    lastDozeCheck = ms;
    for (const mb of live.values()) {
      const task = lastTasks.find((t) => t.id === mb.taskId);
      if (task && !task.leaving) mb.engine.setState(shownState(task));
    }
  }
  for (const mb of live.values()) {
    // Hidden views stay in the page at opacity 0, and so does the compact grid:
    // painting their Mochis cost as much as the visible ones, for nothing.
    if (!onScreen(mb.canvas)) continue;
    // Whether it sits in the scaled grid is only known once it is in the page.
    const dpr = miniDpr(mb.canvas);
    if (dpr !== mb.dpr) {
      mb.dpr = dpr;
      mb.canvas.width = Math.round(mb.cssSize * dpr);
      mb.canvas.height = Math.round(mb.cssSize * dpr);
    }
    const ctx = mb.canvas.getContext("2d");
    if (!ctx) continue;
    mb.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, mb.cssSize, mb.cssSize);
    mb.engine.draw(ctx, mb.cssSize, mb.cssSize);
    if (mb.attention && inGrid(mb.canvas)) drawAttentionRing(ctx, mb.cssSize);
  }
}

function inGrid(canvas: HTMLCanvasElement): boolean {
  return canvas.closest("#mini-grid") != null;
}

/**
 * Amber ring round a compact-island mini waiting on you. Drawn on her own
 * canvas rather than as a CSS animation: WebKitGTK repaints a CSS animation even
 * when nothing else moves, and the island along with it.
 */
function drawAttentionRing(ctx: CanvasRenderingContext2D, size: number) {
  const t = (performance.now() / 1000 / RING_PERIOD) % 1;
  const pulse = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  ctx.save();
  ctx.strokeStyle = `rgba(245,165,36,${(0.35 + 0.55 * pulse).toFixed(3)})`;
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * (0.34 + 0.03 * pulse), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** A mini in the compact island is waiting on you, so the loop keeps its ring pulsing. */
export function miniBotsNeedAttention(): boolean {
  for (const mb of live.values()) if (mb.attention && onScreen(mb.canvas) && inGrid(mb.canvas)) return true;
  return false;
}

export const miniBotCount = () => live.size;
