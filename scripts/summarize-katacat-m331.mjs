import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    if (separator < 0) values[argument.slice(2)] = "true";
    else values[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return values;
}

function wilson95(wins, games) {
  if (games <= 0) return { low: null, high: null };
  const z = 1.959963984540054;
  const rate = wins / games;
  const denominator = 1 + (z * z) / games;
  const centre = (rate + (z * z) / (2 * games)) / denominator;
  const radius =
    (z / denominator) *
    Math.sqrt((rate * (1 - rate)) / games + (z * z) / (4 * games * games));
  return {
    low: Math.max(0, centre - radius),
    high: Math.min(1, centre + radius),
  };
}

function lossDiagnostics(games) {
  const losses = games.filter((game) => !game.candidateWon);
  const captureLosses = losses.filter((game) => game.winReason === "CAPTURE");
  const unverifiedFallbackLosses = losses.filter(
    (game) => game.lastCandidateDecision?.fallbackToUnverified === true,
  );
  const allRootActionsRefutedLosses = losses.filter(
    (game) => game.lastCandidateDecision?.allRootActionsRefuted === true,
  );
  const selectedActionWasRefutedLosses = losses.filter(
    (game) => game.lastCandidateDecision?.selectedActionWasRefuted === true,
  );
  return {
    losses: losses.length,
    captureLosses: captureLosses.length,
    unverifiedFallbackLosses: unverifiedFallbackLosses.length,
    unverifiedFallbackShareOfLosses:
      losses.length > 0 ? unverifiedFallbackLosses.length / losses.length : 0,
    allRootActionsRefutedLosses: allRootActionsRefutedLosses.length,
    selectedActionWasRefutedLosses: selectedActionWasRefutedLosses.length,
  };
}

function seatSummary(games, seat) {
  const seated = games.filter((game) => game.candidatePlayer === seat);
  const wins = seated.filter((game) => game.candidateWon).length;
  return {
    games: seated.length,
    wins,
    losses: seated.length - wins,
    winRate: seated.length > 0 ? wins / seated.length : null,
    wilson95: wilson95(wins, seated.length),
    lossDiagnostics: lossDiagnostics(seated),
  };
}

function pairSummary(games) {
  const pairs = new Map();
  for (const game of games) {
    const pair = pairs.get(game.pairIndex) ?? [];
    pair.push(game);
    pairs.set(game.pairIndex, pair);
  }
  const counts = { pairs: pairs.size, sweeps: 0, splits: 0, swept: 0, malformed: 0 };
  for (const pair of pairs.values()) {
    if (pair.length !== 2 || new Set(pair.map((game) => game.candidatePlayer)).size !== 2) {
      counts.malformed += 1;
      continue;
    }
    const wins = pair.filter((game) => game.candidateWon).length;
    if (wins === 2) counts.sweeps += 1;
    else if (wins === 1) counts.splits += 1;
    else counts.swept += 1;
  }
  return counts;
}

function matchupSummary(raw, matchup) {
  const games = raw.games.filter((game) => game.matchup === matchup);
  const wins = games.filter((game) => game.candidateWon).length;
  const territoryMargins = games
    .map((game) => game.candidateTerritoryMargin)
    .filter((value) => typeof value === "number");
  const byCandidateSeat = {
    A: seatSummary(games, "A"),
    B: seatSummary(games, "B"),
  };
  return {
    games: games.length,
    wins,
    losses: games.length - wins,
    winRate: games.length > 0 ? wins / games.length : null,
    wilson95: wilson95(wins, games.length),
    captureLosses: games.filter((game) => game.candidateCaptureLoss).length,
    captureLossRate:
      games.length > 0
        ? games.filter((game) => game.candidateCaptureLoss).length / games.length
        : null,
    territoryGames: territoryMargins.length,
    meanCandidateTerritoryMargin:
      territoryMargins.length > 0
        ? territoryMargins.reduce((sum, value) => sum + value, 0) / territoryMargins.length
        : null,
    byCandidateSeat,
    absoluteSeatWinRateGap:
      byCandidateSeat.A.winRate !== null && byCandidateSeat.B.winRate !== null
        ? Math.abs(byCandidateSeat.A.winRate - byCandidateSeat.B.winRate)
        : null,
    mirroredPairs: pairSummary(games),
    lossDiagnostics: lossDiagnostics(games),
  };
}

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input ?? "katacat-m331-raw/arena-summary.json");
const output = resolve(args.output ?? "katacat-m331-output/summary.json");
const sourceRunId = args["source-run-id"] ?? process.env.KATACAT_M331_SOURCE_RUN_ID ?? null;
const raw = JSON.parse(readFileSync(input, "utf8"));

