import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./groups";
import { applyMove, getLegalMoves, passTurn } from "./rules";
import {
  closableInfluence,
  framePotential,
  influenceCount,
  influenceCountFromMap,
  influenceCountWeightedFromMap,
  influenceOwnerMap,
  expectedOpenGroundFromMap,
  settledOutOfInfluenceEnabled,
} from "./engine/territoryPlanner";
import { ownershipMargin } from "./engine/ownershipTerm";
import { frameworkPotential } from "./engine/frameworks";
import { coordKeySet } from "./territory";
import { DIRECTIONS, FIRST_PLAYER_MARGIN, inBounds, opponent, playerCell } from "./types";
import type { Board, Coord, GameState, Player } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD" | "VERY_HARD";

/** Difficulties whose move is computed by the search engine in a worker. */
export type SearchDifficulty = Extract<Difficulty, "HARD" | "VERY_HARD">;

export type AIAction = { type: "PLACE"; row: number; col: number } | { type: "PASS" };

export function applyAction(state: GameState, action: AIAction): GameState {
  return action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
}

/**
 * What a cell of open ground is worth next to a cell already settled — it still
 * has to be won, so it counts for less, but not for nothing.
 *
 * Swept in the arena at 0.12 / 0.30 / 0.50. Over 12-game matches 0.30 looked
 * like a clear win (VERY_HARD vs HARD scoring 92% / 100% / 75%), but re-running
 * the top two over 24 games put them at 67% and 63% — that gap was sampling
 * noise, not strength, so the original value stands. 0.50 was genuinely worse:
 * that far up, open ground outweighs shape and the search walks into captures
 * chasing it.
 *
 * Worth knowing before tuning this again: the term is deliberately timid, and it
 * can be too timid to see a loss coming. On a position where 고등어냥 trailed by
 * 22 cells of open ground, the deficit priced at 2.64 — less than the three
 * cells 치즈냥 owes — so the count read as *ahead* while a whole side of the
 * board was being mapped out against it. Raising the weight does not fix that;
 * it just trades the error for a worse one.
 */
const INFLUENCE_TO_TERRITORY = 0.12;

/**
 * How far ahead `player` is *on the actual win condition*, in cells.
 * Positive means they currently take the territory count.
 *
 * The evaluation used to score both sides' territory symmetrically and never
 * mention the first-player margin at all, so the engine had no idea whether it
 * was winning: as 고등어냥 it did not know a tie goes to it, and as 치즈냥 it
 * did not know three cells were owed. Without that, "am I ahead, and should I
 * be consolidating or forcing matters?" is a question it could not even ask.
 */
function projectedMarginFrom(
  state: GameState,
  player: Player,
  influence: Record<Player, number>,
  /**
   * Open ground as the territory term should price it. The plain influence
   * count when the closability term is off, and the discounted credit when it
   * is on — passed in rather than derived so the caller can build the owner
   * map once and use it for both.
   */
  open: Record<Player, number> = influence,
  /**
   * True when `open` is already in cells of expected territory rather than a
   * raw reach count, in which case it is added as-is instead of being scaled by
   * `INFLUENCE_TO_TERRITORY`. See `expectedOpenGroundFromMap`.
   */
  openInCells = false,
): number {
  // With the learned term on, the open points are priced by the cached
  // ownership map instead of by influence reach. Settled ground is counted
  // exactly either way — only the guess about what is still open changes,
  // which is the one part measurement says is wrong: influence claims ground
  // it holds 32% of the time, the net 71%.
  //
  // Falls through to the shipped term whenever there is no map, so a build
  // without the net, or a position primed before it loaded, plays as before.
  if (tuning.ownershipWeight > 0) {
    const learned = ownershipMargin(state, "A");
    if (learned !== null) {
      const blended =
        learned * tuning.ownershipWeight +
        (state.territories.A.length -
          state.territories.B.length +
          (influence.A - influence.B) * INFLUENCE_TO_TERRITORY) *
          (1 - tuning.ownershipWeight);
      return player === "A" ? blended - FIRST_PLAYER_MARGIN : FIRST_PLAYER_MARGIN - blended;
    }
  }

  const projected = (side: Player) =>
    state.territories[side].length + (openInCells ? open[side] : open[side] * INFLUENCE_TO_TERRITORY);

  const lead = projected("A") - projected("B");
  // 치즈냥 (A) moves first and must finish at least FIRST_PLAYER_MARGIN ahead;
  // anything short of that is a win for 고등어냥 (B).
  return player === "A" ? lead - FIRST_PLAYER_MARGIN : FIRST_PLAYER_MARGIN - lead;
}

export function projectedMargin(state: GameState, player: Player): number {
  return projectedMarginFrom(state, player, influenceCount(state.board));
}


