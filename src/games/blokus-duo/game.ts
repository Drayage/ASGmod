import "./style.css";
import type { GameCleanup } from "../../shared/types";
import { mountFourColorGameScreen } from "./fourColor/ui/GameScreen";
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
    renderModeSelect(container, (result) => {
      if (!active) return;
      container.innerHTML = "";
      cleanupScreen =
        result.boardMode === "DUO"
          ? mountGameScreen(container, result.config, showModeSelect)
          : mountFourColorGameScreen(container, result.config, showModeSelect);
    });
  }

  showModeSelect();

  return () => {
    active = false;
    cleanupScreen?.();
    container.innerHTML = "";
  };
}
