import { setSealedLibertyThreshold, tuning } from "./ai";
import {
  setCornerBookEnabled,
  setCornerBookFinishEnabled,
  setCornerBookFollowEnabled,
  setCornerBookSpreadEnabled,
  setEyeMakingDefenceEnabled,
  setOneMoveSealedTrapGuardEnabled,
  setSelfInflictedSealedGuardEnabled,
  setThinGroupGuardEnabled,
} from "./engine/minimax";
import { setContactBias, setEdgeFramingEnabled, setOwnDiagonalBonus } from "./engine/moveOrdering";
import { setSettledOutOfInfluenceEnabled } from "./engine/territoryPlanner";

/**
 * Named engine settings the player can pick between before a game.
 *
 * Every measurement in this branch has run into the same wall: the arena plays
 * engine against engine, and the weaknesses that decide real games — territory,
 * and a group being slowly walled in — barely occur there. Two changes were
 * judged by it and both readings were wrong, one shipped as a regression and one
 * reverted that should not have been.
 *
 * So this makes the player the instrument. Each variant is one hypothesis, the
 * choice is recorded in the match record, and the games can be split by it after
 * the fact.
 *
 * `apply` always sets every switch, never only the ones a variant changes, so
 * picking a variant fully describes the engine rather than depending on what was
 * chosen before it.
 *
 * The picker only lists live hypotheses. A variant whose question has been
 * answered is retired to `RETIRED_VARIANTS` rather than deleted: forty-odd
 * recorded games are split by these names, `applyAIVariant` still has to
 * reproduce the engine that played them for a game resumed mid-way, and the
 * label is what a record shows. Ten entries in the picker was nine questions
 * being asked at once, which is not what any of them were for.
 */
export type AIVariant = "STANDARD" | "EYE" | "THIN_GUARD" | "EYE_THIN" | "EYE_EDGE" | "EYE_SPACING" | "EYE_CORNER" | "EYE_CORNER_DIAG" | "EYE_FRAME" | "EYE_FRAME_TIGHT" | "EYE_FOLLOW" | "EYE_SEALGATE" | "EYE_SEALWALK" | "EYE_LONETRAP";

interface VariantEntry {
  value: AIVariant;
  label: string;
  help: string;
}

/** What the picker offers: the current engine, and the two live comparisons. */
export const AI_VARIANTS: ReadonlyArray<VariantEntry> = [
  {
    value: "EYE_FRAME_TIGHT",
    label: "기본",
    help: "지금 엔진입니다. 네 귀에 가운데 쌍(두 돌)을 하나씩 놓아 귀를 넓게 잡고, 위험한 그룹은 뻗는 대신 눈을 만들어 삽니다. 빈 판 240판에서 프레임을 두 귀에 완성하는 방식보다 승률 61.3%, 집 +1.05칸이었습니다.",
  },
  {
    value: "EYE_FOLLOW",
    label: "기본 + 귀 따라두기",
    help: "기본에, 귀에 쓰는 돌 수를 상대에 맞추는 규칙을 더합니다. 한 돌씩으로 동수면 그 귀를 두고 아무도 없는 귀로 가고, 상대가 두 돌째를 놓으면 돌아와 맞춥니다. 빈 판 240판에서 승률 52.5%로 유일하게 50%를 넘겼지만 집은 0.28칸 적었고, 둘 다 우연과 구분되지 않는 크기입니다. 사람 상대에서 어떤지가 남은 질문입니다.",
  },
  {
    value: "EYE_SEALGATE",
    label: "기본 + 봉쇄 감지",
    help: "기본에, 자기 그룹이 더 이상 자유칸을 늘릴 수 없는 모양인지 자유칸 5개까지 미리 확인하는 항목을 더합니다. 원래는 자유칸 3개 이하일 때만 봤는데, 세 판을 뜯어보니 그룹이 죽은 세 판 모두 3개 밑으로 떨어지기 한참 전, 자유칸 4~5개일 때 이미 더 클 수 없는 모양이었고 엔진은 그 뒤로 한 번도 그 그룹을 다시 안 뒀습니다. 빈 판 240판에서 승률 53.75%, 잡히는 쪽 승부에서 55.7%로 방향은 맞지만 우연과 구분되지 않고, 집 손해는 없습니다(+0.08칸). 실전에서 이 모양 자체가 잘 안 나오는 상대(엔진)로는 재기 어려운 변화라 사람 상대로 확인이 필요합니다.",
  },
  {
    value: "EYE_SEALWALK",
    label: "기본 + 죽을 자리 회피",
    help: "기본에, 지금 자유칸이 넉넉해 보여도 더 이상 늘어날 수 없는 모양으로 스스로 걸어 들어가는 수를 후보에서 뺍니다. 실제로 잡힌 판에서 확인된 수(D6)를 근거로 만들었습니다 — 자유칸 5개로 다른 방어 점검은 다 통과했지만 canBreathe로 보면 이미 죽은 모양이었고, 9수 뒤 잡혔습니다. 빈 판 240판에서는 승률 49.6%로 차이가 없었는데, 아레나 상대는 그 정확한 함정을 잘 안 만들어서 그렇습니다. 확인된 버그 수정이라 위험은 낮고, 사람 상대로 판단이 필요합니다.",
  },
  {
    value: "EYE_LONETRAP",
    label: "기본 + 고립수 회피",
    help: "기본에, 주변에 자기 돌이 하나도 없는 자리에 새로 두면서 상대가 한 수로 봉쇄해버릴 수 있는 수를 후보에서 뺍니다. 실제로 잡힌 판에서 확인된 수(H5)가 근거입니다 — 가장 가까운 아군이 3칸 밖, 상대 돌은 2칸 안에 다섯 개였고, 한 수 뒤 봉쇄되어 방치되다 잡혔습니다. 빈 판 240판에서 승률 53.3%, 잡히는 승부에서 56.7%로 지금까지 중 잡힘 쪽 신호가 가장 강합니다. 대신 집은 0.38칸 적습니다(구간이 0을 포함하므로 확정은 아닙니다). 귀 정석의 대각 짝 간격은 면제되도록 만들어서 정석 수는 걸리지 않습니다.",
  },
  {
    value: "EYE_FRAME",
    label: "기본 + 대각",
    help: "기본에 대각 보너스만 더합니다. 빈 판 240판에서 힘은 동률(50.4%)이고 집도 차이가 없는데 잡혀서 지는 비율만 35% 대 25%로 높아, 기본에서 뺐습니다. 사람 상대에서도 그런지가 남은 질문이라 비교용으로 남겨둡니다.",
  },
  {
    value: "EYE",
    label: "귀 정석 없음",
    help: "눈 만들기만 켠 예전 동작. 귀 책이 얼마나 벌어주는지 견주는 기준선입니다.",
  },
];

