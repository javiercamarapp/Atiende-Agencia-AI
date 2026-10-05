// Empaqueta el worker en UN archivo (dist/main.mjs), igual que la funcion de Vercel (scripts/build-vercel-function.mjs en la raiz): los paquetes del
// workspace (@atiende/*) y las dependencias de npm se incluyen, EXCEPTO los dos SDK de LiveKit, que traen un binario nativo (rtc-node) y se instalan en
// la imagen junto al bundle (ver Dockerfile). Uso (desde la raiz del repo): `npm run bundle -w @atiende/voice-worker`.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(raiz, "dist"), { recursive: true });

await build({
  entryPoints: [join(raiz, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(raiz, "dist/main.mjs"),
  external: ["@livekit/rtc-node", "livekit-server-sdk"],
  logLevel: "info",
  // Las dependencias CommonJS (pg, etc.) usan `require` para built-ins de Node: se inyecta un `require` real (mismo arreglo que la funcion de Vercel).
  banner: { js: "import { createRequire as __atiendeCreateRequire } from 'node:module'; const require = __atiendeCreateRequire(import.meta.url);" },
});

// Manifiesto de lo que queda FUERA del bundle, con las versiones EXACTAS que resolvio el lockfile del repo: la imagen instala solo eso (reproducible).
const externos = ["@livekit/rtc-node", "livekit-server-sdk"];
const dependencies = {};
for (const nombre of externos) {
  const ruta = [join(raiz, "node_modules", nombre, "package.json"), join(raiz, "../../node_modules", nombre, "package.json")].find((r) => {
    try {
      readFileSync(r);
      return true;
    } catch {
      return false;
    }
  });
  if (!ruta) throw new Error(`No se encontro ${nombre} en node_modules: corre npm ci antes de empaquetar.`);
  dependencies[nombre] = JSON.parse(readFileSync(ruta, "utf8")).version;
}
writeFileSync(join(raiz, "dist/package.json"), `${JSON.stringify({ name: "atiende-voice-worker-runtime", private: true, type: "module", dependencies }, null, 2)}\n`);
