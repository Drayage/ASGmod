import { maps } from "./maps";

/** Fixed difficulty for the daily challenge — everyone plays the exact same
 * board on the exact same day, so varying it would just be a second random
 * factor on top of the map choice. */
export const DAILY_DIFFICULTY = "NORMAL" as const;

/** Local calendar date as `YYYY-MM-DD`, the key both the map pick and the
 * saved result are keyed by. Local time on purpose — "today" should match
 * what the player's clock says, not UTC. */
export function todayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Small string hash (djb2) so the same date key always picks the same map,
 * without needing any shared server — every player's client computes the
 * identical index from the identical date string. */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return hash >>> 0;
}

export function dailyMapId(dateKey: string): string {
  const index = hashString(dateKey) % maps.length;
  return maps[index].id;
}
