// The song Spotify is playing, on the compact island: cover, title and artist
// (the title scrolls when it does not fit) and a dancing equaliser, the way the
// iPhone's Dynamic Island shows music. It takes the mini-grid's place.

import { h } from "./dom";
import { State } from "../core/state";

const ID = "integration_spotify";

/** Compact width while a song is shown: room for the text and the equaliser. */
export const NOW_PLAYING_W = 320;

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

  // Dynamic-Island style equaliser: bars dance while a song plays, rest when paused.
  const eq = h("div", { class: "np-eq" });
  for (let i = 0; i < 5; i++) eq.append(h("i", { style: `animation-delay:${-i * 0.23}s` }));

  const el = h("div", { id: "now-playing" }, art, viewport, eq);

  let key = "";
  let data: Record<string, unknown> | null = null;

  return {
    el,
    sync(compact: boolean) {
      data = spotify();
      const show = compact && data != null;
      el.style.opacity = show ? "1" : "0";
      if (!show || !data) return;
      const playing = data.playing === true;
      const next = `${data.title}|${data.artist}|${data.art}|${playing}`;
      if (next !== key) {
        key = next;
        if (data.art) art.src = String(data.art);
        else art.removeAttribute("src");
        title.textContent = String(data.title);
        artist.textContent = String(data.artist ?? "");
        el.classList.toggle("paused", !playing);
        requestAnimationFrame(() => {
          const overflow = title.scrollWidth - viewport.clientWidth + 12;
          title.classList.toggle("scroll", overflow > 0);
          title.style.setProperty("--np-shift", `${-Math.max(0, overflow)}px`);
          title.style.setProperty("--np-dur", `${Math.max(5, overflow / 14)}s`);
        });
      }
    },
  };
}
