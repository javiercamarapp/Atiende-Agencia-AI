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

// Rediseno ds3: interruptor del login (rutas previas a la organizacion). VITE_DISENO_LOGIN = lista de verticales separadas por
// coma ("restaurantes,citas") o "*"; vacio (lo normal) = el login conserva el diseno actual. Se inyecta como <meta> ANTES de
// /theme-boot.js para que el script lo lea antes del primer pintado. Solo letras, coma y "*": cualquier otro caracter se descarta.
export function interruptorLogin(valor: string | undefined): Plugin {
  const lista = (valor ?? "").replace(/[^a-z,*]/g, "");
  return {
    name: "interruptor-diseno-login",
    transformIndexHtml: (html) => html.replace('<script src="/theme-boot.js"></script>', `<meta name="atiende-diseno-login" content="${lista}" />\n    <script src="/theme-boot.js"></script>`),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), manifiestoFueraDeDist(), interruptorLogin(process.env.VITE_DISENO_LOGIN ?? loadEnv(mode, aqui, "VITE_").VITE_DISENO_LOGIN)],
  server: { port: 5173 },
  build: { manifest: true },
}));