interface ShapeStats {
  totalLiberties: number;
  /** Groups down to a single escape route — one move from being destroyed. */
  atari: number;
  /** Groups down to two escape routes — one move from atari. */
  nearAtari: number;
  /** Of the above, the ones that can reach three liberties in a single move.
   * Pressure on these threatens nothing the opponent cannot decline. */
  escapableAtari: number;
  escapableNearAtari: number;
  /** Groups at three liberties or fewer that no move can give more of.
   * Not a count of how thin they are — a count of the ones already finished. */
  sealed: number;
  /**
   * Liberties of an endangered group that could still be enclosed into an eye:
   * no enemy stone beside them, and at most two empty neighbours to fill.
   *
   * One eye is life here, because confirmed territory can never be played by
   * either side, so this is the count of a thin group's ways to live. It falls
   * when the opponent takes one — and it falls when the group's own owner plays
   * on it, which is how the engine lost both games it was traced through.
   */
  eyeSpace: number;
  /** A group sitting on exactly three liberties — not yet urgent by the
   * atari/nearAtari tests, but a real category of its own. A group this thin
   * can be walked down to atari in a few unanswered opponent moves with no
   * warning beforehand: at three liberties the evaluation used to treat it
   * exactly like a group with ten, so nothing made defending — or not
   * extending into — it outscore whatever else was on offer until it was
   * already too late to matter. Counted at any group size, not just a lone
   * stone: a real loss walked a *two*-stone group into exactly this shape
   * (extending a lone cat one more step into a pocket already half-ringed by
   * the opponent), and a single-stone-only test never saw it coming. */
  thin: number;
  /** Groups with a liberty inside their owner's confirmed territory. Nobody
   * may ever play there, so that breath is permanent and the group can never
   * be captured — the local equivalent of an eye. */
  immortal: number;
  connectedBonus: number;
  isolated: number;
}

/**
 * Can this group lift itself to three or more liberties in a single move?
 *
 * Asked of groups already at one or two liberties, to tell pressure that
 * threatens something from pressure the opponent simply steps out of. Measured
 * over 13 recorded games, the engine squeezed a group to two liberties or fewer
 * on 35% of its moves against a person's 22%, and 63 of those were escapable —
 * 19 of them gaining it no ground and settling nothing, nine on a turn when a
 * seal of two cells or more was sitting there. The person did that none times.
 *
 * Done by set arithmetic rather than by playing the move: after filling liberty
 * p the group's liberties are the others it had, plus p's own empty neighbours.
 * Four lookups per liberty, at most two liberties, so it costs a few operations
 * per endangered group at a leaf the search visits constantly.
 *
 * Deliberately pessimistic about escaping in two places: it ignores that the
 * escape might join a friendly group and inherit its liberties, and it ignores
 * captures. Both make a real escape look impossible, which leaves the bonus at
 * full strength — the erring direction that changes least.
 */
function escapesInOneMove(board: Board, liberties: Set<string>): boolean {
  for (const filled of liberties) {
    const [row, col] = filled.split(",").map(Number);
    const after = new Set<string>();
    for (const other of liberties) if (other !== filled) after.add(other);
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      if (board[r][c] === "EMPTY") after.add(`${r},${c}`);
    }
    if (after.size >= 3) return true;
  }
  return false;
}

/**
 * Can this group ever hold more liberties than it does now?
 *
 * Liberty counts alone do not separate a group with three liberties in open
 * space from one with three inside a pocket that is being closed. The engine
 * priced both at `thin`, fifteen points, and lost two recorded games the same
 * way: a group sat at three liberties for four of its own turns with escapes
 * available the whole time, the opponent finished the wall, and from that move
 * on nothing could raise its liberty count. It only registered at atari, two
 * moves later, when the search returns -1,000,000 and there is nothing to play.
 *
 * The dividing question is this one, and it flips exactly where the games did.
 * Liberties only grow by playing on one of them, so it needs no move
 * enumeration: after filling p the group holds its other liberties, p's empty
 * neighbours, and — if p touches a friendly group — that group's liberties too.
 * Checked against full enumeration over 9,112 recorded positions, it never once
 * called a group sealed that could still breathe; it under-reports instead,
 * which is the direction that cannot invent a dead group.
 */
export function canBreathe(board: Board, group: Coord[], liberties: Set<string>, player: Player): boolean {
  const own = playerCell(player);
  const inGroup = new Set(group.map((stone) => `${stone.row},${stone.col}`));
  for (const filled of liberties) {
    const [row, col] = filled.split(",").map(Number);
    const after = new Set<string>();
    for (const other of liberties) if (other !== filled) after.add(other);
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      if (board[r][c] === "EMPTY") after.add(`${r},${c}`);
      else if (board[r][c] === own && !inGroup.has(`${r},${c}`)) {
        for (const key of getGroupLiberties(board, getConnectedGroup(board, r, c))) {
          if (key !== filled) after.add(key);
        }
      }
    }
    if (after.size > liberties.size) return true;
  }
  return false;
}

/**
 * Liberty count at or below which `sealed` is even asked about.
 *
 * The earlier sealedWeight experiment (see its comment) varied only the
 * *price* of a sealed group and kept this gate at 3, and found the price did
 * not matter: game two's tracked group survived at every weight while a
 * different group died the same way, because by three liberties the slow
 * enclosure this is meant to answer is usually already finished — see
 * `capture-blame.mts` and `sealed-check.mts` on three recorded 2026-08-14
 * games, where `canBreathe` called a group sealed one to four liberties before
 * this gate would have looked: ply 31 at five liberties in one, ply 32 and 40
 * at four in the other two, all three or four plies ahead of when the group
 * actually became uncapturable-to-defend.
 *
 * 3 reproduces the shipped gate exactly. Raising it is the untried half of
 * that experiment — the detector was already shown sound over 9,112 positions
 * above; what was never varied is how early it is allowed to speak.
 */
