/**
 * Plays Alley Boss Cats engines against each other and reports territory-first
 * arena metrics. Win/loss remains reference data; the primary signal is the
 * seat-normalized final confirmed-territory margin.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  getAIMove,
  getSafeActions,
  setSealedLibertyThreshold,
  tuning,
  type AIAction,
  type Difficulty,
} from "./src/games/alley-boss-cats/ai";
import {
  findBestMoveMinimax,
  findBestMoveVeryHard,
  setSelfInflictedThinGuardEnabled,
  setThinGroupGuardEnabled,
  setEyeMakingDefenceEnabled,
  setThinGroupLibertyThreshold,
  setPocketSealTerritoryUnionEnabled,
  setDominatedPocketGuardEnabled,
  setExistingGroupDangerRankingEnabled,
  setPocketSealDangerGuardEnabled,
  setCornerBookEnabled,
  setCornerBookFinishEnabled,
  setCornerBookContestEnabled,
  setCornerBookSpreadEnabled,
  setCornerBookSpreadStones,
  setSettleOverSearchEnabled,
  setCornerBookLeaveContestedEnabled,
  setFrameworkInsideDenialEnabled,
  setCornerBookFollowEnabled,
  setSelfInflictedSealedGuardEnabled,
  setOneMoveSealedTrapGuardEnabled,
  setCornerAnswerGuardEnabled,
  setCornerAnswerInsideEnabled,
  setCornerFrameCentreEnabled,
  setLargerEnclosureEnabled,
  setSealOverridesBookEnabled,
  setFrameworkGuardEnabled,
  setPocketSealDenialFilterEnabled,
  setOpponentFrameworkGuardEnabled,
  setTtScoresEnabled,
} from "./src/games/alley-boss-cats/engine/minimax";
import { setCaptureRetargets } from "./src/games/alley-boss-cats/engine/captureSearch";
import {
  setContactBias,
  setDecisivePointsEnabled,
  setEdgeFramingEnabled,
  setOwnDiagonalBonus,
} from "./src/games/alley-boss-cats/engine/moveOrdering";
import {
  setOwnSealImminentCells,
  setOwnSealImminentEnabled,
  setSettledOutOfInfluenceEnabled,
} from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { influenceCount } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { wideAreaBotMove } from "./src/games/alley-boss-cats/engine/wideAreaBot";
import { sealingBotMove } from "./src/games/alley-boss-cats/engine/sealingBot";
import { josekiBotMove } from "./src/games/alley-boss-cats/engine/josekiBot";
import {
  applyMove,
  calculateFinalResult,
  createInitialState,
  getLegalMoves,
  isLegalMove,
  passTurn,
} from "./src/games/alley-boss-cats/rules";
import { firstTerritoryTurn } from "./src/games/alley-boss-cats/arenaMetrics";
import { replaySeed, loadSeeds, DEFAULT_SEED_FILES, type Seed } from "./arena-seeds";
import { setOwnershipNet } from "./src/games/alley-boss-cats/engine/ownershipTerm";
import type { GameState, Move, Player } from "./src/games/alley-boss-cats/types";
import {
  aggregateRecords,
  rounded,
  type ArenaGameRecord,
  type EngineSeat,
  type FinishReason,
  type MatchAggregate,
} from "./arena-aggregate";

type Engine =
  | Difficulty
  | "RANDOM"
  | "WIDE"
  | "SEAL"
  | "VH_FRAME"
  | "VH_THIN"
  | "VH_GUARD"
  | "VH_NOGUARD"
  | "VH_POCKET"
  | "VH_NOPOCKET"
  | "VH_RANK"
  | "VH_NORANK"
  | "VH_SEAL"
  | "VH_NOSEAL"
  | "VH_SEVERE"
  | "VH_NOSEVERE"
  | "VH_CORNER"
  | "VH_NOCORNER"
  | "VH_DENY"
  | "VH_NODENY"
  | "VH_OPPFRAME"
  | "VH_NOOPPFRAME"
  | "VH_TT"
  | "VH_NOTT"
  | "VH_OWN"
  | "VH_NOOWN"
  | "VH_SEALURG"
  | "VH_NOSEALURG"
  | "VH_CLOSE"
  | "VH_NOCLOSE"
  | "VH_RETARGET"
  | "VH_NORETARGET"
  | "VH_FRAME2"
  | "VH_NOFRAME2"
  | "VH_THINGUARD"
  | "VH_NOTHINGUARD"
  | "VH_THIN2"
  | "VH_NOTHIN2"
  | "VH_ESCP"
  | "VH_NOESCP"
  | "VH_DECISIVE"
  | "VH_NODECISIVE"
  | "VH_EYE"
  | "VH_NOEYE"
  | "VH_EDGE"
  | "VH_NOEDGE"
  | "VH_SEALUNION"
  | "VH_NOSEALUNION"
  | "VH_CALIB"
  | "VH_NOCALIB"
  | "VH_SETTLED"
  | "VH_NOSETTLED"
  | "VH_CONTACT"
  | "VH_NOCONTACT"
  | "VH_DIAG"
  | "VH_NODIAG"
  | "VH_BOOKDIAG"
  | "VH_BOOKTIGHT"
  | "JOSEKI"
  | "VH_CENTRE"
  | "VH_NOCENTRE"
  | "VH_SPREAD"
  | "VH_FINISH"
  | "VH_LONE"
  | "VH_PAIR"
  | "VH_SETTLE"
  | "VH_NOSETTLE"
  | "VH_LEAVE"
  | "VH_STAY"
  | "VH_SEALGATE"
  | "VH_NOSEALGATE"
  | "VH_SEALWALK"
  | "VH_NOSEALWALK"
  | "VH_ONESEAL"
  | "VH_NOONESEAL"
  | "VH_CORNERANS"
  | "VH_NOCORNERANS"
  | "VH_INSIDE"
  | "VH_NOINSIDE"
  | "VH_DENYIN"
  | "VH_NODENYIN"
  | "VH_FOLLOW"
  | "VH_FIXED"
  | "VH_CONTEST"
  | "VH_OWNFIRST"
  | "VH_MYSEAL"
  | "VH_NOMYSEAL"
  | "VH_SEALOVER"
  | "VH_NOSEALOVER"
  | "VH_LARGER"
  | "VH_NOLARGER";


const FRAME_W = Number(process.env.FRAME_W ?? 60);
const URGENT = process.env.URGENT ? Number(process.env.URGENT) : null;
const THIN_W = Number(process.env.THIN_W ?? 1);
const TESTING_THIN = process.env.ONLY === "THIN";
const SEVERE_W = Number(process.env.SEVERE_W ?? 1);
const TESTING_SEVERE = process.env.ONLY === "SEVERE";
const OWN_W = Number(process.env.OWN_W ?? 1);
const TESTING_OWN = process.env.ONLY === "OWN";
const OWNERSHIP_NET = process.env.OWNERSHIP_NET ?? "public/ownership-net.json";
const SEAL_URG = Number(process.env.SEAL_URG ?? 2);
const TESTING_SEALURG = process.env.ONLY === "SEALURG";
const CLOSE_DECAY = Number(process.env.CLOSE_DECAY ?? 0.6);
const TESTING_CLOSE = process.env.ONLY === "CLOSE";
const RETARGETS = Number(process.env.RETARGETS ?? 1);
const TESTING_RETARGET = process.env.ONLY === "RETARGET";
const FRAME_SEAL = Number(process.env.FRAME_SEAL ?? 2);
const TESTING_FRAME2 = process.env.ONLY === "FRAME2";
// Stage 1.75, which decides 23.8% of all AI moves from about three candidates.
const TESTING_THINGUARD = process.env.ONLY === "THINGUARD";
// The narrower version of the same question: keep the guard, drop its ceiling
// from three liberties to two.
const THIN_LIBS = Number(process.env.THIN_LIBS ?? 2);
const TESTING_THIN2 = process.env.ONLY === "THIN2";
// What pressure the opponent can step out of is worth. 1 is shipped.
const ESC_W = Number(process.env.ESC_W ?? 0);
const TESTING_ESCP = process.env.ONLY === "ESCP";
// Restoring the atari escape / kill point that move ordering was cutting.
const TESTING_DECISIVE = process.env.ONLY === "DECISIVE";
// Eye-space term plus the walling candidates in the danger guard, together —
// the term is only ever consulted when the guard offers something to choose.
const EYE_W = Number(process.env.EYE_W ?? 60);
const TESTING_EYE = process.env.ONLY === "EYE";
// Edge framing sits on top of the shipped eye default rather than replacing it,
// so both arms here keep the eye behaviour and differ only in the extra slot.
const TESTING_EDGE = process.env.ONLY === "EDGE";
// Stage 1.85 keeps its defensive shortlist; the arm adds the ground-taking
// moves to it rather than removing the guard, which the guard-off run did not
// support.
const TESTING_SEALUNION = process.env.ONLY === "SEALUNION";
// The one change that can make the engine worse rather than merely useless: it
// raises what open ground is worth against every tactical term, and one capture
// loses outright. The capture count is the thing to watch here, not the margin.
const TESTING_CALIB = process.env.ONLY === "CALIB";
// An accounting fix rather than an idea: settled ground was being counted once
// as territory and again as influence. The bar here is no regression.
const TESTING_SETTLED = process.env.ONLY === "SETTLED";
// The ordering's pull towards enemy stones. Captures and ataris keep their
// bonuses; only the flat per-stone attraction is scaled. Captures are the risk
// and the arena is the one thing that reproduces them well.
const CONTACT = Number(process.env.CONTACT ?? 0);
const TESTING_CONTACT = process.env.ONLY === "CONTACT";
// Paying for a diagonal own-neighbour in the ordering, which today pays nothing.
// The risk is the same as any ordering change: what falls out of the candidate
// list. Captures are what the arena reproduces, so that is what it answers.
const DIAG = Number(process.env.DIAG ?? 15);
const TESTING_DIAG = process.env.ONLY === "DIAG";
/**
 * The one comparison the arena could never make before.
 *
 * The corner book only moves inside the first ten stones, and every arena run so
 * far seeded from plies 12 to 20 — past it. So `SEEDS=1` has to be off for this
 * arm, and then both sides start from an empty board with the book live, which
 * is the condition the recorded games are played under.
 *
 * Both engines get the book with the finishing budget and the eye guard, exactly
 * as the EYE_FRAME variants do. The only difference between them is the diagonal
 * bonus, which is the question: seven real games put the no-diagonal side at
 * 10.3 cells against 5.7, where the seeded arena had put the diagonal side ahead
 * by 0.95.
 */
