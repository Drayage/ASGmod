import type { Board, Cell, TerrainGrid } from "./types";

/**
 * ASCII layout for a map: one string per row, same length per row.
 * `.` empty · `#` obstacle · `P` player A start flower · `Q` player B start
 * flower · `G` empty cell with 온실(greenhouse) terrain — the flower
 * standing there is immune to conversion, and stays that way after any
 * later flower takes the cell over, since terrain is separate from
 * occupancy (see `applyAction` in rules.ts).
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
  {
    id: "stepping-stones",
    name: "돌다리 정원",
    description: "대각선으로 놓인 디딤돌을 씨앗 날리기로 뛰어넘는 초급 맵.",
    rows: [
      "P.....Q",
      ".#.....",
      "..#....",
      "...#...",
      "....#..",
      ".....#.",
      "Q.....P",
    ],
  },
  {
    id: "twin-ponds",
    name: "쌍둥이 연못",
    description: "작은 연못 두 개가 마주보는 초급 맵.",
    rows: [
      "P.....Q",
      ".......",
      ".##....",
      ".......",
      "....##.",
      ".......",
      "Q.....P",
    ],
  },
  {
    id: "four-leaf-clover",
    name: "네잎클로버 정원",
    description: "중앙을 비운 채 네 잎이 감싼 초급 맵.",
    rows: [
      "P.....Q",
      ".......",
      "...#...",
      "..#.#..",
      "...#...",
      ".......",
      "Q.....P",
    ],
  },
  {
    id: "fountain-plaza",
    name: "분수 광장",
    description: "가운데 분수를 빙 둘러싼 중급 맵.",
    rows: [
      "P.....Q",
      ".......",
      "..###..",
      "..#.#..",
      "..###..",
      ".......",
      "Q.....P",
    ],
  },
  {
    id: "winding-path",
    name: "굽이치는 산책로",
    description: "중앙을 향해 굽이치는 길이 이어지는 중급 맵.",
    rows: [
      "P..#..Q",
      "...#...",
      "..#.#..",
      ".#...#.",
      "..#.#..",
      "...#...",
      "Q..#..P",
    ],
  },
  {
    id: "secret-garden",
    name: "비밀의 정원",
    description: "X 표시 자리를 씨앗 날리기로만 밟을 수 있는 초급 맵.",
    rows: [
      "P.....Q",
      ".#...#.",
      ".......",
      "...#...",
      ".......",
      ".#...#.",
      "Q.....P",
    ],
  },
  {
    id: "royal-maze",
    name: "왕실 미로정원",
    description: "네 방향으로 도는 풍차 모양 미로, 고급 맵.",
    rows: [
      "P.....Q",
      "..#.#..",
      ".##.##.",
      ".......",
      ".##.##.",
      "..#.#..",
      "Q.....P",
    ],
  },
  {
    id: "greenhouse-garden",
    name: "온실 정원",
    description: "온실 칸의 꽃은 상대에게 물들지 않는 확장 맵.",
    rows: [
      "P.....Q",
      "...G...",
      ".......",
      ".G...G.",
      ".......",
      "...G...",
      "Q.....P",
    ],
  },
];

export const DEFAULT_MAP_ID = maps[0].id;

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

export function terrainFromMap(map: MapDef): TerrainGrid {
  return map.rows.map((row) => row.split("").map((ch) => (ch === "G" ? "GREENHOUSE" : "NONE")));
}
