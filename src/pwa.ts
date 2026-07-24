import { registerSW } from "virtual:pwa-register";

/** Registers the service worker and silently keeps it up to date.
 * `virtual:pwa-register` is provided by vite-plugin-pwa only in build/preview;
 * it's a no-op during `vite dev` since devOptions.enabled is false. */
export function setupPwa() {
  registerSW({ immediate: true });
}