if (raw.stage !== "M3.3_ARENA") {
  throw new Error(`Expected M3.3_ARENA source report, received ${raw.stage}`);
}
if (!Array.isArray(raw.games) || raw.games.length === 0) {
  throw new Error("M3.3.1 source report contains no games");
}

const previousChampion = matchupSummary(raw, "PREVIOUS");
const currentVeryHard = matchupSummary(raw, "CURRENT");
const expectedGamesPerOpponent = Number(raw.options?.gamesPerOpponent ?? 0);
const expectedPairsPerOpponent = expectedGamesPerOpponent / 2;

const acceptance = {
  sourceSmokePassed: raw.smokeAcceptance?.passed === true,
  frozenSourceRunRecorded: sourceRunId !== null,
  minimum64GamesPerOpponent:
    previousChampion.games >= 64 && currentVeryHard.games >= 64,
  exactConfiguredGamesPerOpponent:
    previousChampion.games === expectedGamesPerOpponent &&
    currentVeryHard.games === expectedGamesPerOpponent,
  completeMirroredPairs:
    previousChampion.mirroredPairs.pairs === expectedPairsPerOpponent &&
    currentVeryHard.mirroredPairs.pairs === expectedPairsPerOpponent &&
    previousChampion.mirroredPairs.malformed === 0 &&
    currentVeryHard.mirroredPairs.malformed === 0,
  bothSeatsMeasured:
    previousChampion.byCandidateSeat.A.games > 0 &&
    previousChampion.byCandidateSeat.B.games > 0 &&
    currentVeryHard.byCandidateSeat.A.games > 0 &&
    currentVeryHard.byCandidateSeat.B.games > 0,
  finalGuardInvariant:
    raw.agents?.CANDIDATE?.invariantViolations === 0 &&
    raw.agents?.CHAMPION?.invariantViolations === 0,
  noRandomRollouts: raw.smokeAcceptance?.noRandomRollouts === true,
  passed: false,
};
acceptance.passed = Object.entries(acceptance)
  .filter(([key]) => key !== "passed")
  .every(([, value]) => value === true);

const report = {
  schemaVersion: 1,
  stage: "M3.3.1_FROZEN_EXTENDED_ARENA",
  source: {
    workflow: "KataCat M3.3",
    runId: sourceRunId,
    sourceStage: raw.stage,
    candidateCheckpoint: "katacat-m33-model/katacat-m33.pt",
    championCheckpoint: "katacat-m31-model/katacat-m3.pt",
    checkpointsReusedWithoutTraining: true,
  },
  options: raw.options,
  previousChampion,
  currentVeryHard,
  candidateAgent: raw.agents?.CANDIDATE ?? null,
  championAgent: raw.agents?.CHAMPION ?? null,
  currentAgent: raw.agents?.CURRENT ?? null,
  acceptance,
  extendedGate: {
    previousChampionThreshold: 0.525,
    currentVeryHardThreshold: 0.55,
    beatsPreviousChampion: previousChampion.winRate >= 0.525,
    beatsCurrentVeryHard: currentVeryHard.winRate >= 0.55,
    pointEstimatePassed:
      previousChampion.winRate >= 0.525 && currentVeryHard.winRate >= 0.55,
    confidenceLowerBoundsPass:
      previousChampion.wilson95.low >= 0.525 && currentVeryHard.wilson95.low >= 0.55,
    formalPromotionEligible: expectedGamesPerOpponent >= 400,
    formalPromotionPassed:
      expectedGamesPerOpponent >= 400 &&
      previousChampion.winRate >= 0.525 &&
      currentVeryHard.winRate >= 0.55,
  },
  note:
    "M3.3.1 reuses the exact successful M3.3 candidate and champion artifacts and changes only the arena sample size. Sixty-four games per opponent are diagnostic evidence, not the formal 400-game promotion gate.",
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`KATACAT_M331_SUMMARY:${JSON.stringify(report)}`);

if (!acceptance.passed) process.exitCode = 1;