/**
 * Answered, and off the picker. Kept so a resumed game plays as the engine that
 * started it and a record can still be labelled.
 */
export const RETIRED_VARIANTS: ReadonlyArray<{ value: AIVariant; label: string; why: string }> = [
  { value: "STANDARD", label: "이전 엔진", why: "눈 만들기 이전 동작. 기준선은 EYE로 옮겼습니다." },
  { value: "THIN_GUARD", label: "얇은 그룹 방어", why: "이득이 확인되지 않았습니다." },
  { value: "EYE_THIN", label: "눈 만들기 + 얇은 그룹", why: "이득이 확인되지 않았습니다." },
  { value: "EYE_CORNER", label: "눈 만들기 + 귀 선수점", why: "귀 예산이 다섯 수에서 끊겨 정석을 못 끝냈습니다. EYE_FRAME_TIGHT이 대체합니다." },
  { value: "EYE_CORNER_DIAG", label: "눈 만들기 + 귀 선수점 + 대각", why: "위와 같고, 대각도 기본에서 빠졌습니다." },
  { value: "EYE_SPACING", label: "눈 만들기 + 거리두기", why: "이득이 확인되지 않았습니다." },
  { value: "EYE_EDGE", label: "눈 만들기 + 가장자리", why: "이득이 없고 잡혀 지는 비율이 가장 높았습니다 (4판 중 2판)." },
];

/** The name a record shows, live or retired. */
export function variantLabel(variant: AIVariant | undefined): string {
  if (!variant) return "기록 없음";
  const live = AI_VARIANTS.find((v) => v.value === variant);
  if (live) return live.label;
  return RETIRED_VARIANTS.find((v) => v.value === variant)?.label ?? variant;
}

/** Points per liberty of a thin group that could still be closed into an eye. */
const EYE_SPACE_WEIGHT = 60;
/** What one diagonally adjacent own stone adds in the move ordering. */
const DIAGONAL_BONUS = 15;

