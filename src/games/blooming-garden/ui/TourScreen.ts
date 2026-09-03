import type { Difficulty } from "../ai";
import { findMap } from "../maps";
import { createInitialState } from "../rules";
import { advanceTour, createTour, currentTourMapId, isTourComplete, tourHumanSide, tourScore } from "../tour";
import type { TourState } from "../tour";
import { mountGameScreen } from "./GameScreen";

/** Orchestrates 정원 순회: one AI game per registered map, in order,
 * alternating which side the human starts as. Each leg is a normal
 * `mountGameScreen` instance — its result panel gets a "다음 맵" button
 * instead of restart (see `onTourNext` on `StartConfig`) that reports the
 * leg's winner back here and advances to the next map. */
export function mountTourScreen(container: HTMLElement, difficulty: Difficulty, onExit: () => void): () => void {
  let tour: TourState = createTour(difficulty);
  let cleanupGame: (() => void) | null = null;
  let cancelled = false;

  function abandon() {
    cancelled = true;
    cleanupGame?.();
    onExit();
  }

  function playLeg() {
    cleanupGame?.();
    cleanupGame = null;
    if (cancelled) return;

    if (isTourComplete(tour)) {
      renderSummary();
      return;
    }

    const mapId = currentTourMapId(tour)!;
    const humanSide = tourHumanSide(tour.index);
    const score = tourScore(tour);

    container.innerHTML = "";
    const progress = document.createElement("p");
    progress.className = "grdn-tour-progress";
    progress.textContent = `정원 순회 ${tour.index + 1}/${tour.mapIds.length} · ${findMap(mapId)?.name ?? mapId} · ${score.wins}승 ${score.losses}패 ${score.draws}무`;
    container.appendChild(progress);

    const stage = document.createElement("div");
    container.appendChild(stage);

    cleanupGame = mountGameScreen(
      stage,
      {
        mode: "AI",
        difficulty: tour.difficulty,
        humanSide,
        mapId,
        initialState: createInitialState(mapId),
        onTourNext: (winner) => {
          tour = advanceTour(tour, winner);
          playLeg();
        },
      },
      abandon,
    );
  }

  function renderSummary() {
    container.innerHTML = "";
    const score = tourScore(tour);

    const panel = document.createElement("div");
    panel.className = "grdn-result-panel";

    const heading = document.createElement("h2");
    heading.textContent = "정원 순회 완료!";
    panel.appendChild(heading);

    const line = document.createElement("p");
    line.textContent = `${tour.mapIds.length}개 정원 · ${score.wins}승 ${score.losses}패 ${score.draws}무`;
    panel.appendChild(line);

    const actions = document.createElement("div");
    actions.className = "grdn-result-actions";

    const againBtn = document.createElement("button");
    againBtn.type = "button";
    againBtn.textContent = "다시 순회하기";
    againBtn.addEventListener("click", () => {
      tour = createTour(difficulty);
      playLeg();
    });
    actions.appendChild(againBtn);

    const exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.textContent = "메뉴로";
    exitBtn.addEventListener("click", onExit);
    actions.appendChild(exitBtn);

    panel.appendChild(actions);
    container.appendChild(panel);
  }

  playLeg();

  return () => {
    cancelled = true;
    cleanupGame?.();
    container.innerHTML = "";
  };
}