const TESTING_BOOKDIAG = process.env.ONLY === "BOOKDIAG";
/** The engine against the scripted human, from an empty board. */
const TESTING_JOSEKI = process.env.ONLY === "JOSEKI";
/**
 * The frame tie-break, in games rather than in shapes.
 *
 * Asked of the rules, (1,2) with (2,1) kills an invader at all eight entry
 * points and (1,2) with (0,3) lets five of eight live, and the book was building
 * the second because the sort was a tie and fell back on array order. That says
 * the shape is better; it does not say what the book being right is worth over a
 * game, which is what this arm measures. Run with SEEDS unset — the book only
 * moves inside the first ten stones.
 */
const TESTING_CENTRE = process.env.ONLY === "CENTRE";
/** Two stones in four corners against four stones in two. The player's method. */
const TESTING_SPREAD = process.env.ONLY === "SPREAD";
/** One stone in each corner against the pair. The player's next question. */
const TESTING_LONE = process.env.ONLY === "LONE";
/** Widening the sealed-shape gate past 3 liberties, with a nonzero price. */
const TESTING_SEALGATE = process.env.ONLY === "SEALGATE";
const SEALGATE_THRESHOLD = Number(process.env.SEALGATE_THRESHOLD ?? 5);
const SEALGATE_WEIGHT = Number(process.env.SEALGATE_WEIGHT ?? 150);
/** Removing a move from stage 1.85's own candidates when it walks a group
 * into a shape canBreathe already knows is sealed, past every count-based
 * guard. A pool filter, not an eval-weight nudge — the player's own read of
 * the D6 trap: "fix walking into the death spot first." */
const TESTING_SEALWALK = process.env.ONLY === "SEALWALK";
/** The gap in both createsOneMoveTrap and createsVoluntarySealedGroup:
 * touchesOwnGroup exempted a fresh stone from either. This drops that
 * requirement and asks the one-ply-lookahead question with canBreathe's
 * answer instead of a liberty count. The player's own read of the position:
 * "이건 애초에 들어오면 안 되었던거 같은데." */
const TESTING_ONESEAL = process.env.ONLY === "ONESEAL";
/** Refusing the two outside answers to an opponent's corner entry — the lines
 * that finish 1.9 against 3.9 over 446 recorded corner fights. */
const TESTING_CORNERANS = process.env.ONLY === "CORNERANS";
/**
 * Answering a corner the opponent already holds at (0,1) rather than at the
 * frame point. Solved over every board size and stone count tried, (0,1) is the
 * only answer point with a positive mean; no (0,1) point was in the book at all.
 * Shipped as EYE_INSIDE; this asks whether the arena's own opponent can see any
 * difference, which it may well not — it rarely leaves a corner for the engine
 * to answer in the shape a person does.
 */
