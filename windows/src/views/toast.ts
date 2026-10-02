// WhatsApp messages on the compact island, one at a time, like an iPhone
// notification in the Dynamic Island: sender and message for a few seconds,
// then back to whatever was there (the song, or the mini-grid).

import { h, svg } from "./dom";
import { ICONS } from "./icons";

export interface ToastMessage {
  from: string;
  text: string;
  at: number;
  /** Contact photo (data: URL) when the site sent one. */
  image?: string;
}

/** How long each message stays on the island. */
const SHOW_MS = 6_000;
/** Compact width while a message is shown. */
export const TOAST_W = 320;

export interface Toasts {
  el: HTMLElement;
  /** True while a message is on screen. */
  readonly active: boolean;
  push(m: ToastMessage): void;
  sync(compact: boolean): void;
}

export function createToasts(onChange: () => void): Toasts {
  const from = h("span", { class: "tw-from" });
  const text = h("span", { class: "tw-text" });
  const photo = h("img", { class: "tw-photo", alt: "" }) as HTMLImageElement;
  const icon = h("div", { class: "tw-icon" }, svg(ICONS.bubble, 11), photo);
  const el = h("div", { id: "toast" }, icon, h("div", { class: "tw-body" }, from, text));

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
      if (current.image) photo.src = current.image;
      else photo.removeAttribute("src");
      icon.classList.toggle("has-photo", Boolean(current.image));
      el.classList.remove("in");
      void el.offsetWidth; // restart the entrance animation
      el.classList.add("in");
      timer = window.setTimeout(next, SHOW_MS);
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
      // Several in a row: keep the queue short, the latest matter most.
      while (queue.length > 3) queue.shift();
      if (!current) next();
    },
    sync(compact: boolean) {
      el.style.opacity = compact && current ? "1" : "0";
    },
  };
}