export function applyAIVariant(variant: AIVariant): void {
  const eye =
    variant === "EYE" ||
    variant === "EYE_THIN" ||
    variant === "EYE_EDGE" ||
    variant === "EYE_SPACING" ||
    variant === "EYE_CORNER" ||
    variant === "EYE_CORNER_DIAG" ||
    variant === "EYE_FRAME" ||
    variant === "EYE_FRAME_TIGHT" ||
    variant === "EYE_FOLLOW" ||
    variant === "EYE_SEALGATE" ||
    variant === "EYE_SEALWALK" ||
    variant === "EYE_LONETRAP";
  const thin = variant === "THIN_GUARD" || variant === "EYE_THIN";
  const edge = variant === "EYE_EDGE";
  const spacing = variant === "EYE_SPACING";
  const corner =
    variant === "EYE_CORNER" ||
    variant === "EYE_CORNER_DIAG" ||
    variant === "EYE_FRAME" ||
    variant === "EYE_FRAME_TIGHT" ||
    variant === "EYE_FOLLOW" ||
    variant === "EYE_SEALGATE" ||
    variant === "EYE_SEALWALK" ||
    variant === "EYE_LONETRAP";
  const diagonal = variant === "EYE_CORNER_DIAG" || variant === "EYE_FRAME";
  const finish =
    variant === "EYE_FRAME" ||
    variant === "EYE_FRAME_TIGHT" ||
    variant === "EYE_FOLLOW" ||
    variant === "EYE_SEALGATE" ||
    variant === "EYE_SEALWALK" ||
    variant === "EYE_LONETRAP";

  tuning.eyeSpaceWeight = eye ? EYE_SPACE_WEIGHT : 0;
  setEyeMakingDefenceEnabled(eye);
  setThinGroupGuardEnabled(thin);
  setEdgeFramingEnabled(edge);
  // Only the flat attraction to enemy stones; capture and atari scoring is
  // untouched, which is why the arena's capture count did not get worse.
  setContactBias(spacing ? 0 : 1);
  setCornerBookEnabled(corner);
  setCornerBookFinishEnabled(finish);
  // Two stones in four corners rather than four in two — the player's own method
  // against the engine, and the strongest controlled result this branch has:
  // 61.3% +/- 5.9 of 240 empty-board games and +1.05 +/- 0.56 cells, both
  // intervals clear of even, with no more groups lost. The middle pair already
  // leaves an invader alive at none of a corner's eight entry points, so the
  // frame's last two stones were buying cells and no safety.
  setCornerBookSpreadEnabled(finish);
  // Matching what the opponent spends on a corner rather than a fixed two: level
  // corners are left for one nobody is in, and a corner they put a second stone
  // in is one to come back to. The player's own rule, and the only arm of four
  // to finish above even on games won (52.5% of 240) — while holding 0.28 cells
  // fewer, and neither number is outside what chance produces at that count. On
  // the picker so it can be judged where the arena cannot judge it.
  setCornerBookFollowEnabled(variant === "EYE_FOLLOW");
  // Widening what `sealed` can see past three liberties — see its own comment
  // in ai.ts. Measured null on the arena's own engine opponent (53.75% of 240,
  // territory flat), which is expected: the arena's opponent does not hunt a
  // cornered group the patient way the player did, and that patience is
  // exactly what this is aimed at. On the picker so real games can judge it.
  setSealedLibertyThreshold(variant === "EYE_SEALGATE" ? 5 : 3);
  tuning.sealedWeight = variant === "EYE_SEALGATE" ? 150 : 0;
  // Removing a move from stage 1.85's own candidates when it walks a group
  // into a shape canBreathe already knows is sealed — see its own comment.
  // Measured null on the arena (49.6% of 240, no direction either way), which
  // fits the pattern: the arena's opponent does not build the exact trap this
  // catches. Confirmed directly on the recorded position it was built from.
  setSelfInflictedSealedGuardEnabled(variant === "EYE_SEALWALK");
  // Refusing an isolated placement the opponent can seal in one reply. The
  // unnarrowed version cost 0.70 cells (§81); requiring no friendly stone
  // within a diagonal step turned that into 53.3% of 240 with 56.7% on the
  // capture-decided games — the strongest capture-side signal of the three,
  // still not decisive, and 0.38 cells behind on territory.
  setOneMoveSealedTrapGuardEnabled(variant === "EYE_LONETRAP");
  // 15 is where the diagonal overtakes the straight connection in the ordering:
  // an orthogonal neighbour scores 29-32 in a typical corner and a diagonal 15,
  // so anything less leaves the order unchanged and much more would swamp the
  // liberty terms beside it.
  setOwnDiagonalBonus(diagonal ? DIAGONAL_BONUS : 0);
  // The region curve is not offered as a variant: measured, it moves a dividing
  // move by 3.5 points where the gap to the next candidate is 36 at the median,
  // so it cannot change the choice and did not. Kept as a tuning flag for the
  // scripts, off everywhere else.
  tuning.influenceRegionCurve = false;
  // Not a variant axis: settled ground being counted once is a correction, and
  // every variant gets it. Set here anyway so a script that flipped the module
  // flag cannot leak into a game.
  setSettledOutOfInfluenceEnabled(true);
}
