import type { GameMeta } from "../shared/types";

/**
 * Add one entry per game here. Each game lives in its own folder under
 * src/games/<id>/ and is loaded lazily so the hub page stays light.
 * See src/games/README.md for the folder contract.
 */
const games: GameMeta[] = [
  // {
  //   id: "example",
  //   title: "예시 게임",
  //   description: "한 줄 설명",
  //   minPlayers: 2,
  //   maxPlayers: 2,
  //   load: () => import("./example/game"),
  // },
];

export default games;

export function findGame(id: string): GameMeta | undefined {
  return games.find((g) => g.id === id);
}
