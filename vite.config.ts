import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages project site is served from https://<user>.github.io/ASGmod/
// Update BASE_PATH if the repo is ever renamed or moved to a custom domain (use "/" then).
const BASE_PATH = "/ASGmod/";

export default defineConfig({
  base: BASE_PATH,
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
