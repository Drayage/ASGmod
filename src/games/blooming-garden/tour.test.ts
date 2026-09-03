import { describe, expect, it } from "vitest";
import { maps } from "./maps";
import { advanceTour, createTour, currentTourMapId, isTourComplete, tourHumanSide, tourScore } from "./tour";

describe("createTour", () => {
  it("queues every registered map exactly once, starting at leg 0", () => {
    const tour = createTour("NORMAL");
    expect(tour.mapIds).toHaveLength(maps.length);
    expect(new Set(tour.mapIds).size).toBe(maps.length);
    expect(tour.index).toBe(0);
    expect(tour.results).toEqual([]);
  });
});

describe("tourHumanSide", () => {
  it("alternates starting side by leg index", () => {
    expect(tourHumanSide(0)).toBe("A");
    expect(tourHumanSide(1)).toBe("B");
    expect(tourHumanSide(2)).toBe("A");
    expect(tourHumanSide(9)).toBe("B");
  });
});

describe("advanceTour / isTourComplete", () => {
  it("is not complete until every leg has a recorded result", () => {
    let tour = createTour("EASY");
    expect(isTourComplete(tour)).toBe(false);
    for (let i = 0; i < maps.length - 1; i++) tour = advanceTour(tour, "A");
    expect(isTourComplete(tour)).toBe(false);
    tour = advanceTour(tour, "A");
    expect(isTourComplete(tour)).toBe(true);
  });

  it("returns the current leg's map id, and null once the tour is done", () => {
    let tour = createTour("HARD");
    expect(currentTourMapId(tour)).toBe(tour.mapIds[0]);
    for (const mapId of tour.mapIds) {
      expect(currentTourMapId(tour)).toBe(mapId);
      tour = advanceTour(tour, "DRAW");
    }
    expect(currentTourMapId(tour)).toBeNull();
  });
});

describe("tourScore", () => {
  it("scores each leg against the side the human was actually playing that leg", () => {
    let tour = createTour("NORMAL");
    // Leg 0: human is A, A wins -> human win.
    tour = advanceTour(tour, "A");
    // Leg 1: human is B, A wins -> human loss.
    tour = advanceTour(tour, "A");
    // Leg 2: human is A, draw.
    tour = advanceTour(tour, "DRAW");

    expect(tourScore(tour)).toEqual({ wins: 1, losses: 1, draws: 1 });
  });
});
