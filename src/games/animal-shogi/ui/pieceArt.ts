import type { PieceType } from "../types";

/**
 * Small hand-drawn SVG silhouettes, one per piece type — no external image
 * assets, matching this hub's self-contained-games rule. Every path lives
 * in a 0-100 viewBox so it drops straight into a square tile at any size.
 *
 * Every shape carries a dark outline stroke, not just a flat fill — at the
 * size these actually render (a fraction of a ~90px tile), overlapping
 * same-colour shapes like the elephant's ear-over-body or the giraffe's
 * spots-on-neck would otherwise merge into one indistinct blob. The
 * outline is what keeps each part legible on its own. Eyes are a fixed
 * dark dot regardless of the tile's own owner colour, the same "cartoon
 * eye" trick real Dōbutsu Shōgi pieces use to stay readable on both
 * sides' tile colours.
 */
const INK = "#2b2b2b";

export const PIECE_ICON_SVG: Record<PieceType, string> = {
  LION: `
    <svg viewBox="0 0 100 100" fill="currentColor" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true">
      <circle cx="82" cy="50" r="12"/>
      <circle cx="71" cy="24.5" r="12"/>
      <circle cx="50" cy="15" r="12"/>
      <circle cx="29" cy="24.5" r="12"/>
      <circle cx="18" cy="50" r="12"/>
      <circle cx="29" cy="75.5" r="12"/>
      <circle cx="50" cy="85" r="12"/>
      <circle cx="71" cy="75.5" r="12"/>
      <circle cx="50" cy="50" r="26"/>
      <circle cx="41" cy="46" r="3.2" fill="${INK}" stroke="none"/>
      <circle cx="59" cy="46" r="3.2" fill="${INK}" stroke="none"/>
      <path d="M45 57 Q50 61 55 57" stroke="${INK}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    </svg>`,
  GIRAFFE: `
    <svg viewBox="0 0 100 100" fill="currentColor" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true">
      <rect x="40" y="26" width="20" height="56" rx="10"/>
      <circle cx="50" cy="19" r="15"/>
      <line x1="44" y1="7" x2="44" y2="2" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <line x1="56" y1="7" x2="56" y2="2" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <circle cx="44" cy="2" r="3" fill="${INK}" stroke="none"/>
      <circle cx="56" cy="2" r="3" fill="${INK}" stroke="none"/>
      <circle cx="45" cy="40" r="5" fill="${INK}" stroke="none" fill-opacity="0.75"/>
      <circle cx="57" cy="54" r="5" fill="${INK}" stroke="none" fill-opacity="0.75"/>
      <circle cx="44" cy="68" r="4.5" fill="${INK}" stroke="none" fill-opacity="0.75"/>
      <circle cx="55" cy="16" r="2.6" fill="${INK}" stroke="none"/>
    </svg>`,
  ELEPHANT: `
    <svg viewBox="0 0 100 100" fill="currentColor" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true">
      <ellipse cx="50" cy="60" rx="32" ry="24"/>
      <ellipse cx="22" cy="44" rx="15" ry="19"/>
      <circle cx="68" cy="36" r="18"/>
      <path d="M76 42 Q90 52 84 70 Q80 78 70 74" fill="currentColor" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="70" cy="31" r="2.8" fill="${INK}" stroke="none"/>
    </svg>`,
  CHICK: `
    <svg viewBox="0 0 100 100" fill="currentColor" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true">
      <circle cx="50" cy="63" r="26"/>
      <circle cx="50" cy="32" r="17"/>
      <polygon points="50,29 66,35 50,42"/>
      <circle cx="55" cy="27" r="2.8" fill="${INK}" stroke="none"/>
    </svg>`,
  HEN: `
    <svg viewBox="0 0 100 100" fill="currentColor" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true">
      <ellipse cx="42" cy="66" rx="26" ry="22"/>
      <path d="M64 58 Q86 55 82 74 Q70 78 62 68 Z"/>
      <circle cx="50" cy="29" r="16"/>
      <polygon points="50,26 66,32 50,38"/>
      <path d="M40 12 L44 20 L48 12 L52 20 L56 12" fill="none" stroke="#e0563f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="55" cy="25" r="2.6" fill="${INK}" stroke="none"/>
    </svg>`,
};

/** Position (as CSS percentages) for each of the 8 compass offsets around a
 * tile's centre, used to place the little movement-direction dots printed
 * on every piece — the same trick real Dōbutsu Shōgi pieces use so a player
 * can read how a piece moves without memorising anything. */
export function offsetPosition(dr: number, dc: number): { top: string; left: string } {
  const along = (n: number) => (n < 0 ? "6%" : n > 0 ? "94%" : "50%");
  return { top: along(dr), left: along(dc) };
}
