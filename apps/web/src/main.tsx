import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CapaArranque, IdiomaProvider, ThemeBoot, cargarIdioma, leerDisenoDs3, leerIdioma } from "@atiende/ui";
import { App } from "./App.tsx";
import { instalarManejadorPreloadError } from "./lib/carga-perezosa.tsx";
import "./index.css";

instalarManejadorPreloadError();

const container = document.getElementById("root");
// i18n-ignorar: error de arranque para quien despliega, no texto de la consola.
if (!container) throw new Error("No se encontró #root en index.html");

const montar = () =>
  createRoot(container).render(
    <StrictMode>
      <ThemeBoot />
      {/* ds3: suelta la capa de arranque (#arranque) cuando la pantalla esta lista; sin la bandera no hace nada. */}
      <CapaArranque />
      {/* i18n ES/EN (solo con ds3; sin la bandera todo sigue en espanol): idioma de la consola y <html lang>. */}
      <IdiomaProvider>
        <App />
      </IdiomaProvider>
    </StrictMode>,
  );

// i18n: quien ya eligio ingles (solo con ds3) no ve un primer pintado en espanol que luego cambia: se espera el catalogo EN
// (un chunk chico) antes de montar, con tope de 300 ms; si tarda mas, se monta en espanol y cambia al llegar.
if (leerDisenoDs3() && leerIdioma() === "en") {
  void Promise.race([cargarIdioma("en").catch(() => undefined), new Promise((r) => setTimeout(r, 300))]).finally(montar);
} else {
  montar();
}