export let sealedLibertyThreshold = 3;
export function setSealedLibertyThreshold(value: number): void {
  sealedLibertyThreshold = value;
}

/** One pass over a player's groups collecting everything the evaluation
 * needs. Computing these separately re-walked the whole board per term. */
function shapeStats(state: GameState, player: Player): ShapeStats {
  const stats: ShapeStats = {
    totalLiberties: 0,
    atari: 0,
    nearAtari: 0,
    escapableAtari: 0,
    escapableNearAtari: 0,
    sealed: 0,
    eyeSpace: 0,
    thin: 0,
    immortal: 0,
    connectedBonus: 0,
    isolated: 0,
  };
  const ownTerritory = coordKeySet(state.territories[player]);
  // At weight 1 the escapable split cannot change the score — the two branches
  // add back to exactly what the term was before it existed — so the work must
  // not be done. Shipped with this ungated, and it cost the search most of a
  // ply at every leaf for a number nothing read.
  const splitEscapable = tuning.escapablePressureWeight !== 1;
  const countSealed = tuning.sealedWeight !== 0;
  const countEyeSpace = tuning.eyeSpaceWeight !== 0;
  const enemyCell = playerCell(opponent(player));
  for (const group of getAllGroups(state.board, player)) {
    const liberties = getGroupLiberties(state.board, group);
    stats.totalLiberties += liberties.size;
    // Territory only forms with a single-colour border, so a liberty that is
    // this player's territory can never be filled by anyone: the group is
    // safe for the rest of the game, whatever its liberty count says.
    let immortal = false;
    for (const liberty of liberties) {
      if (ownTerritory.has(liberty)) {
        immortal = true;
        break;
      }
    }
    if (immortal) stats.immortal += 1;
    else if (liberties.size === 1) {
      stats.atari += 1;
      if (splitEscapable && escapesInOneMove(state.board, liberties)) stats.escapableAtari += 1;
    } else if (liberties.size === 2) {
      stats.nearAtari += 1;
      if (splitEscapable && escapesInOneMove(state.board, liberties)) {
        stats.escapableNearAtari += 1;
      }
    } else if (liberties.size === 3) stats.thin += 1;
    // Asked of anything already down to three, and only when the term is on —
    // the cost of a number nothing reads is what broke the last build.
    if (
      countSealed &&
      !immortal &&
      liberties.size <= sealedLibertyThreshold &&
      !canBreathe(state.board, group, liberties, player)
    ) {
      stats.sealed += 1;
    }
    // Counted in the same pass over the same liberties, so it costs a neighbour
    // scan and nothing else. Gated all the same.
    if (countEyeSpace && !immortal && liberties.size <= 3) {
      for (const key of liberties) {
        const [row, col] = key.split(",").map(Number);
        let empties = 0;
        let enemyBeside = false;
        for (const [dr, dc] of DIRECTIONS) {
          const r = row + dr;
          const c = col + dc;
          if (!inBounds(r, c)) continue;
          if (state.board[r][c] === enemyCell) { enemyBeside = true; break; }
          if (state.board[r][c] === "EMPTY") empties += 1;
        }
        if (!enemyBeside && empties <= 2) stats.eyeSpace += 1;
      }
    }
    stats.connectedBonus += group.length - 1;
    if (group.length === 1) stats.isolated += 1;
  }
  return stats;
}

/**
 * Evaluation weights the arena can vary so one engine can be played against
 * another that differs in exactly one term. The app never touches these — it
 * always plays the shipped defaults — but tuning by win rate against a scripted
 * bot has repeatedly proved unreliable here, because those games are decided by
 * a capture race long before the territory count matters. A head-to-head
 * between two otherwise identical engines is the only clean way to ask whether
 * a term is worth anything.
 *
 * A weight of zero must cost nothing, so each term guards on it.
 */
