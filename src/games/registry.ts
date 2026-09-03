import type { GameMeta } from "../shared/types";

/**
 * Add one entry per game here. Each game lives in its own folder under
 * src/games/<id>/ and is loaded lazily so the hub page stays light.
 * See src/games/README.md for the folder contract.
 */
const games: GameMeta[] = [
  {
    id: "alley-boss-cats",
    title: "골목대냥",
    description: "골목을 둘러싸고 상대 고양이의 도망길을 막으세요.",
    minPlayers: 2,
    maxPlayers: 2,
    load: () => import("./alley-boss-cats/game"),
  },
  {
    id: "blooming-garden",
    title: "꽃피는 정원",
    description: "가까운 화단엔 꽃을 피우고 먼 화단엔 씨앗을 날려 정원을 물들이세요.",
    minPlayers: 2,
    maxPlayers: 2,
    load: () => import("./blooming-garden/game"),
  },
];

export default games;

export function findGame(id: string): GameMeta | undefined {
  return games.find((g) => g.id === id);
}
