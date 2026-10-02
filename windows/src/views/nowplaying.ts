// The song Spotify is playing, on the compact island: cover, title and artist
// (the title scrolls when it does not fit), previous / play-pause / next, and a
// hairline of progress along the bottom. It takes the mini-grid's place.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";

const ID = "integration_spotify";

/** Compact width while a song is shown: room for the text and the buttons. */
export const NOW_PLAYING_W = 340;

export interface NowPlaying {
  el: HTMLElement;
  sync(compact: boolean): void;
}

function spotify(): Record<string, unknown> | null {
  if (!State.settings.activeIntegrations.includes(ID)) return null;
  const d = State.integrations[ID]?.data as Record<string, unknown> | undefined;
  return d && d.running === true && d.title ? d : null;
}

/** A song is loaded (playing or paused) and the Spotify pill is switched on. */
export function spotifyShown(): boolean {
  return spotify() != null;
}

/** A song is actually playing (not just loaded and paused). */
export function spotifyPlaying(): boolean {
  return spotify()?.playing === true;
}

export function createNowPlaying(): NowPlaying {
  const art = h("img", { class: "np-art", alt: "" }) as HTMLImageElement;
  const title = h("span", { class: "np-title" });
  const artist = h("span", { class: "np-artist" });
  const viewport = h("div", { class: "np-viewport" }, title, artist);
  const fill = h("i", { class: "np-fill" });

  const button = (icon: string, action: "toggle" | "next" | "previous", label: string, size: number) => {
    const b = h("button", { class: action === "toggle" ? "np-btn main" : "np-btn", title: label }, svg(icon, size));
    // The compact island opens on mousedown: a button press must not.
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void Bridge.mediaControl(action);
    });
    return b;
  };
  const toggle = button(ICONS.play, "toggle", "Play", 12);
  const controls = h(
    "div",
    { class: "np-controls" },
    button(ICONS.previous, "previous", "Previous", 10),
    toggle,
    button(ICONS.next, "next", "Next", 10),
  );

  const el = h("div", { id: "now-playing" }, art, viewport, controls, h("div", { class: "np-bar" }, fill));

  let key = "";
  let timer: number | null = null;
  let data: Record<string, unknown> | null = null;

  const paint = () => {
    if (!data) return;
    const length = Number(data.lengthMs ?? 0);
    const base = Number(data.positionMs ?? 0);
    const at = Number(data.at ?? Date.now());
    const pos = Math.min(length, data.playing === true ? base + (Date.now() - at) : base);
    fill.style.width = length > 0 ? `${(pos / length) * 100}%` : "0";
  };

  return {
    el,
    sync(compact: boolean) {
      data = spotify();
      const show = compact && data != null;
      el.style.opacity = show ? "1" : "0";
      el.classList.toggle("on", show);
      if (!show || !data) {
        if (timer != null) window.clearInterval(timer);
        timer = null;
        return;
      }
      const playing = data.playing === true;
      const next = `${data.title}|${data.artist}|${data.art}|${playing}`;
      if (next !== key) {
        key = next;
        if (data.art) art.src = String(data.art);
        else art.removeAttribute("src");
        title.textContent = String(data.title);
        artist.textContent = String(data.artist ?? "");
        el.classList.toggle("paused", !playing);
        toggle.replaceChildren(svg(playing ? ICONS.pause : ICONS.play, 12));
        toggle.title = playing ? "Pause" : "Play";
        requestAnimationFrame(() => {
          const overflow = title.scrollWidth - viewport.clientWidth + 12;
          title.classList.toggle("scroll", overflow > 0);
          title.style.setProperty("--np-shift", `${-Math.max(0, overflow)}px`);
          title.style.setProperty("--np-dur", `${Math.max(5, overflow / 14)}s`);
        });
      }
      paint();
      if (timer == null) timer = window.setInterval(paint, 1000);
    },
  };
}
