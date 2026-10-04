// Notices on the compact island, one at a time, like an iPhone notification in
// the Dynamic Island: WhatsApp messages, and Claude Code sessions that finished
// while out of focus. Each stays a few seconds, then the next one in the queue
// takes its place, then back to whatever was there (the song, or the mini-grid).

import { h, svg } from "./dom";
import { ICONS } from "./icons";

export interface ToastMessage {
  from: string;
  text: string;
  at: number;
  /** Contact photo (data: URL) when the site sent one. */
  image?: string;
  /** Absent: a WhatsApp message. "session": a Claude Code session notice. */
  kind?: "whatsapp" | "session" | "discord";
  /** Bubble colour (the session's colour); WhatsApp green when absent. */
  color?: string;
  icon?: keyof typeof ICONS;
  /** How long it stays; SHOW_MS when absent. */
  ms?: number;
  /** Click action; the one given to createToasts when absent. */
  onOpen?: () => void;
  /** Runs when the notice comes on screen, so its sound plays in turn too. */
  onShow?: () => void;
  /** Built when the notice comes on screen: replaces the bubble (a mini Mochi),
   *  with `icon` as a small badge on it. Built late, so nothing animates unseen. */
  makeNode?: () => HTMLElement;
}

/** How long each message stays on the island. */
const SHOW_MS = 6_000;
/** Longest queue; the oldest WhatsApp messages go first, then the oldest notices. */
const MAX_QUEUE = 8;
const MAX_WHATSAPP = 3;
/** Compact width while a message is shown. */
export const TOAST_W = 320;

export interface Toasts {
  el: HTMLElement;
  /** True while a message is on screen. */
  readonly active: boolean;
  push(m: ToastMessage): void;
  sync(compact: boolean): void;
}

export function createToasts(onChange: () => void, onOpen: () => void): Toasts {
  const from = h("span", { class: "tw-from" });
  const text = h("span", { class: "tw-text" });
  const photo = h("img", { class: "tw-photo", alt: "" }) as HTMLImageElement;
  const glyph = h("span", { class: "tw-glyph" });
  const icon = h("div", { class: "tw-icon" }, glyph, photo);
  const el = h("div", { id: "toast" }, icon, h("div", { class: "tw-body" }, from, text));

  // The compact island opens on mousedown; a click on a message must not.
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    (current?.onOpen ?? onOpen)();
    next();
  });

  const queue: ToastMessage[] = [];
  let current: ToastMessage | null = null;
  let timer: number | null = null;

  const next = () => {
    current = queue.shift() ?? null;
    if (timer != null) window.clearTimeout(timer);
    timer = null;
    if (current) {
      from.textContent = current.from;
      text.textContent = current.text || "New message";
      el.title =
        current.kind === "session" ? "Go to this chat" : current.kind === "discord" ? "Open Discord" : "Open WhatsApp";
      if (current.image) photo.src = current.image;
      else photo.removeAttribute("src");
      icon.classList.toggle("has-photo", Boolean(current.image));
      const mark = svg(ICONS[current.icon ?? "bubble"], 11, current.icon === "check" ? { stroke: 2.6 } : {});
      const node = current.makeNode?.();
      glyph.replaceChildren(...(node ? [node, mark] : [mark]));
      icon.classList.toggle("has-node", Boolean(node));
      icon.style.setProperty("--badge", current.icon === "xmark" ? "#F4505E" : "#22C55E");
      icon.style.background = node ? "" : current.color ?? "";
      icon.style.boxShadow = !node && current.color ? `0 0 10px ${current.color}66` : "";
      icon.style.color = current.color ? "#0b0c0e" : "";
      el.classList.remove("in");
      void el.offsetWidth; // restart the entrance animation
      el.classList.add("in");
      current.onShow?.();
      timer = window.setTimeout(next, current.ms ?? SHOW_MS);
    }
    onChange();
  };

  return {
    el,
    get active() {
      return current != null;
    },
    push(m) {
      queue.push(m);
      // A burst of chat messages: the latest matter most. Session notices are
      // kept, each gets its turn.
      const whatsapp = () => queue.filter((q) => q.kind !== "session");
      while (whatsapp().length > MAX_WHATSAPP) queue.splice(queue.indexOf(whatsapp()[0]), 1);
      while (queue.length > MAX_QUEUE) queue.shift();
      if (!current) next();
    },
    sync(compact: boolean) {
      const on = compact && current != null;
      el.style.opacity = on ? "1" : "0";
      el.style.pointerEvents = on ? "auto" : "none";
    },
  };
}