const TESTING_INSIDE = process.env.ONLY === "INSIDE";
/**
 * Stage 1.87's fallback: when every wall point of the opponent's frame is
 * capturable, play inside the frame instead of giving the reason up. Measured
 * on four recorded games against the player it fired fourteen times and widened
 * fourteen times; here the question is only whether keeping the reason costs
 * anything against an opponent that rarely builds the shape in the first place.
 */
const TESTING_DENYIN = process.env.ONLY === "DENYIN";
/** Overruling the full search with a 2+ cell settle its own leaf scored higher. */
const TESTING_SETTLE = process.env.ONLY === "SETTLE";
/** Abandoning a corner they have answered for one nobody is in. The player's. */
const TESTING_LEAVE = process.env.ONLY === "LEAVE";
/** Matching their stone count in a corner instead. The player's actual rule. */
const TESTING_FOLLOW = process.env.ONLY === "FOLLOW";
/** Answering their new corner against finishing a pair of my own. */
const TESTING_CONTEST = process.env.ONLY === "CONTEST";
/** Treating my own big enclosure as urgent, which the planner never did. */
const MYSEAL = Number(process.env.MYSEAL ?? 4);
const TESTING_MYSEAL = process.env.ONLY === "MYSEAL";
/** Letting a concrete enclosure displace a single-move stage that settles none. */
const TESTING_SEALOVER = process.env.ONLY === "SEALOVER";
/** Upgrading a move to the larger version of the same enclosure. */
const TESTING_LARGER = process.env.ONLY === "LARGER";

const HARD_MS = Number(process.env.HARD_MS ?? 250);
const VERY_HARD_MS = Number(process.env.VERY_HARD_MS ?? 1200);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 160);
const RANDOM_OPENING_PLIES = Number(process.env.OPENING_PLIES ?? 4);
const ARENA_SEED = Number(process.env.ARENA_SEED ?? 20260804);
const OUTPUT_JSON = process.env.OUTPUT_JSON ?? null;

/**
 * Shard selection, so one match can be split across parallel jobs.
 *
 * The 128-game baseline took 3h27m in a single job at the shipped 3000ms
 * budget, which leaves no room to compare candidates and none at all to
 * generate a dataset. Sharding is by *pair*, never by game: a mirrored pair is
 * the same opening played from both seats, and splitting one across jobs would
 * leave each side of it in a different sample, reintroducing exactly the
 * first-player bias the pairing exists to cancel.
 *
 * Shards write partial records that `arena-merge.mts` recombines; every shard
 * keeps the global game numbering so the merged run is identical to an
 * unsharded one.
 */
const SHARD_COUNT = Number(process.env.SHARD_COUNT ?? 1);
const SHARD_INDEX = Number(process.env.SHARD_INDEX ?? 0);

/**
 * Start from recorded human positions instead of the empty board.
 *
 * `SEED_PLIES=12,16,20` with `SEEDS=1`. Every mirrored pair then plays out one
 * seed from both seats, which is what makes the comparison paired: the two
 * arms face the identical position, so the difference between them is the
 * candidate and not the game. See arena-seeds.mts for why the empty board is
 * the wrong instrument for a territory candidate.
 *
 * GAMES is ignored under seeding — the sample is two games per seed, and
 * quietly playing a different number would make the run unmergeable with
 * itself.
 */
const SEEDED = process.env.SEEDS === "1";
const SEED_PLIES = (process.env.SEED_PLIES ?? "12,16,20").split(",").map(Number);
const SEED_FILES = process.env.SEED_FILES ? process.env.SEED_FILES.split(",") : DEFAULT_SEED_FILES;

/** Third-line and star points: plausible openings that do not seed a tactical
 * collapse before the measured engines take over. */
const OPENING_POINTS: ReadonlyArray<[number, number]> = [
  [2, 2], [2, 6], [6, 2], [6, 6],
  [2, 4], [4, 2], [4, 6], [6, 4],
  [3, 3], [3, 5], [5, 3], [5, 5],
  [2, 3], [3, 2], [5, 6], [6, 5],
];

/** Ply at which the legacy pressure reference metric is sampled. */
const PRESSURE_PLY = 20;

