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
 */
export type AIVariant = "STANDARD" | "EYE" | "THIN_GUARD" | "EYE_THIN" | "EYE_EDGE" | "EYE_SPACING" | "EYE_CORNER" | "EYE_CORNER_DIAG" | "EYE_FRAME" | "EYE_FRAME_TIGHT";

export const AI_VARIANTS: ReadonlyArray<{
  value: AIVariant;
  label: string;
  help: string;
}> = [
  {
    value: "STANDARD",
    label: "이전 엔진",
    help: "눈 만들기가 없던 예전 동작. 비교용입니다.",
  },
  {
    value: "EYE",
    label: "기본 (눈 만들기)",
    help: "위험한 그룹을 뻗어서 살리는 대신 눈을 만들어 살리는 수도 후보에 넣습니다.",
  },
  {
    value: "THIN_GUARD",
    label: "얇은 그룹 방어",
    help: "활로가 세 개 이하로 줄어든 그룹을 우선 보강합니다.",
  },
  {
    value: "EYE_THIN",
    label: "눈 만들기 + 얇은 그룹",
    help: "위 두 가지를 함께 켭니다.",
  },
  {
    value: "EYE_CORNER",
    label: "눈 만들기 + 귀 선수점",
    help: "초반 네 수 동안, 아무도 안 들어간 귀가 있으면 그 귀의 선수점을 둡니다. 사람은 첫 여섯 수 중 3.3개를 그 점에 두는데 엔진은 1.0개였습니다. 위험한 수가 하나도 없을 때만 적용됩니다.",
  },
  {
    value: "EYE_CORNER_DIAG",
    label: "눈 만들기 + 귀 선수점 + 대각",
    help: "위의 귀 선수점에 더해, 자기 돌에 대각으로 붙는 수를 후보 정렬에서 직선만큼 쳐줍니다. 지금은 직선에만 점수가 있어서, 사람이 대각으로 두는 비율 66%에 엔진은 39%였습니다.",
  },
  {
    value: "EYE_FRAME",
    label: "눈 만들기 + 귀 정석 완성 + 대각",
    help: "위의 귀 선수점을 찍고 끝내지 않고, 귀 두 개를 네 돌짜리 정석으로 완성할 때까지 이어 둡니다. 지금까지 엔진은 방해받지 않은 귀에 평균 2.1돌만 두고 14수째에 손을 뗐고 2.6칸을 남겼습니다. 세 돌 이상 둔 귀는 6칸이 됐습니다.",
  },
  {
    value: "EYE_FRAME_TIGHT",
    label: "귀 정석 완성 (대각 없음)",
    help: "위와 같은데 대각 보너스만 뺍니다. 대각을 켠 뒤로 엔진 돌의 절반이 직선 이웃 없이 대각으로만 붙어 있고(이전 17%), 잡혀서 진 판이 9%에서 30%로 늘었습니다. 아레나에서는 반대로 나왔으므로, 이 둘을 갈라 재기 위한 짝입니다.",
  },
  {
    value: "EYE_SPACING",
    label: "눈 만들기 + 거리두기",
    help: "상대 돌에 달라붙는 성향을 뺍니다. 사람은 중반 착점의 53%가 상대 돌 옆인데 엔진은 75%였습니다. 잡기·단수 판단은 그대로입니다. 이득은 아직 확인되지 않았습니다.",
  },
  {
    value: "EYE_EDGE",
    label: "눈 만들기 + 가장자리",
    help: "가장자리를 따라 벌려서 집을 짜는 수를 후보에 넣습니다. 사람은 영역 둘레의 43%를 판 가장자리로 쓰는데 엔진은 13%뿐이었습니다.",
  },
];

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
  // Kept off everywhere but EYE_FRAME. The three games already played on
  // EYE_CORNER_DIAG are the comparison, so that name has to keep meaning what it
  // meant when they were played.
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
