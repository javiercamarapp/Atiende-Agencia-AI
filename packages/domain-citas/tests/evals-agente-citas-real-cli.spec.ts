// QA-citas-R1-agentes-17: el CLI del modo real arranca. Con `node --experimental-strip-types` fallaba con ERR_MODULE_NOT_FOUND (agent-core importa con
// `.js` y los archivos son `.ts`); con `vite-node` (como los demas CLIs del repo) llega hasta la validacion de argumentos.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const aqui = dirname(fileURLToPath(import.meta.url));
const paquete = resolve(aqui, "..");
const raiz = resolve(paquete, "../..");

describe("npm run evals:citas:real", () => {
  it("usa el mismo ejecutor que los demas CLIs del repo (vite-node)", () => {
    const pkg = JSON.parse(readFileSync(resolve(paquete, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["evals:citas:real"]).toMatch(/^vite-node /);
  });

  it("arranca y pide el tope de gasto en vez de reventar al resolver modulos", () => {
    const r = spawnSync(resolve(raiz, "node_modules/.bin/vite-node"), ["src/evals/agente-citas/real-cli.ts"], {
      cwd: paquete,
      env: { ...process.env, OPENROUTER_API_KEY: "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    const salida = `${r.stdout}${r.stderr}`;
    expect(salida).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(salida).toMatch(/Falta --max-usd/);
    expect(r.status).not.toBe(0);
  }, 90_000);
});