export const tuning = {
  frameworkWeight: 0,
  /**
   * How far to trust the learned ownership map over the influence heuristic
   * when pricing open ground, from 0 (shipped behaviour, exactly) to 1.
   *
   * A weight of zero must cost nothing, so the term is not consulted at all
   * there and no map is computed for the move.
   */
  ownershipWeight: 0,
  /**
   * Cells of urgency at which a sealing move stops being postponable and is
   * offered to the search as the move to consider. Zero disables the check
   * entirely, reproducing shipped behaviour.
   *
   * Urgency is what the opponent can take away: settle the region now versus
   * let them block the point and settle what is left. Measured over 20 recorded
   * games, the engine declined 12 seals it could not really postpone, giving up
   * 24 cells; the human declined none. Games were lost by 10 to 13.
   */
  urgentSealUrgency: 0,
  /**
   * How hard to discount open ground the side cannot close yet.
   *
   * Each connected influence region is credited its size times this raised to
   * the number of open points on its border beyond the first — roughly the
   * moves it would take to seal. 1 disables the term and reproduces the plain
   * count exactly, cell for cell.
   *
   * The gap it is aimed at: over 335 midgame positions the engine converts
   * 10.2% of its reach into territory and the human 33.8%, and the engine's
   * reach is one 21.5-cell region with a quarter of its border open where the
   * human's is six regions of 5.6 cells with 18.6% open. The plain count
   * prices those the same.
   */
  closabilityDecay: 1,
  /**
   * Price open ground by the size of the region it sits in, rather than at one
   * flat rate per cell.
   *
   * Measured on the engine's own influence map over 17 games decided by the
   * count: at turn 31 a cell in a region of five to seven became its
   * claimant's territory 85% of the time, and 31% once the region reached
   * twelve or more. Both players sit on the same curve. What separates them is
   * which side of it they are on — at turn 37 the human's largest dominated
   * room is 11.1 cells and the engine's is 18.6, and the engine finishes with
   * 1.5 cells in regions of six or more against the human's 7.0.
   *
   * The flat rate cannot express that, so it overprices the sprawling frame the
   * engine keeps and never closes. Off until measured; see `aiVariant.ts`.
   */
  influenceRegionCurve: false,
  /**
   * Price open ground as the cells it is expected to become, instead of at a
   * flat 0.12 per cell of reach.
   *
   * The flat rate is wrong twice over. Measured against what those cells became
   * — 922 positions across 17 games decided by the count — the pooled rate is
   * 0.57, and it ranges from 0.24 for a sprawling region early to 0.98 for a
   * tight one late. So the scale is about five times too low *and* the shape is
   * missing, and the two have to be fixed together: raising the scalar alone was
   * tried and made things worse, and reshaping while holding the scale was tried
   * and moved a candidate by 3.5 points against a 36-point gap to the next one.
   *
   * This is the one change in this branch that can plausibly make the engine
   * worse rather than merely useless — it raises what territory is worth against
   * every tactical term, and being captured once loses outright here. Off until
   * the arena has had a look at the capture count.
   */
  calibratedOpenGround: false,
  /**
   * Multiplier on the two terms that pay for keeping stones together —
   * `connectedBonus * 3` and `-isolated * 5`. 1 is the shipped behaviour.
   *
   * Added because the engine's influence is one connected mass where every
   * human's is several: 3.8 regions with 75% of the influence in the largest,
   * against 5.6-6.3 regions and about 50%. Influence follows the stones, and
   * these are the only terms that speak about where stones sit relative to
   * each other.
   *
   * Not yet measured. Setting it to zero and re-picking a single move from
   * recorded positions changed the resulting shape by nothing at all, but
   * that test cannot answer the question: those positions already contain a
   * blob built over twenty previous moves, and no one move undoes it. Only a
   * full playout can say, and the only playouts available are against another
   * engine, which is not where the blob costs anything.
   *
   * Whatever it is worth, expect a cost in safety alongside it: a lone stone
   * is also a stone that can be hunted, and a capture loses outright.
   */
  connectionWeight: 1,
  /**
   * Points scored per empty point that is one stone away from being territory.
   *
   * Aimed at one measured number. A seal of two cells or more is available to
   * the engine on 11% of its turns and to every human category on 24 to 27,
   * and every territory candidate so far has been a knob acting on structure
   * that was not there. This is the first that tries to create it.
   *
   * An evaluation term rather than a shortlist. Offering these moves as a
   * candidate list instead took the move away from answering the opponent and
   * broke two tests that exist to keep those answers — building a frame is
   * what to do when nothing else is demanded, which is a matter of degree and
   * so belongs in the score.
   *
   * Zero, because it does not work. Measured over 589 recorded engine turns by
   * re-picking each move on static evaluation alone, the share of turns leaving
   * a 2+ seal on offer went 5.9% at weight 0 to 5.8% at 14 and 30, and 7.0% at
   * 60. The target was 26-29%.
   *
   * Not inert for a mechanical reason, which was the first thing checked: the
   * term spreads 2.14 points across the average move pool and changes the
   * chosen move on 3.5% of turns at weight 14, 7.5% at 30 and 15.8% at 60. It
   * moves the engine; the seals just do not follow, and weight 60 is already
   * loud enough to drown terms that decide games.
   *
   * The likely reason, consistent with everything else measured here: a point
   * three-quarters walled is a consequence of a wall, not a cause of one, so
   * paying for it buys the symptom. Kept at zero rather than deleted because
   * the term is the cheapest handle on that structure if a later idea needs one.
   */
  frameWeight: 0,
  /**
   * What pressure is worth when the opponent can walk out of it in one move.
   *
   * The evaluation pays `theirs.atari * 45` and `theirs.nearAtari * 16` whether
   * or not the squeeze threatens anything, while a two-cell seal is worth about
   * 24 through projectedMargin. So an atari the opponent simply steps out of
   * outprices settled ground, and the search takes it.
   *
   * Measured over 13 recorded games: the engine drove a group to two liberties
   * or fewer on 35% of its moves against a person's 22%, and spent 1.5 moves a
   * game on squeezes that could not catch anything, gained it no reach and
   * settled nothing — the person spent 0.7. Nine of those 19 came on a turn
   * when a 2+ cell seal was available; the person did that zero times out of
   * nine.
   *
   * 1 is the shipped behaviour exactly. Lower pays less for pressure the
   * opponent can decline, while leaving pressure on groups that cannot escape
   * at full price — the distinction the player drew, and the whole point.
   */
  escapablePressureWeight: 1,
  /**
   * Points charged for one of my own groups that can no longer gain a liberty,
   * and credited for one of theirs. Zero is the shipped evaluation exactly, and
   * skips the test entirely.
   *
   * Aimed at the way the engine actually loses groups. Traced over two recorded
   * games: three liberties for four of its own turns with escapes available,
   * then the wall closes and nothing raises the count again, then atari, then
   * captured. `thin` charges fifteen points for that whole slide and never
   * distinguishes the half of it that is already lost.
   *
   * It works through the search rather than at the root — the position where a
   * group becomes sealed is a few plies ahead of the move that allows it, and
   * that is the move this is meant to change.
   *
   * Zero, because it does not. Playing both lost positions out from turn 13 at
   * the shipped budget: game one survives at weight 0, loses at 60, survives at
   * 150; game two loses at all three. Noise, and worse than off in one of them.
   *
   * The detection is sound and the play is not, which are separate things. And
   * one playout says why the shape of this was wrong: in game two the tracked
   * group ends alive on four liberties and the engine still loses by capture,
   * because a different group went the same way. The slow enclosure happens
   * wherever a group is left at three liberties, so answering it one group at a
   * time was never going to be enough.
   */
  sealedWeight: 0,
  /**
   * Points per liberty of a thin group that could still be closed into an eye.
   * Zero is the shipped evaluation exactly, and skips the count.
   *
   * The player's read of why groups die: with nobody to connect to, the move is
   * to wall off a point of your own rather than keep extending, and the engine
   * never tries it. Traced through both lost games and it is worse than that —
   * the eye was available for nine turns in each, and on turn 13 the engine
   * played the eye point itself, which is what ended the group.
   *
   * `immortal` pays 30 for a finished eye and nothing for one two moves off, so
   * an extension that adds liberties immediately always outbids starting one.
   * This is the missing half: ground that is still closeable is worth something
   * while it is still closeable.
   *
   * Unlike the three terms that measured zero today, this one bites on the move
   * itself rather than through lookahead — filling the point drops the count at
   * depth one, in the same evaluation that is choosing the move.
   *
   * Zero, and the reason is not that the count is wrong. It moves exactly as
   * intended: at turn 13 of the first lost game, filling the eye scores three
   * units below the best alternative, which at weight 60 is 180 points.
   *
   * The evaluation is simply not asked unless `eyeMakingDefenceEnabled` puts
   * something on the list to choose between: `existingGroupDanger` builds its
   * candidates from the group's own liberties, and on the traced position that
   * left one candidate out of sixty-six — the eye-filling move — unchanged even
   * at weight 300. The two are one change and are shipped together.
   *
   * On by default. Over 68 paired arena games the pair is worth +2.43 cells
   * with the interval clear of zero, 24 source games to 7 at p = 0.0033, and it
   * lifts conversion of reach into territory from 15.2% to 22.9% where the
   * human range measured from recorded games is 24-29%. That is the first
   * result in this work to clear significance rather than merely trend, and it
   * came from a life-and-death change after five terms that priced territory
   * directly had all measured zero.
   *
   * Watch the capture column if this is revisited: the same run had the eye
   * side captured 23 times against 19, not significant but the direction a
   * change preferring walls to extensions would be expected to go.
   */
  eyeSpaceWeight: 60,
  /** Multiplier on the `thin` shape term below (mine * -15, theirs * 7 at
   * 1.0). Zero reproduces the evaluation exactly as it was before that term
   * existed, so the arena can play the two head to head. */
  thinWeight: 1,
  /** Cells the opponent must be able to settle in one move before the engine
   * drops what it is doing to answer. Measured over 17 real games: the shipped
   * 8 fires on 1.8% of turns, while threats of three or more come up on 22%. */
  urgentConfirmSize: 8,
  /** Multiplier on severeInfluenceTerm below. Zero reproduces the evaluation
   * exactly as it was before that term existed. */
  severeInfluenceWeight: 1,
};

