import "./style.css";
import { initRouter } from "./router";
import { setupPwa } from "./pwa";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("#app root element missing from index.html");
}

initRouter(app);
setupPwa();
