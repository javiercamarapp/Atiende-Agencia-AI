import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CapaArranque, IdiomaProvider, ThemeBoot } from "@atiende/ui";
import { App } from "./App.tsx";
import { instalarManejadorPreloadError } from "./lib/carga-perezosa.tsx";
import "./index.css";

instalarManejadorPreloadError();

const container = document.getElementById("root");
// i18n-ignorar: error de arranque para quien despliega, no texto de la consola.
if (!container) throw new Error("No se encontró #root en index.html");

createRoot(container).render(
  <StrictMode>
    <ThemeBoot />
    {/* ds3: suelta la capa de arranque (#arranque) cuando la pantalla esta lista; sin la bandera no hace nada. */}
    <CapaArranque />
    {/* i18n ES/EN: idioma de la consola (?lang= -> preferencia guardada -> espanol); sincroniza <html lang>. */}
    <IdiomaProvider>
      <App />
    </IdiomaProvider>
  </StrictMode>,
);
