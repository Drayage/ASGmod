/**
 * The same corner position, answered by the engine and by people.
 *
 * `corner-joseki-book.mts` scores the lines; this asks who plays them. For each
 * corner position that arose more than once, it lists what the engine chose as
 * its answer and what humans chose, side by side, so a gap in the book shows up
 * as a move people play and the engine never does.
 *
 *   npx vite-node corner-answer-compare.mts <engine-games> -- <human-games>
 *
 * Files before `--` are read as the engine's side, files after as people's.
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 3);
const MIN = Number(process.env.MIN ?? 3);

interface Answer { position: string; answer: string; cells: number; opp: number }
const engineAnswers: Answer[] = [];
const humanAnswers: Answer[] = [];
const seen = new Set<string>();

function loadRecords(path: string): any[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const recs = raw.records ?? raw.games ?? raw;
  return Array.isArray(recs) ? recs : [];
}

/**
 * @param engineSide when null, every move is treated as a person's.
 */
function collect(path: string, asEngine: boolean) {
  let recs: any[];
  try { recs = loadRecords(path); } catch { return; }
  for (const rec of recs) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (!rec.moveHistory) continue;
    const human: Player | null = rec.playerSide ?? null;
    const engine: Player | null = human && asEngine ? opponent(human) : null;

    let state: GameState = createInitialState();
    const size = state.board.length;
    const corners = [
      { name: "TL", r: 0, c: 0 }, { name: "TR", r: 0, c: size - 1 },
      { name: "BL", r: size - 1, c: 0 }, { name: "BR", r: size - 1, c: size - 1 },
    ];
    const seq = new Map<string, Array<{ side: Player; a: number; b: number }>>();
    const answered = new Map<string, boolean>();

    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (m.type === "PLACE") {
        const side = state.currentPlayer;
        const nearest = corners.reduce((best, k) =>
          Math.abs(m.row - k.r) + Math.abs(m.col - k.c) <
          Math.abs(m.row - best.r) + Math.abs(m.col - best.c) ? k : best);
        const dr = Math.abs(m.row - nearest.r);
        const dc = Math.abs(m.col - nearest.c);
        if (dr <= DEPTH && dc <= DEPTH) {
          const [a, b] = dr <= dc ? [dr, dc] : [dc, dr];
          const prior = seq.get(nearest.name) ?? [];
          // The answer we care about: the first reply by the other side.
          if (prior.length > 0 && prior[0].side !== side && !answered.get(nearest.name)) {
            answered.set(nearest.name, true);
            const position = `${prior.map((p) => `(${p.a},${p.b})`).join(" ")}`;
            const isEngineMove = engine !== null && side === engine;
            const rowOut = { position, answer: `(${a},${b})`, cells: 0, opp: 0, side, corner: nearest.name };
            (isEngineMove ? engineAnswers : humanAnswers).push(rowOut as Answer);
            (rowOut as any).__pending = true;
            (rowOut as any).__rec = rec;
          }
          seq.set(nearest.name, [...prior, { side, a, b }]);
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }

    // Fill in the final cell counts for the answers recorded above.
    const terr = calculateTerritories(state.board);
    for (const list of [engineAnswers, humanAnswers]) {
      for (const a of list as any[]) {
        if (!a.__pending || a.__rec !== rec) continue;
        a.__pending = false;
        const corner = corners.find((k) => k.name === a.corner)!;
        const near = (cell: { row: number; col: number }) => {
          const nearest = corners.reduce((best, k) =>
            Math.abs(cell.row - k.r) + Math.abs(cell.col - k.c) <
            Math.abs(cell.row - best.r) + Math.abs(cell.col - best.c) ? k : best);
          return nearest.name === corner.name;
        };
        a.cells = terr[a.side as Player].filter(near).length;
        a.opp = terr[opponent(a.side as Player)].filter(near).length;
      }
    }
  }
}

const split = process.argv.indexOf("--");
const engineFiles = process.argv.slice(2, split < 0 ? undefined : split);
const humanFiles = split < 0 ? [] : process.argv.slice(split + 1);
for (const f of engineFiles) collect(f, true);
for (const f of humanFiles) collect(f, false);

function tally(list: Answer[], who: string) {
  const byPos = new Map<string, Map<string, { n: number; cells: number; opp: number }>>();
  for (const a of list) {
    const inner = byPos.get(a.position) ?? new Map();
    const cur = inner.get(a.answer) ?? { n: 0, cells: 0, opp: 0 };
    cur.n += 1; cur.cells += a.cells; cur.opp += a.opp;
    inner.set(a.answer, cur);
    byPos.set(a.position, inner);
  }
  console.log(`\n===== ${who} =====`);
  for (const [pos, inner] of [...byPos.entries()].sort(
    (a, b) => [...b[1].values()].reduce((s, v) => s + v.n, 0) - [...a[1].values()].reduce((s, v) => s + v.n, 0),
  )) {
    const total = [...inner.values()].reduce((s, v) => s + v.n, 0);
    if (total < MIN) continue;
    console.log(`\nafter ${pos}   (${total} times)`);
    for (const [ans, v] of [...inner.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(
        `   answered ${ans.padEnd(8)}${String(v.n).padStart(4)}x   ` +
          `answerer ${(v.cells / v.n).toFixed(1)} cells, other side ${(v.opp / v.n).toFixed(1)}`,
      );
    }
  }
}

tally(engineAnswers, "the engine answering");
tally(humanAnswers, "people answering");
