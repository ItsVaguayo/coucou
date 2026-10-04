// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { applySessionPrefs, handleHook, registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  // Registered together: awaited one by one they were as many IPC round trips
  // before the island could launch.
  await Promise.all([
    onEvent<boolean>("browser-focus", (on) => island.setBrowserFocus(on)),
    onEvent<{ from: string; text: string; at: number; image?: string }>("whatsapp", (m) => island.showMessage(m)),
    onEvent<{ from: string; text: string; at: number; image?: string }>("discord-message", (m) => {
      if (!State.settings.activeIntegrations.includes("integration_discord")) return;
      island.showMessage(
        { ...m, kind: "discord", color: "#5865F2", onOpen: () => void Bridge.discordControl("open") },
        "integration_discord",
      );
    }),
    onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onPolledCursor(x, y)),
    onEvent<string>("tray", (what) => {
      switch (what) {
        case "settings":
          setPaused(false);
          island.alert("settings");
          break;
        case "open":
          setPaused(false);
          island.alert(State.defaultView());
          break;
        case "pause":
          setPaused(!State.paused);
          if (State.paused) island.fsm.forceHidden();
          else island.reveal();
          break;
      }
    }),
    onEvent<null>("screen-changed", () => void Bridge.reposition()),
    // The settings window writes preferences; apply them here without a restart.
    onEvent<Settings>("settings-changed", (s) => {
      State.settings = { ...State.settings, ...s };
      island.applySettings();
      State.loadIntegrationTasks();
      applySessionPrefs();
      void refreshConfigured();
    }),
  ]);

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
    // Lets a browser console replay hook events: __coucou.hook({hook_event_name: …}).
    Object.assign(window, {
      __coucou: { island, State, hook: (p: Parameters<typeof handleHook>[1]) => handleHook(island, p) },
    });
  }
}

void main();