/** Just short of a decided game — used for positions that are lost/won barring
 * a miracle, so search still prefers a real win over a merely winning shape. */
const NEAR_DECISIVE = 400_000;

/** Credit for a wall that is nearly built. Settled ground arrives far too late
 * to steer on: in the games this engine lost to a human, the opponent was
 * converting by move 10 and it had nothing until move 22-29. */
function frameworkTerm(state: GameState, aiPlayer: Player, opp: Player): number {
  if (tuning.frameworkWeight === 0) return 0;
  return (
    (frameworkPotential(state.board, aiPlayer) - frameworkPotential(state.board, opp)) *
    tuning.frameworkWeight
  );
}

/** How far behind on influence counts as severe enough to need an extra
 * nudge. INFLUENCE_TO_TERRITORY above already prices in ordinary jockeying
 * for position — it earned HARD a jump from 83% to 100% against NORMAL —
 * but it is deliberately timid (see its own comment), and a real game showed
 * exactly the failure mode that timidity risks: VERY_HARD sat sixteen cells
 * down on influence for the last twenty-plus moves of the game with nothing
 * in the evaluation ever pushing back, because sixteen cells at 0.12 prices
 * out at barely two and a half territory-equivalent cells — less than the
 * three-cell margin the first player owes, so the position could still read
 * as roughly even while the whole board was being given away. */
