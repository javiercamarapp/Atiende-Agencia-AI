// Alerta `superadmin.salud.cron_sin_latido`: el cron diario de resumen avisa en la campana del superadmin cuando algun cron de alta
// frecuencia (<= 15 min) no tiene NINGUN latido. Best-effort: nunca lanza ni tumba el cron; sin lectura posible no emite nada.
import { describe, expect, it } from "vitest";
import { InMemoryResumenDiarioRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { alertarCronsSinLatidoBestEffort } from "../src/salud/alerta-crons-sin-latido.ts";
import { cadenciaMinutosPorRuta, rutasDeCronDeclaradas } from "../src/salud/cadencia.ts";
import { contarCronsAltaFrecuenciaSinLatido } from "../src/salud/health.ts";
import { buildTestDeps } from "./fixtures.ts";

const AHORA = new Date("2026-10-05T15:00:00Z");
const ALTA_FRECUENCIA = rutasDeCronDeclaradas().filter((r) => (cadenciaMinutosPorRuta()[r] ?? 0) <= 15);
const latido = (cronName: string) => ({ cronName, lastStartedAt: AHORA.toISOString(), lastFinishedAt: AHORA.toISOString(), lastStatus: "ok" as const, lastError: null, lastDurationMs: 1, consecutiveFailures: 0 });

interface Emision { sql: string; params: unknown[] }

async function armar(opciones: { filas?: ReturnType<typeof latido>[]; migracionPendiente?: boolean; emisionLanza?: boolean; resultadoEmision?: number | null } = {}) {
  const base = await buildTestDeps();
  const repo = new InMemoryResumenDiarioRepository();
  repo.seedCronHeartbeats(opciones.filas ?? []);
  if (opciones.migracionPendiente) repo.setMigracionPendiente(true);
  const emisiones: Emision[] = [];
  const engine = {
    withAppSession: async (_c: unknown, fn: (s: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          if (/core\.emit_notification/.test(sql)) {
            emisiones.push({ sql, params });
            if (opciones.emisionLanza) throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
            return { rows: [{ emit_notification: opciones.resultadoEmision === undefined ? 1 : opciones.resultadoEmision }] };
          }
          return { rows: [] };
        },
        exec: async () => undefined,
      }),
  };
  const deps = { ...base.deps, engine, resumenDiarioRepo: repo } as unknown as AppDeps;
  return { deps, emisiones };
}

describe("alertarCronsSinLatidoBestEffort", () => {
  it("sin ningun latido: emite UNA vez el evento de superadmin con la cantidad (solo un numero, sin nombres) y clave de dedupe por dia", async () => {
    const { deps, emisiones } = await armar();
    const r = await alertarCronsSinLatidoBestEffort(deps, AHORA);
    expect(r).toEqual({ estado: "emitida", cantidad: ALTA_FRECUENCIA.length });
    expect(emisiones).toHaveLength(1);
    const p = emisiones[0]!.params;
    expect(p[0]).toBeNull(); // organizacion: null (evento de superadmin)
    expect(p[2]).toBe("superadmin.salud.cron_sin_latido");
    expect(p[4]).toBe("critica");
    expect(p[6]).toBe(`Crons de alta frecuencia sin ningún latido: ${ALTA_FRECUENCIA.length}. Revisa Salud operativa y la configuración de crons en Vercel.`);
    expect(p[7]).toBe("/superadmin/salud");
    expect(p[10]).toBe("superadmin.salud.cron_sin_latido:2026-10-05");
    expect(JSON.stringify(p)).not.toMatch(/\/internal\//);
  });

  it("con latido de todos los crons de alta frecuencia no emite nada; los diarios sin latido no cuentan", async () => {
    const { deps, emisiones } = await armar({ filas: ALTA_FRECUENCIA.map(latido) });
    expect(await alertarCronsSinLatidoBestEffort(deps, AHORA)).toEqual({ estado: "sin_problema" });
    expect(emisiones).toHaveLength(0);
  });

  it("falta uno solo de alta frecuencia: emite con cantidad 1", async () => {
    const { deps, emisiones } = await armar({ filas: ALTA_FRECUENCIA.slice(1).map(latido) });
    expect(await alertarCronsSinLatidoBestEffort(deps, AHORA)).toEqual({ estado: "emitida", cantidad: 1 });
    expect(emisiones).toHaveLength(1);
  });

  it("ya avisado hoy (la base responde 0 filas nuevas por el dedupe): sigue contando como emitida y no lanza", async () => {
    const { deps } = await armar({ resultadoEmision: 0 });
    expect((await alertarCronsSinLatidoBestEffort(deps, AHORA)).estado).toBe("emitida");
  });

  it("base sin migrar (42883 al leer latidos): no_medido, no emite nada y no lanza", async () => {
    const { deps, emisiones } = await armar({ migracionPendiente: true });
    expect(await alertarCronsSinLatidoBestEffort(deps, AHORA)).toEqual({ estado: "no_medido" });
    expect(emisiones).toHaveLength(0);
  });

  it("la emision falla (base sin la funcion de notificaciones): no_emitida, nunca lanza", async () => {
    const { deps } = await armar({ emisionLanza: true });
    expect(await alertarCronsSinLatidoBestEffort(deps, AHORA)).toEqual({ estado: "no_emitida", cantidad: ALTA_FRECUENCIA.length });
  });

  it("contarCronsAltaFrecuenciaSinLatido ignora latidos de crons que ya no existen en vercel.json y filas sin fecha de fin", () => {
    expect(contarCronsAltaFrecuenciaSinLatido([latido("/internal/ya/no/existe"), { ...latido(ALTA_FRECUENCIA[0]!), lastFinishedAt: null }])).toBe(ALTA_FRECUENCIA.length);
  });
});

describe("GET /internal/superadmin/resumen-diario -- alerta de crons sin latido", () => {
  it("el cron de resumen dispara la alerta cuando no hay latidos, y una emision rota NO tumba el cron (200)", async () => {
    const { deps, emisiones } = await armar({ emisionLanza: true });
    const app = buildApp(deps);
    const res = await app.request("/internal/superadmin/resumen-diario", { method: "GET", headers: { authorization: `Bearer ${deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    expect(emisiones.length).toBeGreaterThanOrEqual(1);
    expect(emisiones[0]!.params[2]).toBe("superadmin.salud.cron_sin_latido");
  });
});
