import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Which build this is, baked in so a game record can say what produced it.
 *
 * This exists because diagnosing a real game turned into guesswork: an engine
 * bug reported from a phone could not be reproduced here, and the possibilities
 * — a stale service worker serving an old build, a slower device running out of
 * search time, an actual defect — all looked identical from the record alone.
 * A commit and a build time in the export settle the first two immediately.
 */
function buildVersion(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}+수정됨` : sha;
  } catch {
    return "unknown";
  }
}

// GitHub Pages project site is served from https://<user>.github.io/ASGmod/
// Update BASE_PATH if the repo is ever renamed or moved to a custom domain (use "/" then).
const BASE_PATH = "/ASGmod/";

export default defineConfig({
  base: BASE_PATH,
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/*.png"],
      manifest: {
        id: BASE_PATH,
        name: "추상 전략 게임 모음",
        short_name: "ASGmod",
        description: "브라우저에서 바로 즐기는 간단한 추상 전략 게임 모음",
        lang: "ko",
        start_url: BASE_PATH,
        scope: BASE_PATH,
        display: "standalone",
        background_color: "#111318",
        theme_color: "#111318",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