const SEVERE_INFLUENCE_DEFICIT = 10;
/** Multiplier on the deficit past that threshold. Deliberately not a blanket
 * raise of INFLUENCE_TO_TERRITORY — that was tried and made things worse
 * (see its own comment): pushed up everywhere, it overvalues ground that is
 * only lightly contested and sends the search chasing it into captures.
 * Wiring the *candidate pool* to a similar deficit signal was also tried, in
 * territoryPlanner's `behindOnInfluence` — narrowing the search to a
 * territorial shortlist on that alone dropped VERY_HARD from 75% to 42%
 * against HARD, which is why that plan only overrides on a concrete
 * imminent seal and this term exists instead: it changes how the *existing*
 * search values a position it was already free to choose, never which
 * positions are on offer. Gating on a severe, sustained deficit keeps
 * ordinary trades governed by the timid weight and only escalates once the
 * board is genuinely being given away. */
const SEVERE_INFLUENCE_WEIGHT = 8;

function severeInfluenceTerm(
  aiPlayer: Player,
  opp: Player,
  influence: Record<Player, number>,
): number {
  if (tuning.severeInfluenceWeight === 0) return 0;
  const myDeficit = Math.max(0, influence[opp] - influence[aiPlayer] - SEVERE_INFLUENCE_DEFICIT);
  const theirDeficit = Math.max(0, influence[aiPlayer] - influence[opp] - SEVERE_INFLUENCE_DEFICIT);
  return (theirDeficit - myDeficit) * SEVERE_INFLUENCE_WEIGHT * tuning.severeInfluenceWeight;
}

export function evaluateState(state: GameState, aiPlayer: Player): number {
  if (state.winner === aiPlayer) return 1_000_000;
  if (state.winner && state.winner !== aiPlayer) return -1_000_000;

  const opp = opponent(aiPlayer);
  const mine = shapeStats(state, aiPlayer);
  const theirs = shapeStats(state, opp);

  // Destroying one castle wins outright, so a group left in atari with the
  // opponent to move is effectively already lost. Encoding that here gives
  // the search a ply of tactical sight for free at every leaf.
  if (mine.atari > 0 && state.currentPlayer === opp) return -NEAR_DECISIVE;
  if (theirs.atari > 0 && state.currentPlayer === aiPlayer) return NEAR_DECISIVE;

  // Computed once and shared: projectedMargin and severeInfluenceTerm both
  // need it, and influenceCount's breadth-first fill is the single most
  // expensive thing evaluateState does, run once at every leaf the search
  // touches.
  // One breadth-first fill, then everything derived from it. The fill is the
  // single most expensive thing here, run at every leaf the search touches, so
  // the closability term asks the same map a second question rather than
  // paying to rebuild it — the difference between costing the search a third
  // of its evaluation budget and costing it all of it.
  const owners = influenceOwnerMap(
    state.board,
    settledOutOfInfluenceEnabled
      ? new Set([...state.territories.A, ...state.territories.B].map((c) => `${c.row},${c.col}`))
      : undefined,
  );
  // Weighted only when asked for. The extra pass is one flood fill over a map
  // already in hand, but "the default is unchanged" and "the default costs the
  // same" are different claims, and conflating them shipped a regression once.
  const influence = tuning.influenceRegionCurve
    ? influenceCountWeightedFromMap(owners)
    : influenceCountFromMap(owners);
  // Three ways to price the open ground, and only one of them runs. The
  // calibrated estimate returns cells outright, so it bypasses the flat rate
  // rather than being scaled by it.
  const calibrated = tuning.calibratedOpenGround
    ? expectedOpenGroundFromMap(owners, state.board)
    : null;
  const open =
    calibrated ??
    (tuning.closabilityDecay < 1
      ? closableInfluence(state.board, owners, tuning.closabilityDecay)
      : influence);

  return (
    // One number for the whole territory question: settled ground, ground each
    // side is heading towards, and the first-player margin that decides who
    // the count actually favours.
    projectedMarginFrom(state, aiPlayer, influence, open, calibrated !== null) * 100 +
    frameworkTerm(state, aiPlayer, opp) +
    severeInfluenceTerm(aiPlayer, opp, influence) +
    mine.totalLiberties * 5 -
    theirs.totalLiberties * 6 +
    // Pressure priced by whether it threatens anything. The escapable share is
    // discounted on their side only: my own group being in atari is just as bad
    // whether or not I can wriggle out, since the search will have to spend the
    // move either way.
    (theirs.atari - theirs.escapableAtari) * 45 +
    theirs.escapableAtari * 45 * tuning.escapablePressureWeight -
    mine.atari * 90 +
    // A two-liberty group is one forcing move from atari — the shape the AI
    // used to wander into happily.
    (theirs.nearAtari - theirs.escapableNearAtari) * 16 +
    theirs.escapableNearAtari * 16 * tuning.escapablePressureWeight -
    mine.nearAtari * 34 +
    // A lone cat on three liberties is not yet urgent, but it is already the
    // shape a slow, unanswered squeeze starts from — see the ShapeStats
    // comment on `thin`.
    (theirs.thin * 7 - mine.thin * 15) * tuning.thinWeight +
    // A group that cannot gain a liberty is not thin, it is finished.
    (theirs.sealed - mine.sealed) * tuning.sealedWeight +
    // Ways left for a thin group to live, counted for both sides.
    (mine.eyeSpace - theirs.eyeSpace) * tuning.eyeSpaceWeight +
    // A permanently alive group is a lasting asset, for either side.
    mine.immortal * 30 -
    theirs.immortal * 30 +
    (mine.connectedBonus * 3 - mine.isolated * 5) * tuning.connectionWeight +
    // Closable structure, the one thing measurement says the engine never
    // builds. Counted for both sides: denying the opponent a frame is worth
    // as much as making one.
    (framePotential(state.board, aiPlayer) - framePotential(state.board, opp)) *
      tuning.frameWeight
  );
}

