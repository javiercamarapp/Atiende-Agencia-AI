import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { inicializarTemaV2 } from "@atiende/ui";
import { App } from "./App.tsx";
import "./index.css";

// Bandera visual de Atiende DS v2: solo con ?ds=v2 (o recordada); sin ella no
// cambia nada. Se retira cuando las verticales estén migradas (PR-12).
inicializarTemaV2();

const container = document.getElementById("root");
if (!container) throw new Error("No se encontró #root en index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
