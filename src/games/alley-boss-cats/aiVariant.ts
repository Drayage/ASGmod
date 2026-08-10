import { tuning } from "./ai";
import {
  setCornerBookEnabled,
  setCornerBookFinishEnabled,
  setEyeMakingDefenceEnabled,
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
export type AIVariant = "STANDARD" | "EYE" | "THIN_GUARD" | "EYE_THIN" | "EYE_EDGE" | "EYE_SPACING" | "EYE_CORNER" | "EYE_CORNER_DIAG" | "EYE_FRAME" | "EYE_FRAME_TIGHT";

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
    help: "지금 엔진입니다. 귀 두 개를 네 돌짜리 정석으로 완성할 때까지 이어 두고, 위험한 그룹은 뻗는 대신 눈을 만들어 삽니다.",
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
    variant === "EYE_FRAME_TIGHT";
  const thin = variant === "THIN_GUARD" || variant === "EYE_THIN";
  const edge = variant === "EYE_EDGE";
  const spacing = variant === "EYE_SPACING";
  const corner =
    variant === "EYE_CORNER" ||
    variant === "EYE_CORNER_DIAG" ||
    variant === "EYE_FRAME" ||
    variant === "EYE_FRAME_TIGHT";
  const diagonal = variant === "EYE_CORNER_DIAG" || variant === "EYE_FRAME";
  const finish = variant === "EYE_FRAME" || variant === "EYE_FRAME_TIGHT";

  tuning.eyeSpaceWeight = eye ? EYE_SPACE_WEIGHT : 0;
  setEyeMakingDefenceEnabled(eye);
  setThinGroupGuardEnabled(thin);
  setEdgeFramingEnabled(edge);
  // Only the flat attraction to enemy stones; capture and atari scoring is
  // untouched, which is why the arena's capture count did not get worse.
  setContactBias(spacing ? 0 : 1);
  setCornerBookEnabled(corner);
  setCornerBookFinishEnabled(finish);
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
