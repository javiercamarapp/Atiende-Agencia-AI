import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";

const aqui = dirname(fileURLToPath(import.meta.url));

// R-37: el presupuesto de bundle (scripts/verify-bundle-budget) lee el manifiesto de Vite para calcular, por ruta, el JS
// que el navegador realmente descarga. Vite lo escribe en dist/.vite/manifest.json y `outputDirectory` (vercel.json) es
// dist, o sea que se publicaría como estático con el mapa de rutas fuente. Este plugin lo mueve a
// apps/web/bundle-manifest.json (gitignoreado) al cerrar el bundle, para que no quede dentro de lo que se sirve.
function manifiestoFueraDeDist(): Plugin {
  return {
    name: "manifiesto-fuera-de-dist",
    apply: "build",
    closeBundle: {
      order: "post",
      handler() {
        const origen = resolve(aqui, "dist/.vite/manifest.json");
        if (!existsSync(origen)) return;
        mkdirSync(aqui, { recursive: true });
        renameSync(origen, resolve(aqui, "bundle-manifest.json"));
        rmSync(resolve(aqui, "dist/.vite"), { recursive: true, force: true });
      },
    },
  };
}

// Diseno: el nuevo (ds3) es el de todos. Interruptor de emergencia de build (apagado por omision): VITE_DISENO_LEGADO=1 inyecta
// <meta name="atiende-diseno-legado"> ANTES de /theme-boot.js para que el script no ponga html[data-diseno="ds3"] desde el
// primer pintado; el mismo valor apaga DISENO_DS3 en el JS (@atiende/ui, lib/diseno.ts). Solo el valor exacto «1» cuenta.
export function interruptorDisenoLegado(valor: string | undefined): Plugin {
  const legado = (valor ?? "").trim() === "1";
  return {
    name: "interruptor-diseno-legado",
    transformIndexHtml: (html) =>
      legado ? html.replace('<script src="/theme-boot.js"></script>', '<meta name="atiende-diseno-legado" content="1" />\n    <script src="/theme-boot.js"></script>') : html,
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), manifiestoFueraDeDist(), interruptorDisenoLegado(process.env.VITE_DISENO_LEGADO ?? loadEnv(mode, aqui, "VITE_").VITE_DISENO_LEGADO)],
  server: { port: 5173 },
  build: { manifest: true },
}));
