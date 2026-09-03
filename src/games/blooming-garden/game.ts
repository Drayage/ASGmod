import "./style.css";
import type { GameCleanup } from "../../shared/types";
import { mountGameScreen } from "./ui/GameScreen";
import { renderModeSelect } from "./ui/ModeSelect";

export function mount(container: HTMLElement): GameCleanup {
  let cleanupScreen: (() => void) | null = null;
  let active = true;

  function showModeSelect() {
    cleanupScreen?.();
    cleanupScreen = null;
    if (!active) return;
    container.innerHTML = "";
    renderModeSelect(container, (config) => {
      if (!active) return;
      container.innerHTML = "";
      cleanupScreen = mountGameScreen(container, config, showModeSelect);
    });
  }

  showModeSelect();

  return () => {
    active = false;
    cleanupScreen?.();
    container.innerHTML = "";
  };
}
