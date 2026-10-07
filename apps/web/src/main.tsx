import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { instalarManejadorPreloadError } from "./lib/carga-perezosa.tsx";
import "./index.css";

instalarManejadorPreloadError();

const container = document.getElementById("root");
if (!container) throw new Error("No se encontró #root en index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
