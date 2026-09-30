import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerServiceWorker } from "./pwa/register";
import { watchConnection } from "./pwa/connection";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// After the first paint, so the worker never competes with it (M25.1).
window.addEventListener("load", () => { void registerServiceWorker(); }, { once: true });
watchConnection();
