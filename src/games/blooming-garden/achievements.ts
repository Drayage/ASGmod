import { maps } from "./maps";
import type { Stats } from "./storage";

export interface Achievement {
  id: string;
  title: string;
  description: string;
  isUnlocked: (stats: Stats) => boolean;
}

/**
 * Achievements are pure derived state — checked against `Stats` on demand
 * rather than tracked as their own "unlocked" flags in storage, so there is
 * nothing here that can fall out of sync with the numbers that actually
 * earned them.
 */
export const ACHIEVEMENTS: Achievement[] = [
  {
    id: "first-win",
    title: "첫 승리",
    description: "정원 대결에서 처음으로 승리하세요.",
    isUnlocked: (s) => s.wins >= 1,
  },
  {
    id: "beat-easy",
    title: "쉬움 난이도 정복",
    description: "쉬움 AI를 상대로 승리하세요.",
    isUnlocked: (s) => s.winsByDifficulty.EASY >= 1,
  },
  {
    id: "beat-normal",
    title: "보통 난이도 정복",
    description: "보통 AI를 상대로 승리하세요.",
    isUnlocked: (s) => s.winsByDifficulty.NORMAL >= 1,
  },
  {
    id: "beat-hard",
    title: "어려움 난이도 정복",
    description: "어려움 AI를 상대로 승리하세요.",
    isUnlocked: (s) => s.winsByDifficulty.HARD >= 1,
  },
  {
    id: "online-debut",
    title: "온라인 데뷔 승리",
    description: "온라인 대전에서 처음으로 승리하세요.",
    isUnlocked: (s) => s.winsByMode.ONLINE >= 1,
  },
  {
    id: "five-wins",
    title: "정원사 5승",
    description: "누적 5승을 달성하세요.",
    isUnlocked: (s) => s.wins >= 5,
  },
  {
    id: "win-streak-3",
    title: "3연승",
    description: "연속으로 3번 승리하세요.",
    isUnlocked: (s) => s.bestWinStreak >= 3,
  },
  {
    id: "draw",
    title: "무승부의 미학",
    description: "무승부로 게임을 마쳐보세요.",
    isUnlocked: (s) => s.draws >= 1,
  },
  {
    id: "all-maps",
    title: "모든 정원 탐방",
    description: "등록된 모든 맵에서 한 번씩 플레이하세요.",
    isUnlocked: (s) => Object.keys(s.playsByMap).length >= maps.length,
  },
  {
    id: "twenty-games",
    title: "열정의 정원사",
    description: "누적 20게임을 플레이하세요.",
    isUnlocked: (s) => s.gamesPlayed >= 20,
  },
];

export function unlockedCount(stats: Stats): number {
  return ACHIEVEMENTS.filter((a) => a.isUnlocked(stats)).length;
}
