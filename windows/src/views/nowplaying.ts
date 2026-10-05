// The song Spotify is playing, on the compact island: cover, title and artist
// (the title scrolls when it does not fit) and a dancing equaliser, the way the
// iPhone's Dynamic Island shows music. It takes the mini-grid's place.

import { h } from "./dom";
import { State } from "../core/state";
import { albumColor, cachedAlbumColor } from "./albumcolor";

const ID = "integration_spotify";
export const SPOTIFY_GREEN = "#1DB954";

/**
 * The Spotify pill takes the colour of the cover that is playing — her Mochi,
 * the pill, the player — and goes back to Spotify green without a song.
 */
export function syncSpotifyColor() {
  const d = spotify();
  const art = d?.art ? String(d.art) : "";
  const apply = (c: string | null | undefined) => {
    const t = State.tasks.find((x) => x.id === ID);
    const color = c ?? SPOTIFY_GREEN;
    if (t && t.color !== color) {
      t.color = color;
      State.notify();
    }
  };
  if (!art) return apply(null);
  const known = cachedAlbumColor(art);
  if (known !== undefined) return apply(known);
  void albumColor(art).then((c) => {
    // Still the same song by the time the cover is read.
    if ((spotify()?.art ?? "") === art) apply(c);
  });
}

/** Where the song is now, in ms: Spotify reports it on changes, the clock does the rest. */
export function spotifyPosition(d: Record<string, unknown>): { at: number; length: number } {
  const length = Number(d.lengthMs ?? 0);
  const base = Number(d.positionMs ?? 0);
  const since = Number(d.at ?? Date.now());
  const at = d.playing === true ? base + (Date.now() - since) : base;
  return { at: Math.max(0, Math.min(length, at)), length };
}

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

  // A hairline along the bottom of the island: how far into the song.
  const fill = h("i");
  const progress = h("div", { class: "np-progress" }, fill);

  const el = h("div", { id: "now-playing" }, art, viewport, eq, progress);

  let key = "";
  let data: Record<string, unknown> | null = null;
  // Once a second while a song plays on screen; nothing runs otherwise.
  let timer: number | null = null;
  const paintProgress = () => {
    if (!data) return;
    const { at, length } = spotifyPosition(data);
    fill.style.width = length > 0 ? `${((at / length) * 100).toFixed(2)}%` : "0";
  };
  const runTimer = (on: boolean) => {
    if (on && timer == null) timer = window.setInterval(paintProgress, 1000);
    if (!on && timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  return {
    el,
    sync(compact: boolean) {
      data = spotify();
      const show = compact && data != null;
      el.style.opacity = show ? "1" : "0";
      // Hidden at opacity 0 the bars and the scrolling title kept animating, and
      // WebKitGTK repainted them every frame: with Mochi on the other side of the
      // island, the update covered the whole island (see #now-playing:not(.on)).
      el.classList.toggle("on", show);
      runTimer(show && data?.playing === true);
      if (!show || !data) return;
      el.style.setProperty("--np-color", State.tasks.find((t) => t.id === ID)?.color ?? SPOTIFY_GREEN);
      paintProgress();
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
          // Scrolls there and back once for a new title, then rests: a title
          // that scrolled forever was repainted for the whole song.
          title.classList.remove("scroll");
          void title.offsetWidth;
          title.classList.toggle("scroll", overflow > 0 && playing);
          title.style.setProperty("--np-shift", `${-Math.max(0, overflow)}px`);
          title.style.setProperty("--np-dur", `${Math.max(5, overflow / 14)}s`);
        });
      }
    },
  };
}
