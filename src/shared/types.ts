/** Contract every game module must implement. Keep games self-contained: no
 * game should import from another game's folder. */
export interface GameModule {
  /** Render the game into `container`. Called once per visit to the game route. */
  mount(container: HTMLElement): void | GameCleanup;
}

/** Optional teardown returned from `mount`, called before navigating away
 * (e.g. to cancel timers or remove window-level listeners). */
export type GameCleanup = () => void;

export interface GameMeta {
  /** URL-safe id, also the folder name under src/games/. */
  id: string;
  title: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  /** Lazy import so the hub page never bundles every game upfront. */
  load: () => Promise<GameModule>;
}
