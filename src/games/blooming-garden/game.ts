import "./style.css";
import type { GameCleanup } from "../../shared/types";
import { mountGameScreen } from "./ui/GameScreen";
import { renderModeSelect } from "./ui/ModeSelect";
import { mountTourScreen } from "./ui/TourScreen";
import { maybeShowTutorial } from "./ui/Tutorial";

export function mount(container: HTMLElement): GameCleanup {
  let cleanupScreen: (() => void) | null = null;
  let active = true;

  function showModeSelect() {
    cleanupScreen?.();
    cleanupScreen = null;
    if (!active) return;
    container.innerHTML = "";
    renderModeSelect(
      container,
      (config) => {
        if (!active) return;
        container.innerHTML = "";
        cleanupScreen = mountGameScreen(container, config, showModeSelect);
      },
      (difficulty) => {
        if (!active) return;
        container.innerHTML = "";
        cleanupScreen = mountTourScreen(container, difficulty, showModeSelect);
      },
    );
  }

  maybeShowTutorial(container, showModeSelect);

  return () => {
    active = false;
    cleanupScreen?.();
    container.innerHTML = "";
  };
}
