// The Discord call on the compact island: the channel and everyone in it, with a
// green ring on whoever is talking — like the now-playing strip, and in its
// place while a call is on (a call matters more than the song).

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";

const ID = "integration_discord";
const MAX_FACES = 7;

/** Compact width while a call is shown. */
export const VOICE_W = 300;

interface Member {
  id: string;
  name: string;
  avatar: string;
  speaking: boolean;
  mute: boolean;
  deaf: boolean;
}

function call(): { channel: string; members: Member[] } | null {
  if (!State.settings.activeIntegrations.includes(ID)) return null;
  const d = State.integrations[ID]?.data as Record<string, unknown> | undefined;
  const channel = d?.channel as { name?: string } | null | undefined;
  if (d?.running !== true || !channel) return null;
  return { channel: String(channel.name ?? ""), members: (d.members as Member[] | undefined) ?? [] };
}

/** In a Discord voice channel, with the Discord pill switched on. */
export function discordInCall(): boolean {
  return call() != null;
}

export interface VoiceStrip {
  el: HTMLElement;
  sync(show: boolean): void;
}

export function createVoiceStrip(): VoiceStrip {
  const name = h("span", { class: "vc-name" });
  const faces = h("div", { class: "vc-faces" });
  const el = h("div", { id: "voice-call" }, svg(ICONS.headset, 11), name, faces);

  // Rebuilt only when someone joins or leaves; talking just flips a class, as
  // it changes several times a second during a conversation.
  let roster = "";
  const byId = new Map<string, HTMLElement>();

  return {
    el,
    sync(show: boolean) {
      const c = show ? call() : null;
      el.style.opacity = c ? "1" : "0";
      if (!c) return;
      name.textContent = c.channel;
      const shown = c.members.slice(0, MAX_FACES);
      const next = shown.map((m) => `${m.id}:${m.avatar}`).join("|") + `|${c.members.length}`;
      if (next !== roster) {
        roster = next;
        byId.clear();
        faces.replaceChildren();
        for (const m of shown) {
          const face = h("span", { class: "vc-face", title: m.name }, h("img", { src: m.avatar, alt: "" }));
          byId.set(m.id, face);
          faces.append(face);
        }
        if (c.members.length > MAX_FACES) {
          faces.append(h("span", { class: "vc-more", text: `+${c.members.length - MAX_FACES}` }));
        }
      }
      for (const m of shown) {
        const face = byId.get(m.id);
        if (!face) continue;
        face.classList.toggle("speaking", m.speaking);
        const flag = m.deaf ? "deaf" : m.mute ? "mute" : "";
        if (face.dataset.flag !== flag) {
          face.dataset.flag = flag;
          face.querySelector("i")?.remove();
          if (flag) face.append(h("i", {}, svg(flag === "deaf" ? ICONS.headsetOff : ICONS.micOff, 6)));
        }
      }
    },
  };
}
