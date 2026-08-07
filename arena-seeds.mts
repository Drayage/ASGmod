/**
 * Start positions taken from real games rather than from an empty board.
 *
 * The self-play arena has a blind spot that §3.8 measured: playing itself, the
 * engine converts 15.7% of its influence into territory; playing a human, it
 * converts 10.2%. The human concentrates and leaves the rest of the board
 * open, the engine spreads into that open space, and none of it ever closes.
 * Two engines both spreading never produce the situation, so a candidate aimed
 * at it is screened by an instrument reproducing half the defect.
 *
 * Seeding from a recorded position puts the engine back in the shape a human
 * built. It also makes the comparison paired: both arms of a mirrored pair
 * play out the *same* position, so the between-game variance that dominates
 * the empty-board arena (SD 3.29 cells over 96 games) is differenced away
 * rather than averaged over.
 *
 * One caveat travels with the seeds and is recorded on every game: several
 * seeds come from the same source game, so they are not independent draws.
 * Twenty games at three plies each give 60 seeds but 20 clusters, and an
 * interval computed as though there were 60 would be too narrow. `seedSource`
 * is written into each record so the analysis can cluster on it.
 */
import { readFileSync, existsSync } from "node:fs";
import { applyMove, createInitialState, isLegalMove, passTurn } from "./src/games/alley-boss-cats/rules";
import type { GameState } from "./src/games/alley-boss-cats/types";

export interface SeedMove {
  row: number;
  col: number;
}

export interface Seed {
  /** File and game id the position came from, for clustering the analysis. */
  source: string;
  /** Ply the position was taken at. */
  ply: number;
  /** Moves replayed from the empty board to reach it. `null` is a pass. */
  moves: Array<SeedMove | null>;
}

interface RecordedMove {
  type: string;
  row?: number;
  col?: number;
}

interface RecordedGame {
  id?: string;
  moveHistory: RecordedMove[];
}

export const DEFAULT_SEED_FILES = [
  "src/games/alley-boss-cats/testdata/humanGames.json",
  "docs/newbuild-games-32293a1.json",
  // Five verified exhibition games. Clusters are what the honest interval is
  // computed over and there were only twenty, so five more is a quarter more
  // power — and these are the longest, most territorial positions available,
  // which is the condition the candidates are meant to act in.
  "docs/pro-games-20230822.json",
];

/**
 * Positions from every recorded game at each requested ply.
 *
 * A ply is only usable if the game actually reached it and had not already
 * been decided there — a seed on a finished position would play zero moves and
 * contribute a margin that no candidate could have influenced.
 */
export function loadSeeds(files: string[], plies: number[]): Seed[] {
  const seeds: Seed[] = [];
  const wanted = [...plies].sort((a, b) => a - b);

  for (const path of files.filter((file) => existsSync(file))) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: RecordedGame[] };
    const file = path.split("/").pop() ?? path;

    parsed.records.forEach((record, index) => {
      const source = `${file}#${record.id ?? index}`;
      let state: GameState = createInitialState();
      const played: Array<SeedMove | null> = [];

      for (const move of record.moveHistory) {
        if (state.winner) break;
        if (move.type === "PASS") {
          state = passTurn(state);
          played.push(null);
        } else {
          // A recorded move can be illegal to replay only if the record and
          // the rules have drifted apart. Stopping is right: silently skipping
          // it would put every later move on a different board.
          if (!isLegalMove(state, move.row!, move.col!, state.currentPlayer)) break;
          state = applyMove(state, move.row!, move.col!);
          played.push({ row: move.row!, col: move.col! });
        }

        const ply = played.length;
        if (wanted.includes(ply) && !state.winner) {
          seeds.push({ source, ply, moves: [...played] });
        }
      }
    });
  }

  return seeds;
}

/**
 * Replays a seed onto a fresh board, refusing to return a desynced position.
 *
 * Returns every state including the empty board, not just the last one. The
 * arena's metrics are indexed by ply — `firstTerritoryTurn` returns a position
 * in the state list — so handing it a list that starts mid-game would report
 * turns relative to the seed and peak influence over only the part the engines
 * played. With the full history those numbers stay on the same scale as an
 * unseeded run and as the recorded games.
 */
export function replaySeed(seed: Seed): GameState[] {
  let state: GameState = createInitialState();
  const states: GameState[] = [state];
  for (const move of seed.moves) {
    if (move === null) {
      state = passTurn(state);
    } else {
      if (!isLegalMove(state, move.row, move.col, state.currentPlayer)) {
        throw new Error(`seed ${seed.source}@${seed.ply} desynced at ${move.row},${move.col}`);
      }
      state = applyMove(state, move.row, move.col);
    }
    states.push(state);
  }
  return states;
}
