import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, ...rest] = argument.slice(2).split("=");
    values[key] = rest.join("=");
  }
  return values;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

const args = parseArgs(process.argv.slice(2));
const selfplayPath = args.selfplay ?? "katacat-m3-output/selfplay-summary.json";
const trainingPath = args.training ?? "katacat-m3-model/summary.json";
const candidatePath = args.candidate ?? "katacat-m3-candidate-check/summary.json";
const outputPath = resolve(args.output ?? "katacat-m3-output/summary.json");

const selfplay = readJson(selfplayPath);
const training = readJson(trainingPath);
const candidate = readJson(candidatePath);

const acceptance = {
  selfplayPassed: selfplay?.acceptance?.passed === true,
  replayVerified: selfplay?.acceptance?.replayVerified === true,
  naturalTerminalsOnly: selfplay?.acceptance?.naturalTerminalsOnly === true,
  exactVisitAccounting: selfplay?.acceptance?.exactVisitAccounting === true,
  illegalVisitsZero: selfplay?.acceptance?.illegalVisitsZero === true,
  multiVisitTargetsObserved: selfplay?.acceptance?.multiVisitTargetsObserved === true,
  splitDisjoint: selfplay?.acceptance?.splitDisjoint === true,
  rootNoiseApplied: selfplay?.acceptance?.rootNoiseApplied === true,
  temperatureSamplingApplied: selfplay?.acceptance?.temperatureSamplingApplied === true,
  candidateTrainingPassed: training?.smokeAcceptance?.passed === true,
  candidateCheckpointSaved: training?.smokeAcceptance?.candidateCheckpointSaved === true,
  candidateNeuralPuctPassed: candidate?.acceptance?.passed === true,
  candidateInferenceCompleted: candidate?.acceptance?.neuralInferenceCompleted === true,
  noRandomRollouts: candidate?.acceptance?.randomRolloutsUsed === false,
  passed: false,
};
acceptance.passed = Object.entries(acceptance)
  .filter(([key]) => key !== "passed")
  .every(([, value]) => value === true);

const summary = {
  schemaVersion: 1,
  stage: "M3",
  selfplay: {
    generatedGames: selfplay.generatedGames,
    generatedSamples: selfplay.generatedSamples,
    options: selfplay.options,
    resultTypes: selfplay.resultTypes,
    acceptance: selfplay.acceptance,
  },
  training: {
    trainGames: training.trainGames,
    validationGames: training.validationGames,
    trainSamples: training.trainSamples,
    validationSamples: training.validationSamples,
    selfplayVisitTargets: training.selfplayVisitTargets,
    bestEpoch: training.bestEpoch,
    initialValidation: training.initialValidation,
    bestValidation: training.bestValidation,
    smokeAcceptance: training.smokeAcceptance,
  },
  candidateCheck: {
    simulations: candidate.simulations,
    selectedAction: candidate.selectedAction,
    visitedActions: candidate.visitedActions,
    acceptance: candidate.acceptance,
  },
  acceptance,
  note: "M3 validates one complete bootstrap -> PUCT self-play -> visit-target retraining -> candidate PUCT inference loop. Model promotion and CURRENT win-rate gates remain M4.",
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`KATACAT_M3:${JSON.stringify(summary)}`);
if (!acceptance.passed) process.exit(1);