/**
 * The same score, itemised, for working out *why* a move was chosen.
 *
 * Kept as a second function rather than a refactor of evaluateState, because
 * that function runs at every leaf of every search and reordering its
 * arithmetic risks changing results for no benefit. The two are held together
 * by a test asserting they agree, so this cannot silently drift.
 *
 * The short-circuit branches are reported as themselves: when one fires it is
 * the whole score, and knowing that is usually the answer.
 */
export function evaluateComponents(
  state: GameState,
  aiPlayer: Player,
): Record<string, number> {
  if (state.winner === aiPlayer) return { winner: 1_000_000 };
  if (state.winner && state.winner !== aiPlayer) return { winner: -1_000_000 };

  const opp = opponent(aiPlayer);
  const mine = shapeStats(state, aiPlayer);
  const theirs = shapeStats(state, opp);
  if (mine.atari > 0 && state.currentPlayer === opp) return { myGroupIsLost: -NEAR_DECISIVE };
  if (theirs.atari > 0 && state.currentPlayer === aiPlayer) return { theirGroupIsLost: NEAR_DECISIVE };

  const owners = influenceOwnerMap(
    state.board,
    settledOutOfInfluenceEnabled
      ? new Set([...state.territories.A, ...state.territories.B].map((c) => `${c.row},${c.col}`))
      : undefined,
  );
  // Weighted only when asked for. The extra pass is one flood fill over a map
  // already in hand, but "the default is unchanged" and "the default costs the
  // same" are different claims, and conflating them shipped a regression once.
  const influence = tuning.influenceRegionCurve
    ? influenceCountWeightedFromMap(owners)
    : influenceCountFromMap(owners);
  // Three ways to price the open ground, and only one of them runs. The
  // calibrated estimate returns cells outright, so it bypasses the flat rate
  // rather than being scaled by it.
  const calibrated = tuning.calibratedOpenGround
    ? expectedOpenGroundFromMap(owners, state.board)
    : null;
  const open =
    calibrated ??
    (tuning.closabilityDecay < 1
      ? closableInfluence(state.board, owners, tuning.closabilityDecay)
      : influence);

  return {
    territory: projectedMarginFrom(state, aiPlayer, influence, open) * 100,
    framework: frameworkTerm(state, aiPlayer, opp),
    severeInfluence: severeInfluenceTerm(aiPlayer, opp, influence),
    myLiberties: mine.totalLiberties * 5,
    theirLiberties: -(theirs.totalLiberties * 6),
    theirAtari:
      (theirs.atari - theirs.escapableAtari) * 45 +
      theirs.escapableAtari * 45 * tuning.escapablePressureWeight,
    myAtari: -(mine.atari * 90),
    theirNearAtari:
      (theirs.nearAtari - theirs.escapableNearAtari) * 16 +
      theirs.escapableNearAtari * 16 * tuning.escapablePressureWeight,
    myNearAtari: -(mine.nearAtari * 34),
    thin: (theirs.thin * 7 - mine.thin * 15) * tuning.thinWeight,
    sealed: (theirs.sealed - mine.sealed) * tuning.sealedWeight,
    eyeSpace: (mine.eyeSpace - theirs.eyeSpace) * tuning.eyeSpaceWeight,
    immortal: mine.immortal * 30 - theirs.immortal * 30,
    connection: (mine.connectedBonus * 3 - mine.isolated * 5) * tuning.connectionWeight,
    frame:
      (framePotential(state.board, aiPlayer) - framePotential(state.board, opp)) *
      tuning.frameWeight,
  };
}

