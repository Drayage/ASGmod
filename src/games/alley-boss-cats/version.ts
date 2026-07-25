/**
 * Build identity, injected by Vite at build time (see vite.config.ts).
 *
 * Declared with fallbacks so tests and the arena, which import the game modules
 * directly without going through Vite, do not blow up on an undefined global.
 */
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export const BUILD_TIME: string =
  typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "";
