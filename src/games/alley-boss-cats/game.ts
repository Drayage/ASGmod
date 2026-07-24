import "./style.css";
import type { GameCleanup } from "../../shared/types";
import { setSoundEnabled } from "./sound";
import { loadSettings } from "./storage";
import { mountGameScreen } from "./ui/GameScreen";
import { renderModeSelect } from "./ui/ModeSelect";
import { maybeRenderTutorial } from "./ui/Tutorial";

export function mount(container: HTMLElement): GameCleanup {
  setSoundEnabled(loadSettings().soundEnabled);

  let cleanupScreen: (() => void) | null = null;
  let active = true;

  function showModeSelect() {
    cleanupScreen?.();
    cleanupScreen = null;
    if (!active) return;
    container.innerHTML = "";
    renderModeSelect(container, (config) => {
      container.innerHTML = "";
      maybeRenderTutorial(container, () => {
        if (!active) return;
        container.innerHTML = "";
        cleanupScreen = mountGameScreen(container, config, showModeSelect);
      });
    });
  }

  showModeSelect();

  return () => {
    active = false;
    cleanupScreen?.();
    container.innerHTML = "";
  };
}
