import { tuning } from "./ai";
import { setEyeMakingDefenceEnabled, setThinGroupGuardEnabled } from "./engine/minimax";
import { setEdgeFramingEnabled } from "./engine/moveOrdering";

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
export type AIVariant = "STANDARD" | "EYE" | "THIN_GUARD" | "EYE_THIN" | "EYE_EDGE";

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
    value: "EYE_EDGE",
    label: "눈 만들기 + 가장자리",
    help: "가장자리를 따라 벌려서 집을 짜는 수를 후보에 넣습니다. 사람은 영역 둘레의 43%를 판 가장자리로 쓰는데 엔진은 13%뿐이었습니다.",
  },
];

/** Points per liberty of a thin group that could still be closed into an eye. */
const EYE_SPACE_WEIGHT = 60;

export function applyAIVariant(variant: AIVariant): void {
  const eye = variant === "EYE" || variant === "EYE_THIN" || variant === "EYE_EDGE";
  const thin = variant === "THIN_GUARD" || variant === "EYE_THIN";
  const edge = variant === "EYE_EDGE";

  tuning.eyeSpaceWeight = eye ? EYE_SPACE_WEIGHT : 0;
  setEyeMakingDefenceEnabled(eye);
  setThinGroupGuardEnabled(thin);
  setEdgeFramingEnabled(edge);
}
