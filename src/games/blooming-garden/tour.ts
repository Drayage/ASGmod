import type { Difficulty } from "./ai";
import { maps } from "./maps";
import type { Player } from "./types";

/** 정원 순회: play every registered map once, in order, against the AI,
 * alternating which side the human starts as so neither the maps nor the
 * turn order favour one player across the whole series. */
export interface TourState {
  difficulty: Difficulty;
  mapIds: string[];
  index: number;
  results: Array<Player | "DRAW">;
}

export function createTour(difficulty: Difficulty): TourState {
  return { difficulty, mapIds: maps.map((m) => m.id), index: 0, results: [] };
}

/** Which side the human plays for the leg at `index` — A on even legs, B on
 * odd ones, so a 10-map tour splits the human evenly between going first
 * and second. */
export function tourHumanSide(index: number): Player {
  return index % 2 === 0 ? "A" : "B";
}

export function isTourComplete(tour: TourState): boolean {
  return tour.index >= tour.mapIds.length;
}

export function currentTourMapId(tour: TourState): string | null {
  return tour.mapIds[tour.index] ?? null;
}

/** Records the just-finished leg's result and advances to the next map. */
export function advanceTour(tour: TourState, winner: Player | "DRAW"): TourState {
  return { ...tour, index: tour.index + 1, results: [...tour.results, winner] };
}

export interface TourScore {
  wins: number;
  losses: number;
  draws: number;
}

/** The human's record so far, scored against the side they were playing on
 * each individual leg (which alternates, so this can't just compare against
 * a single fixed side). */
export function tourScore(tour: TourState): TourScore {
  const score: TourScore = { wins: 0, losses: 0, draws: 0 };
  tour.results.forEach((winner, legIndex) => {
    if (winner === "DRAW") score.draws += 1;
    else if (winner === tourHumanSide(legIndex)) score.wins += 1;
    else score.losses += 1;
  });
  return score;
}
