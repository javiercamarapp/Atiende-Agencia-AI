// Contrato de vercel.json::crons: cada path existe como ruta real de la API (GET) y rechaza sin secreto,
// los schedules son validos y respetan el piso de 1 minuto, no hay duplicados, el total cabe en el tope
// de 40 crons por proyecto (plan Pro) y cada cron esta en SWITCHABLE_CRONS (kill switch) y viceversa.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SWITCHABLE_CRONS } from "../src/platform-switches.ts";
import { minutosEsperadosDeCron } from "../src/salud/cadencia.ts";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = path.resolve(here, "..", "src");
const vercel = JSON.parse(readFileSync(path.resolve(here, "..", "..", "..", "vercel.json"), "utf8")) as {
  crons: Array<{ path: string; schedule: string }>;
};
const MAX_CRONS_PRO = 40;
// Crons anteriores a este contrato que NO tienen interruptor por path (solo el global `crons`, que
// withHeartbeat aplica a todos). Un cron nuevo NO debe agregarse aqui: va en SWITCHABLE_CRONS.
const SIN_INTERRUPTOR_POR_PATH = [
  "/internal/hoteles/identidad-purga",
  "/internal/superadmin/alertas-cfo",
  "/internal/superadmin/mantenimiento",
  "/internal/superadmin/resumen-diario",
];

function fuentesApi(dir: string): string[] {
  return readdirSync(dir).flatMap((n: string) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? fuentesApi(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("vercel.json::crons -- contrato", () => {
  const crons = vercel.crons;

  it("no hay paths duplicados y el total cabe en el tope de 40 crons del plan Pro", () => {
    const paths = crons.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(crons.length).toBeLessThanOrEqual(MAX_CRONS_PRO);
  });

  it("todo path vive bajo /internal/, sin query string ni parametros", () => {
    for (const c of crons) expect(c.path, c.path).toMatch(/^\/internal\/[a-z0-9-]+(\/[a-z0-9-]+)+$/u);
  });

  it("todo schedule es de 5 campos con minuto/hora soportados por la cadencia (> 0) y nunca mas frecuente que cada minuto", () => {
    for (const c of crons) {
      expect(c.schedule.trim().split(/\s+/).length, c.path).toBe(5);
      expect(minutosEsperadosDeCron(c.schedule), `${c.path} ${c.schedule}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("cada path esta registrado como ruta GET literal en el codigo de la API", () => {
    const codigo = fuentesApi(apiSrc).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const c of crons) expect(codigo.includes(`"${c.path}"`), c.path).toBe(true);
  });

  it("cada cron esta en SWITCHABLE_CRONS (salvo la lista cerrada de 4 anteriores) y SWITCHABLE_CRONS no tiene entradas fuera de vercel.json", () => {
    const paths = new Set(crons.map((c) => c.path));
    for (const c of crons) expect(SWITCHABLE_CRONS.includes(c.path) || SIN_INTERRUPTOR_POR_PATH.includes(c.path), c.path).toBe(true);
    for (const e of SIN_INTERRUPTOR_POR_PATH) expect(SWITCHABLE_CRONS.includes(e), `${e} ya es detenible: quitalo de la lista`).toBe(false);
    for (const s of SWITCHABLE_CRONS) expect(paths.has(s), s).toBe(true);
    expect(new Set(SWITCHABLE_CRONS).size).toBe(SWITCHABLE_CRONS.length);
  });

  it("cada cron rechaza con 401 un GET sin secreto y con secreto incorrecto (nunca ejecuta nada)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    for (const c of crons) {
      expect((await app.request(c.path, { method: "GET" })).status, `${c.path} sin secreto`).toBe(401);
      expect((await app.request(c.path, { method: "GET", headers: { authorization: "Bearer incorrecto" } })).status, `${c.path} secreto malo`).toBe(401);
    }
  });
});