export function candidateActions(state: GameState, player: Player): AIAction[] {
  const placements: AIAction[] = getLegalMoves(state, player).map(
    (coord: Coord): AIAction => ({ type: "PLACE", row: coord.row, col: coord.col }),
  );
  return [...placements, { type: "PASS" }];
}

function immediateWin(state: GameState, player: Player, actions: AIAction[]): AIAction | null {
  for (const action of actions) {
    const next = applyAction(state, action);
    if (next.winner === player) return action;
  }
  return null;
}

/**
 * Does the opponent have a reply to `state` that wins immediately for them?
 *
 * Computed directly instead of simulating every opponent move (which cost
 * ~460ms per getSafeActions call and was the single largest drain on every
 * difficulty's budget). Only two immediate wins exist:
 *  - capture: one of our groups has exactly one liberty, and the opponent may
 *    legally fill it. Capture-priority makes that always legal unless the
 *    liberty is our confirmed territory, where nobody may play — that group
 *    is permanently alive, not in danger.
 *  - pass-out: we just passed (consecutivePasses === 1), so the opponent can
 *    pass back, end the game, and win the territory count.
 */
export function opponentHasImmediateWin(state: GameState, aiPlayer: Player): boolean {
  if (state.winner) return false;

  const ownTerritory = coordKeySet(state.territories[aiPlayer]);
  for (const group of getAllGroups(state.board, aiPlayer)) {
    const liberties = getGroupLiberties(state.board, group);
    if (liberties.size !== 1) continue;
    const [only] = liberties;
    if (!ownTerritory.has(only)) return true;
  }

  if (state.consecutivePasses === 1) {
    const ended = passTurn(state);
    if (ended.winner && ended.winner !== aiPlayer) return true;
  }

  return false;
}

export interface SafeActions {
  /** A move that wins on the spot, if one exists — always play it. */
  winningMove: AIAction | null;
  /** Moves that don't hand the opponent an immediate capture win. Falls back
   * to every legal action when every move loses, so callers always get
   * something playable. */
  pool: AIAction[];
}

/**
 * Shared tactical floor for every difficulty: take a win when it's there, and
 * otherwise never volunteer a move that lets the opponent win next turn.
 * HARD layers its deeper search on top of this rather than rediscovering it,
 * so a shallow search can never drop below NORMAL's tactical standard.
 */
export function getSafeActions(state: GameState, player: Player): SafeActions {
  // Candidates are simulated with applyMove, which always plays as
  // state.currentPlayer. Asking about the other side therefore mixes one
  // player's legal moves with the other's board, and throws as soon as the two
  // disagree — which is exactly what it did when an arena metric sampled both
  // sides at once. Normalising here makes the question answerable for either.
  if (state.currentPlayer !== player) state = { ...state, currentPlayer: player };
  const actions = candidateActions(state, player);
  const winningMove = immediateWin(state, player, actions);
  if (winningMove) return { winningMove, pool: actions };

  const safe = actions.filter((action) => {
    const next = applyAction(state, action);
    // A pass that ends the game against us is a loss, not a "safe" move.
    if (next.winner) return next.winner === player;
    return !opponentHasImmediateWin(next, player);
  });
  return { winningMove: null, pool: safe.length > 0 ? safe : actions };
}

export function rankByStaticEval(state: GameState, player: Player, actions: AIAction[]): AIAction[] {
  return [...actions]
    .map((action) => ({ action, score: evaluateState(applyAction(state, action), player) }))
    .sort((a, b) => b.score - a.score)
    .map(({ action }) => action);
}

const EASY_TOP_N = 5;
const NORMAL_TOP_N = 10;
const NORMAL_REPLY_TOP_N = 8;

/**
 * Handles EASY and NORMAL only. HARD and VERY_HARD run the search in
 * engine/minimax.ts, normally off the main thread via aiWorker.ts — callers
 * must route those there instead of calling this function.
 */
export function getAIMove(
  state: GameState,
  player: Player,
  difficulty: Exclude<Difficulty, SearchDifficulty>,
): AIAction {
  const { winningMove, pool } = getSafeActions(state, player);
  if (winningMove) return winningMove;

  if (difficulty === "EASY") {
    const ranked = rankByStaticEval(state, player, pool);
    const top = ranked.slice(0, EASY_TOP_N);
    return top[Math.floor(Math.random() * top.length)];
  }

  // NORMAL: shallow 2-ply minimax over the most promising candidates.
  const ranked = rankByStaticEval(state, player, pool).slice(0, NORMAL_TOP_N);
  const opp = opponent(player);

  let best = ranked[0];
  let bestScore = -Infinity;

  for (const action of ranked) {
    const afterMine = applyAction(state, action);
    if (afterMine.winner) {
      const score = evaluateState(afterMine, player);
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
      continue;
    }

    const replies = rankByStaticEval(afterMine, opp, candidateActions(afterMine, opp)).slice(
      0,
      NORMAL_REPLY_TOP_N,
    );
    let worstForMe = Infinity;
    for (const reply of replies) {
      const afterReply = applyAction(afterMine, reply);
      worstForMe = Math.min(worstForMe, evaluateState(afterReply, player));
    }
    const score = replies.length > 0 ? worstForMe : evaluateState(afterMine, player);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }

  return best;
}