function decide(state: GameState, player: Player, engine: Engine): AIAction {
  // Preserve the shipped/legacy arena switching exactly. This Phase 0 change
  // only measures decisions; it does not modify search, guards, or weights.
  if (URGENT !== null) {
    tuning.frameworkWeight = 0;
    tuning.urgentConfirmSize = engine === "VH_FRAME" ? URGENT : 8;
  } else {
    tuning.frameworkWeight = engine === "VH_FRAME" ? FRAME_W : 0;
    tuning.urgentConfirmSize = 8;
  }
  if (TESTING_THIN) tuning.thinWeight = engine === "VH_THIN" ? THIN_W : 0;
  if (TESTING_SEVERE) tuning.severeInfluenceWeight = engine === "VH_SEVERE" ? SEVERE_W : 0;
  // Only the candidate consults the net. Its opponent is the shipped engine
  // with the term off, so the pair differs in exactly this one thing.
  if (TESTING_OWN) tuning.ownershipWeight = engine === "VH_OWN" ? OWN_W : 0;
  if (TESTING_SEALURG) tuning.urgentSealUrgency = engine === "VH_SEALURG" ? SEAL_URG : 0;
  // 1 is the off value: it reproduces the plain influence count exactly.
  if (TESTING_CLOSE) tuning.closabilityDecay = engine === "VH_CLOSE" ? CLOSE_DECAY : 1;
  // 0 is the shipped read: one target group, no switching.
  if (TESTING_RETARGET) setCaptureRetargets(engine === "VH_RETARGET" ? RETARGETS : 0);
  // 0 is the off value: the frame-building shortlist is skipped entirely.
  if (TESTING_FRAME2) tuning.frameSealSize = engine === "VH_FRAME2" ? FRAME_SEAL : 0;
  if (TESTING_THINGUARD) setThinGroupGuardEnabled(engine === "VH_THINGUARD");
  if (TESTING_THIN2) setThinGroupLibertyThreshold(engine === "VH_THIN2" ? THIN_LIBS : 3);
  if (TESTING_ESCP) tuning.escapablePressureWeight = engine === "VH_ESCP" ? ESC_W : 1;
  if (TESTING_DECISIVE) setDecisivePointsEnabled(engine === "VH_DECISIVE");
  if (TESTING_EYE) {
    const on = engine === "VH_EYE";
    tuning.eyeSpaceWeight = on ? EYE_W : 0;
    setEyeMakingDefenceEnabled(on);
  }
  if (TESTING_EDGE) setEdgeFramingEnabled(engine === "VH_EDGE");
  if (TESTING_SEALUNION) setPocketSealTerritoryUnionEnabled(engine === "VH_SEALUNION");
  if (TESTING_CALIB) tuning.calibratedOpenGround = engine === "VH_CALIB";
  if (TESTING_SETTLED) setSettledOutOfInfluenceEnabled(engine === "VH_SETTLED");
  if (TESTING_CONTACT) setContactBias(engine === "VH_CONTACT" ? CONTACT : 1);
  if (TESTING_DIAG) setOwnDiagonalBonus(engine === "VH_DIAG" ? DIAG : 0);
  setLargerEnclosureEnabled(!TESTING_LARGER || engine === "VH_LARGER");
  if (TESTING_LARGER) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
  }
  if (TESTING_SEALOVER) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setSealOverridesBookEnabled(engine === "VH_SEALOVER");
  }
  if (TESTING_MYSEAL) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setOwnSealImminentCells(MYSEAL);
    setOwnSealImminentEnabled(engine === "VH_MYSEAL");
  }
  if (TESTING_CONTEST) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerBookContestEnabled(engine === "VH_CONTEST");
  }
  if (TESTING_SPREAD) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerBookSpreadEnabled(engine === "VH_SPREAD");
  }
  if (TESTING_FOLLOW) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerBookFollowEnabled(engine === "VH_FOLLOW");
  }
  if (TESTING_LEAVE) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerBookLeaveContestedEnabled(engine === "VH_LEAVE");
  }
  if (TESTING_SETTLE) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setSettleOverSearchEnabled(engine === "VH_SETTLE");
  }
  if (TESTING_SEALGATE) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setSealedLibertyThreshold(engine === "VH_SEALGATE" ? SEALGATE_THRESHOLD : 3);
    tuning.sealedWeight = engine === "VH_SEALGATE" ? SEALGATE_WEIGHT : 0;
  }
  if (TESTING_SEALWALK) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setSelfInflictedSealedGuardEnabled(engine === "VH_SEALWALK");
  }
  if (TESTING_CORNERANS) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerAnswerGuardEnabled(engine === "VH_CORNERANS");
  }
  if (TESTING_INSIDE) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerAnswerInsideEnabled(engine === "VH_INSIDE");
  }
  if (TESTING_DENYIN) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    // Both arms carry the shipped corner rules, so the only difference between
    // them is the fallback itself.
    setCornerAnswerInsideEnabled(true);
    setCornerBookLeaveContestedEnabled(true);
    setFrameworkInsideDenialEnabled(engine === "VH_DENYIN");
  }
  if (TESTING_ONESEAL) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setOneMoveSealedTrapGuardEnabled(engine === "VH_ONESEAL");
  }
  if (TESTING_LONE) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setCornerBookSpreadEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerBookSpreadStones(engine === "VH_LONE" ? 1 : 2);
  }
  if (TESTING_CENTRE) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(0);
    setCornerFrameCentreEnabled(engine === "VH_CENTRE");
  }
  if (TESTING_BOOKDIAG || TESTING_JOSEKI) {
    setCornerBookEnabled(true);
    setCornerBookFinishEnabled(true);
    setEyeMakingDefenceEnabled(true);
    tuning.eyeSpaceWeight = EYE_W;
    setOwnDiagonalBonus(engine === "VH_BOOKDIAG" ? DIAG : 0);
  }
  setSelfInflictedThinGuardEnabled(engine !== "VH_NOGUARD");
  setDominatedPocketGuardEnabled(engine !== "VH_NOPOCKET");
  setExistingGroupDangerRankingEnabled(engine !== "VH_NORANK");
  setPocketSealDangerGuardEnabled(engine !== "VH_NOSEAL");
  setFrameworkGuardEnabled(engine !== "VH_NOCORNER");
  setPocketSealDenialFilterEnabled(engine !== "VH_NODENY");
  setOpponentFrameworkGuardEnabled(engine !== "VH_NOOPPFRAME");
  setTtScoresEnabled(engine !== "VH_NOTT");

  if (engine === "RANDOM") {
    const moves = getLegalMoves(state, player);
    if (moves.length === 0) return { type: "PASS" };
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { type: "PLACE", row: pick.row, col: pick.col };
  }
  if (engine === "WIDE") return wideAreaBotMove(state, player);
  if (engine === "SEAL") return sealingBotMove(state, player);
  // The scripted stand-in for the human player. Only usable while joseki-fit
  // says it predicts them better than the engine does — see josekiBot's header.
  if (engine === "JOSEKI") return josekiBotMove(state, player);
  if (engine === "HARD") return findBestMoveMinimax(state, player, HARD_MS);
  if (
    engine === "VERY_HARD" ||
    engine === "VH_FRAME" ||
    engine === "VH_THIN" ||
    engine === "VH_GUARD" ||
    engine === "VH_NOGUARD" ||
    engine === "VH_POCKET" ||
    engine === "VH_NOPOCKET" ||
    engine === "VH_RANK" ||
    engine === "VH_NORANK" ||
    engine === "VH_SEAL" ||
    engine === "VH_NOSEAL" ||
    engine === "VH_SEVERE" ||
    engine === "VH_NOSEVERE" ||
    engine === "VH_CORNER" ||
    engine === "VH_NOCORNER" ||
    engine === "VH_DENY" ||
    engine === "VH_NODENY" ||
    engine === "VH_OPPFRAME" ||
    engine === "VH_NOOPPFRAME" ||
    engine === "VH_TT" ||
    engine === "VH_NOTT" ||
    engine === "VH_OWN" ||
    engine === "VH_NOOWN" ||
    engine === "VH_SEALURG" ||
    engine === "VH_NOSEALURG" ||
    engine === "VH_CLOSE" ||
    engine === "VH_NOCLOSE" ||
    engine === "VH_RETARGET" ||
    engine === "VH_NORETARGET" ||
    engine === "VH_FRAME2" ||
    engine === "VH_THINGUARD" ||
    engine === "VH_NOTHINGUARD" ||
    engine === "VH_THIN2" ||
    engine === "VH_NOTHIN2" ||
    engine === "VH_ESCP" ||
    engine === "VH_NOESCP" ||
    engine === "VH_DECISIVE" ||
    engine === "VH_NODECISIVE" ||
    engine === "VH_EYE" ||
    engine === "VH_NOEYE" ||
    engine === "VH_EDGE" ||
    engine === "VH_NOEDGE" ||
    engine === "VH_SEALUNION" ||
    engine === "VH_NOSEALUNION" ||
    engine === "VH_CALIB" ||
    engine === "VH_NOCALIB" ||
    engine === "VH_SETTLED" ||
    engine === "VH_NOSETTLED" ||
    engine === "VH_CONTACT" ||
    engine === "VH_NOCONTACT" ||
    engine === "VH_DIAG" ||
    engine === "VH_NODIAG" ||
    engine === "VH_BOOKDIAG" ||
    engine === "VH_BOOKTIGHT" ||
    engine === "VH_CENTRE" ||
    engine === "VH_NOCENTRE" ||
    engine === "VH_SPREAD" ||
    engine === "VH_FINISH" ||
    engine === "VH_LONE" ||
    engine === "VH_PAIR" ||
    engine === "VH_SETTLE" ||
    engine === "VH_NOSETTLE" ||
    engine === "VH_LEAVE" ||
    engine === "VH_STAY" ||
    engine === "VH_SEALGATE" ||
    engine === "VH_NOSEALGATE" ||
    engine === "VH_SEALWALK" ||
    engine === "VH_NOSEALWALK" ||
    engine === "VH_ONESEAL" ||
    engine === "VH_NOONESEAL" ||
    engine === "VH_CORNERANS" ||
    engine === "VH_NOCORNERANS" ||
    engine === "VH_INSIDE" ||
    engine === "VH_NOINSIDE" ||
    engine === "VH_DENYIN" ||
    engine === "VH_NODENYIN" ||
    engine === "VH_FOLLOW" ||
    engine === "VH_FIXED" ||
    engine === "VH_CONTEST" ||
    engine === "VH_OWNFIRST" ||
    engine === "VH_MYSEAL" ||
    engine === "VH_NOMYSEAL" ||
    engine === "VH_SEALOVER" ||
    engine === "VH_NOSEALOVER" ||
    engine === "VH_LARGER" ||
    engine === "VH_NOLARGER" ||
    engine === "VH_NOFRAME2"
  ) {
    return findBestMoveVeryHard(state, player, VERY_HARD_MS);
  }
  return getAIMove(state, player, engine);
}

