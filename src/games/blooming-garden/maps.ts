import type { Board, Cell } from "./types";

/**
 * ASCII layout for a map: one string per row, same length per row.
 * `.` empty · `#` obstacle · `P` player A start flower · `Q` player B start flower.
 * Every map here is symmetric under a corner-swapping reflection so neither
 * starting corner is structurally favoured (see games/README design notes).
 */
export interface MapDef {
  id: string;
  name: string;
  description: string;
  rows: string[];
}

export const maps: MapDef[] = [
  {
    id: "practice-garden",
    name: "연습 정원",
    description: "장애물이 없는 표준 맵. 처음 배울 때 좋습니다.",
    rows: [
      "P.....Q",
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
      "Q.....P",
    ],
  },
  {
    id: "central-pond",
    name: "중앙 연못",
    description: "중앙의 연못이 대규모 감염을 막고 좌우 우회로를 만듭니다.",
    rows: [
      "P.....Q",
      ".......",
      "...#...",
      "..###..",
      "...#...",
      ".......",
      "Q.....P",
    ],
  },
  {
    id: "four-pots",
    name: "네 개의 화분",
    description: "네 개의 화분이 대칭으로 놓인 초급 맵.",
    rows: [
      "P.....Q",
      ".......",
      "..#.#..",
      ".......",
      "..#.#..",
      ".......",
      "Q.....P",
    ],
  },
];

const DEFAULT_MAP_ID = maps[0].id;

export function findMap(id: string): MapDef | undefined {
  return maps.find((m) => m.id === id);
}

export function resolveMap(id: string): MapDef {
  return findMap(id) ?? findMap(DEFAULT_MAP_ID)!;
}

const CHAR_TO_CELL: Record<string, Cell> = {
  ".": "EMPTY",
  "#": "OBSTACLE",
  P: "PLAYER_A",
  Q: "PLAYER_B",
};

export function boardFromMap(map: MapDef): Board {
  return map.rows.map((row) => row.split("").map((ch) => CHAR_TO_CELL[ch] ?? "EMPTY"));
}