function act(state: GameState, action: AIAction): GameState {
  return action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function openingForPair(pairIndex: number): Array<[number, number]> {
  const pairSeed = (ARENA_SEED + Math.imul(pairIndex + 1, 0x9e3779b1)) >>> 0;
  const random = seededRandom(pairSeed);
  const points = [...OPENING_POINTS];
  for (let index = points.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [points[index], points[swap]] = [points[swap], points[index]];
  }
  return points;
}

interface GameResult {
  winner: Player;
  reason: FinishReason;
  plies: number;
  firstTerritoryTurn: Record<Player, number | null>;
  peakInfluence: Record<Player, number>;
  finalTerritory: Record<Player, number>;
  safeMovesAt: Record<Player, number | null>;
  moveHistory: Move[];
}

function playGame(
  engineA: Engine,
  engineB: Engine,
  opening: Array<[number, number]>,
  seed?: Seed,
): GameResult {
  // A seed replaces the random opening rather than preceding it: the recorded
  // position already is the opening, and stacking star points on top of it
  // would put stones the humans never played onto a board they shaped.
  const seeded = seed ? replaySeed(seed) : [createInitialState()];
  let state = seeded[seeded.length - 1];
  let totalPlies = seeded.length - 1;
  const states: GameState[] = seeded;
  const peakInfluence: Record<Player, number> = { A: 0, B: 0 };
  const safeMovesAt: Record<Player, number | null> = { A: null, B: null };

  const notePosition = (at: GameState = state) => {
    const influence = influenceCount(at.board);
    for (const side of ["A", "B"] as const) {
      peakInfluence[side] = Math.max(peakInfluence[side], influence[side]);
    }
  };

  const finish = (reason: FinishReason): GameResult => ({
    winner: state.winner ?? calculateFinalResult(state).winner,
    reason,
    plies: totalPlies,
    firstTerritoryTurn: {
      A: firstTerritoryTurn(states, "A"),
      B: firstTerritoryTurn(states, "B"),
    },
    peakInfluence,
    finalTerritory: { A: state.territories.A.length, B: state.territories.B.length },
    safeMovesAt,
    // Kept so the finished game can be scored on how its territory was built,
    // not only on how much of it there was. Margin has a 7.2-cell spread across
    // games, so 186 of them cannot resolve the two or three cells a candidate
    // is worth — but a change aimed at how regions get walled can be checked
    // against the walls themselves, of which one game supplies several.
    moveHistory: state.moveHistory,
  });

  // Peak influence spans the seed's own history too, so it means the same
  // thing here as in an unseeded run and in the recorded games.
  for (const earlier of states) notePosition(earlier);

  // A mirrored pair receives the exact same deterministic opening. The engine
  // identities swap colours in the second game, cancelling first-player bias.
  for (const [row, col] of seed ? [] : opening) {
    if (totalPlies >= RANDOM_OPENING_PLIES || totalPlies >= MAX_PLIES || state.winner) break;
    if (!isLegalMove(state, row, col, state.currentPlayer)) continue;
    state = applyMove(state, row, col);
    states.push(state);
    totalPlies += 1;
    notePosition();
  }

  while (totalPlies < MAX_PLIES) {
    if (state.winner) {
      return finish(state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY");
    }

    if (totalPlies === PRESSURE_PLY) {
      safeMovesAt.A = getSafeActions({ ...state, currentPlayer: "A" }, "A").pool.length;
      safeMovesAt.B = getSafeActions({ ...state, currentPlayer: "B" }, "B").pool.length;
    }

    const player = state.currentPlayer;
    const engine = player === "A" ? engineA : engineB;
    state = act(state, decide(state, player, engine));
    states.push(state);
    totalPlies += 1;
    notePosition();
  }

  if (state.winner) {
    return finish(state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY");
  }
  return finish("PLY_CAP");
}

function conversionRate(finalTerritory: number, peakInfluence: number): number | null {
  if (peakInfluence === 0) return null;
  return rounded((finalTerritory / peakInfluence) * 100);
}

interface MatchOutput {
  label: string;
  engines: { X: Engine; Y: Engine };
  timeBudgetMs: { X: number | null; Y: number | null };
  games: ArenaGameRecord[];
  aggregate: MatchAggregate;
}

function timeBudgetFor(engine: Engine): number | null {
  if (engine === "HARD") return HARD_MS;
  if (engine === "VERY_HARD" || engine.startsWith("VH_")) return VERY_HARD_MS;
  return null;
}

function runMatch(label: string, engineX: Engine, engineY: Engine, requestedGames: number): MatchOutput {
  // Under seeding the sample size is a property of the seed set, not a knob.
  // Honouring GAMES as well would let two runs of the same seeds disagree on
  // how many of them they played, and merge into a sample that is neither.
  const seeds = SEEDED ? loadSeeds(SEED_FILES, SEED_PLIES) : [];
  if (SEEDED && seeds.length === 0) {
    throw new Error(`no seed positions from ${SEED_FILES.join(",")} at plies ${SEED_PLIES.join(",")}`);
  }
  const games = SEEDED ? seeds.length * 2 : requestedGames;

  if (games <= 0 || !Number.isInteger(games)) throw new Error(`GAMES must be a positive integer, got ${games}`);
  if (games % 2 !== 0) throw new Error(`Mirrored arena requires an even GAMES count, got ${games}`);
  if (!Number.isInteger(SHARD_COUNT) || SHARD_COUNT < 1) {
    throw new Error(`SHARD_COUNT must be a positive integer, got ${SHARD_COUNT}`);
  }
  if (!Number.isInteger(SHARD_INDEX) || SHARD_INDEX < 0 || SHARD_INDEX >= SHARD_COUNT) {
    throw new Error(`SHARD_INDEX must be in [0, ${SHARD_COUNT}), got ${SHARD_INDEX}`);
  }
  if (games / 2 < SHARD_COUNT) {
    throw new Error(`${games} games is only ${games / 2} pairs, too few for ${SHARD_COUNT} shards`);
  }

  const records: ArenaGameRecord[] = [];

  for (let index = 0; index < games; index += 1) {
    const pair = Math.floor(index / 2);
    // Whole pairs only: the two games of a pair are the same opening from
    // either seat, and they have to be counted in the same sample.
    if (pair % SHARD_COUNT !== SHARD_INDEX) continue;

    const xIsA = index % 2 === 0;
    const seed = SEEDED ? seeds[pair] : undefined;
    const result = playGame(
      xIsA ? engineX : engineY,
      xIsA ? engineY : engineX,
      openingForPair(pair),
      seed,
    );
    const xSide: Player = xIsA ? "A" : "B";
    const ySide: Player = xIsA ? "B" : "A";
    const xFinal = result.finalTerritory[xSide];
    const yFinal = result.finalTerritory[ySide];
    const xPeak = result.peakInfluence[xSide];
    const yPeak = result.peakInfluence[ySide];

    records.push({
      // Global numbering, so a merged shard set is indistinguishable from an
      // unsharded run of the same seed.
      game: index + 1,
      pair: pair + 1,
      // Several seeds come from one recorded game, so the pairs are clustered
      // and an interval treating them as independent is too narrow. Recorded
      // per game so the analysis can cluster rather than having to assume.
      seedSource: seed?.source,
      seedPly: seed?.ply,
      engineXSide: xSide,
      engineYSide: ySide,
      winnerSide: result.winner,
      winnerEngine: result.winner === xSide ? "X" : "Y",
      winReason: result.reason,
      plies: result.plies,
      finalTerritoryMargin: xFinal - yFinal,
      firstTerritoryTurn: {
        X: result.firstTerritoryTurn[xSide],
        Y: result.firstTerritoryTurn[ySide],
        A: result.firstTerritoryTurn.A,
        B: result.firstTerritoryTurn.B,
      },
      peakInfluence: {
        X: xPeak,
        Y: yPeak,
        A: result.peakInfluence.A,
        B: result.peakInfluence.B,
      },
      finalTerritory: {
        X: xFinal,
        Y: yFinal,
        A: result.finalTerritory.A,
        B: result.finalTerritory.B,
      },
      moveHistory: result.moveHistory,
      influenceToTerritoryConversionPercent: {
        X: conversionRate(xFinal, xPeak),
        Y: conversionRate(yFinal, yPeak),
      },
      safeMovesAtPly20: {
        X: result.safeMovesAt[xSide],
        Y: result.safeMovesAt[ySide],
      },
    });
  }

  const output: MatchOutput = {
    label,
    engines: { X: engineX, Y: engineY },
    timeBudgetMs: { X: timeBudgetFor(engineX), Y: timeBudgetFor(engineY) },
    games: records,
    aggregate: aggregateRecords(records),
  };

  const margin = output.aggregate.primaryMetric.summary;
  const counted = output.aggregate.primaryMetric.byFinishReason.TERRITORY;
  const clustered = output.aggregate.gate.clusteredMargin;
  const paired = output.aggregate.gate.pairedMargin;
  const shard = SHARD_COUNT > 1 ? ` [shard ${SHARD_INDEX + 1}/${SHARD_COUNT}]` : "";
  console.log(
    `${label}${shard}: territory margin ${margin.mean} cells over ${margin.count} games ` +
      `(SD ${margin.standardDeviation}, 95% CI [${margin.confidence95.low}, ` +
      `${margin.confidence95.high}])\n` +
      `  counted games only: ${counted.mean} cells over ${counted.count} ` +
      `(95% CI [${counted.confidence95.low}, ${counted.confidence95.high}])\n` +
      // Wins, not just cells. The margin above is the headline metric and for
      // most candidates it is the right one, but a capture ends the game
      // outright here — so any candidate that touches capture defence can win
      // the territory count and still lose more games, and the console line
      // used to make that invisible while the aggregate had it all along.
      `  wins X ${output.aggregate.outcomes.wins.X} / Y ${output.aggregate.outcomes.wins.Y} ` +
      `(X ${output.aggregate.outcomes.winRatePercent.X}%)\n` +
      // The honest interval for a seeded run, which the pooled CI above is not:
      // two mirrored games of a pair are one position, and seeds taken at
      // several plies of one recorded game share their whole history. Same
      // mean, wider and truthful.
      (clustered
        ? `  clustered margin ${clustered.mean} over ${clustered.count} source game(s) ` +
          `(95% CI [${clustered.confidence95.low}, ${clustered.confidence95.high}])\n`
        : `  paired margin ${paired.mean} over ${paired.count} pair(s) ` +
          `(95% CI [${paired.confidence95.low}, ${paired.confidence95.high}])\n`) +
      `  finish reasons ${JSON.stringify(output.aggregate.outcomes.reasons)}; ` +
      `territory decisions ` +
      `${output.aggregate.outcomes.territoryDecisionRatePercent}%\n` +
      `  first territory X ${output.aggregate.firstTerritoryTurn.X.mean} / ` +
      `Y ${output.aggregate.firstTerritoryTurn.Y.mean}; final territory X ` +
      `${output.aggregate.finalTerritory.X.mean} / Y ${output.aggregate.finalTerritory.Y.mean}\n` +
      `  conversion X ${output.aggregate.influenceToTerritoryConversionPercent.X.ratioOfMeans}% / ` +
      `Y ${output.aggregate.influenceToTerritoryConversionPercent.Y.ratioOfMeans}%`,
  );
  return output;
}

const only = process.env.ONLY;
const games = Number(process.env.GAMES ?? (only === "BASELINE" ? 128 : 12));

if (only === "BASELINE") {
  if (VERY_HARD_MS !== 3000) {
    throw new Error(`Phase 0 baseline requires equal 3000ms VERY_HARD budgets, got ${VERY_HARD_MS}ms`);
  }
  if (MAX_PLIES !== 160) {
    throw new Error(`Phase 0 baseline requires MAX_PLIES=160, got ${MAX_PLIES}`);
  }
}

// Under seeding the count comes from the seed set, so echoing GAMES here
// would announce a sample size the run is not going to play.
const seedPreview = SEEDED ? loadSeeds(SEED_FILES, SEED_PLIES) : [];
console.log(
  `HARD ${HARD_MS}ms, VERY_HARD ${VERY_HARD_MS}ms, max ${MAX_PLIES} plies, ` +
    (SEEDED
      ? `${seedPreview.length} seeds x 2 = ${seedPreview.length * 2} games ` +
        `from plies ${SEED_PLIES.join(",")} of ${SEED_FILES.length} file(s)`
      : `${games} games, seed ${ARENA_SEED}`) +
    `\n`,
);

const matches: MatchOutput[] = [];
const addMatch = (label: string, engineX: Engine, engineY: Engine) => {
  matches.push(runMatch(label, engineX, engineY, games));
};

if (only === "OWN") {
  // Loaded up front so a missing or malformed net fails the run rather than
  // quietly turning the candidate back into the baseline.
  const file = JSON.parse(readFileSync(OWNERSHIP_NET, "utf8"));
  setOwnershipNet(file);
  console.log(`ownership net: ${OWNERSHIP_NET}, weight ${OWN_W}\n`);
}

console.time("total");
if (only === "BASELINE") addMatch("VERY_HARD self-play baseline", "VERY_HARD", "VERY_HARD");
if (!only || only === "RANDOM") addMatch("HARD vs RANDOM", "HARD", "RANDOM");
if (!only || only === "EASY") addMatch("HARD vs EASY", "HARD", "EASY");
if (!only || only === "NORMAL") addMatch("HARD vs NORMAL", "HARD", "NORMAL");
if (only === "VS_HARD") addMatch("VERY_HARD vs HARD", "VERY_HARD", "HARD");
if (only === "WIDE") {
  addMatch("VERY_HARD vs WIDE", "VERY_HARD", "WIDE");
  addMatch("HARD vs WIDE", "HARD", "WIDE");
  addMatch("NORMAL vs WIDE", "NORMAL", "WIDE");
}
if (only === "AB") addMatch(`VH+framework(${FRAME_W}) vs VERY_HARD`, "VH_FRAME", "VERY_HARD");
if (only === "THIN") addMatch(`VH+thin(${THIN_W}) vs VERY_HARD(pre-thin)`, "VH_THIN", "VERY_HARD");
if (only === "GUARD") addMatch("VH+guard vs VH-noguard", "VH_GUARD", "VH_NOGUARD");
if (only === "POCKET") addMatch("VH+pocket vs VH-nopocket", "VH_POCKET", "VH_NOPOCKET");
if (only === "RANK") addMatch("VH+rank vs VH-norank", "VH_RANK", "VH_NORANK");
if (only === "SEVERE") addMatch(`VH+severe(${SEVERE_W}) vs VERY_HARD(pre-severe)`, "VH_SEVERE", "VH_NOSEVERE");
if (only === "CORNER") addMatch("VH+corner vs VH-nocorner", "VH_CORNER", "VH_NOCORNER");
if (only === "DENY") addMatch("VH+denyfilter vs VH-nodenyfilter", "VH_DENY", "VH_NODENY");
if (only === "OPPFRAME") addMatch("VH+oppframe vs VH-nooppframe", "VH_OPPFRAME", "VH_NOOPPFRAME");
if (only === "TT") addMatch("VH+ttscores vs VH-nottscores", "VH_TT", "VH_NOTT");
if (only === "OWN") addMatch(`VH+ownership(${OWN_W}) vs VERY_HARD`, "VH_OWN", "VH_NOOWN");
if (only === "SEALURG") {
  addMatch(`VH+urgentSeal(${SEAL_URG}) vs VERY_HARD`, "VH_SEALURG", "VH_NOSEALURG");
}
if (only === "FRAME2") {
  addMatch(`VH+frame(${FRAME_SEAL}) vs VERY_HARD`, "VH_FRAME2", "VH_NOFRAME2");
}
if (only === "RETARGET") {
  addMatch(`VH+retarget(${RETARGETS}) vs VERY_HARD`, "VH_RETARGET", "VH_NORETARGET");
}
// Guard on against guard off. Named so the shipped setting is the first arm:
// VH_THINGUARD is today's engine, VH_NOTHINGUARD is the one being proposed.
if (only === "THINGUARD") {
  addMatch("VH+thinGuard vs VH-thinGuard", "VH_THINGUARD", "VH_NOTHINGUARD");
}
if (only === "THIN2") {
  addMatch(`VH thinGuard@${THIN_LIBS} vs thinGuard@3`, "VH_THIN2", "VH_NOTHIN2");
}
// Candidate first: VH_ESCP discounts escapable pressure, VH_NOESCP is shipped.
if (only === "ESCP") {
  addMatch(`VH escapablePressure(${ESC_W}) vs VERY_HARD`, "VH_ESCP", "VH_NOESCP");
}
// Candidate first: VH_DECISIVE keeps the atari points, VH_NODECISIVE is shipped.
if (only === "DECISIVE") {
  addMatch("VH+decisivePoints vs VERY_HARD", "VH_DECISIVE", "VH_NODECISIVE");
}
if (only === "EYE") {
  addMatch(`VH+eye(${EYE_W})+walling vs VERY_HARD`, "VH_EYE", "VH_NOEYE");
}
if (TESTING_LARGER) {
  addMatch("VH larger version of the same enclosure vs not", "VH_LARGER", "VH_NOLARGER");
}

if (TESTING_SEALOVER) {
  addMatch("VH seal over the book vs the book", "VH_SEALOVER", "VH_NOSEALOVER");
}

if (TESTING_MYSEAL) {
  addMatch(`VH my ${MYSEAL}-cell seal is urgent vs theirs only`, "VH_MYSEAL", "VH_NOMYSEAL");
}

if (TESTING_CONTEST) {
  addMatch("VH answer their corner vs finish my pair", "VH_CONTEST", "VH_OWNFIRST");
}

if (TESTING_SPREAD) {
  addMatch("VH pair in four corners vs frame in two", "VH_SPREAD", "VH_FINISH");
}

if (TESTING_LONE) {
  addMatch("VH one stone in four corners vs the pair", "VH_LONE", "VH_PAIR");
}

if (TESTING_SETTLE) {
  addMatch("VH settle the search passed vs the search", "VH_SETTLE", "VH_NOSETTLE");
}

if (TESTING_LEAVE) {
  addMatch("VH leave a contested corner vs build it", "VH_LEAVE", "VH_STAY");
}

if (TESTING_FOLLOW) {
  addMatch("VH follow their corner investment vs a fixed count", "VH_FOLLOW", "VH_FIXED");
}

if (TESTING_SEALGATE) {
  addMatch(
    `VH sealed gate ${SEALGATE_THRESHOLD} weight ${SEALGATE_WEIGHT} vs shipped gate 3`,
    "VH_SEALGATE",
    "VH_NOSEALGATE",
  );
}

if (TESTING_SEALWALK) {
  addMatch("VH refuse to walk into a sealed shape vs today's guards", "VH_SEALWALK", "VH_NOSEALWALK");
}

if (TESTING_ONESEAL) {
  addMatch("VH one-ply lookahead for a sealed reply, any placement", "VH_ONESEAL", "VH_NOONESEAL");
}

if (TESTING_INSIDE) {
  addMatch("VH answer their corner at (0,1)", "VH_INSIDE", "VH_NOINSIDE");
}
if (TESTING_DENYIN) {
  addMatch("VH deny their frame from inside it", "VH_DENYIN", "VH_NODENYIN");
}
if (TESTING_CORNERANS) {
  addMatch("VH refuse the outside answer to their corner", "VH_CORNERANS", "VH_NOCORNERANS");
}

if (TESTING_CENTRE) {
  addMatch("VH frame to the middle vs array order", "VH_CENTRE", "VH_NOCENTRE");
}

if (TESTING_JOSEKI) {
  addMatch("VH frame vs the scripted player", "VH_BOOKTIGHT", "JOSEKI");
}

// Candidate first: VH_BOOKTIGHT is the no-diagonal side, which the real games
// favour; VH_BOOKDIAG carries the bonus. Run this one with SEEDS unset.
if (TESTING_BOOKDIAG) {
  addMatch(`VH frame, no diagonal vs diagonal(${DIAG})`, "VH_BOOKTIGHT", "VH_BOOKDIAG");
}

// Candidate first: VH_DIAG pays for diagonal own-neighbours, VH_NODIAG is shipped.
if (only === "DIAG") {
  addMatch(`VH diagonal(${DIAG}) vs VERY_HARD`, "VH_DIAG", "VH_NODIAG");
}
// Candidate first: VH_CONTACT damps the pull towards enemy stones, VH_NOCONTACT is shipped.
if (only === "CONTACT") {
  addMatch(`VH contactBias(${CONTACT}) vs VERY_HARD`, "VH_CONTACT", "VH_NOCONTACT");
}
// Candidate first: VH_SETTLED stops counting settled ground twice, VH_NOSETTLED is shipped.
if (only === "SETTLED") {
  addMatch("VH settled-once vs VERY_HARD", "VH_SETTLED", "VH_NOSETTLED");
}
// Candidate first: VH_CALIB prices open ground in expected cells, VH_NOCALIB is shipped.
if (only === "CALIB") {
  addMatch("VH calibrated open ground vs VERY_HARD", "VH_CALIB", "VH_NOCALIB");
}
// Candidate first: VH_SEALUNION adds seals to 1.85's list, VH_NOSEALUNION is shipped.
if (only === "SEALUNION") {
  addMatch("VH 1.85+seals vs VERY_HARD", "VH_SEALUNION", "VH_NOSEALUNION");
}
// Candidate first: VH_EDGE reserves the edge-extension slot, VH_NOEDGE is shipped.
if (only === "EDGE") {
  addMatch("VH+edgeFraming vs VERY_HARD", "VH_EDGE", "VH_NOEDGE");
}
if (only === "CLOSE") {
  addMatch(`VH+closable(${CLOSE_DECAY}) vs VERY_HARD`, "VH_CLOSE", "VH_NOCLOSE");
}
if (only === "POCKETSEAL") addMatch("VH+pocketseal vs VH-nopocketseal", "VH_SEAL", "VH_NOSEAL");
if (only === "VS_SEAL") addMatch("VERY_HARD vs SEAL", "VERY_HARD", "SEAL");
if (only === "SEAL") {
  addMatch("VERY_HARD vs SEAL", "VERY_HARD", "SEAL");
  addMatch("HARD vs SEAL", "HARD", "SEAL");
  addMatch("NORMAL vs SEAL", "NORMAL", "SEAL");
}
if (only === "VS_NORMAL") addMatch("VERY_HARD vs NORMAL", "VERY_HARD", "NORMAL");
if (!only) addMatch("NORMAL vs EASY", "NORMAL", "EASY");
console.timeEnd("total");

if (matches.length === 0) throw new Error(`Unknown ONLY mode: ${String(only)}`);

const runOutput = {
  schemaVersion: 1,
  stage: "PHASE_0_TERRITORY_ARENA_BASELINE",
  generatedAt: new Date().toISOString(),
  primaryMetric: "finalTerritoryMargin",
  diagnosticOnly: true,
  mlCodeAdded: false,
  searchOrGuardChanged: false,
  tuningChanged: false,
  config: {
    // The real sample size, not the requested one. Under seeding these differ,
    // and the merge checks every game number against this — recording the env
    // value would have it reject a complete run as incomplete.
    gamesPerMatch: SEEDED ? seedPreview.length * 2 : games,
    maxPlies: MAX_PLIES,
    openingPlies: RANDOM_OPENING_PLIES,
    arenaSeed: ARENA_SEED,
    hardMs: HARD_MS,
    veryHardMs: VERY_HARD_MS,
    mirrored: true,
    // Shards of one run must agree on which positions they played from.
    seeded: SEEDED,
    seedPlies: SEEDED ? SEED_PLIES : null,
    seedFiles: SEEDED ? SEED_FILES : null,
  },
  matches,
};

if (OUTPUT_JSON) {
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, `${JSON.stringify(runOutput, null, 2)}\n`, "utf8");
  console.log(`wrote ${OUTPUT_JSON}`);
}
