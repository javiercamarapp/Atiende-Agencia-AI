// El cron del resumen diario manda por los canales de alertas las alertas CRITICAS de salud
// (best-effort, opcional). Doble del despachador: nunca hay envio real.
import { describe, expect, it, vi } from "vitest";
import { InMemoryResumenDiarioRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";
import type { DespachadorAlertas } from "../src/alertas/tipos.ts";
import type { AlertaSaliente } from "../src/alertas/tipos.ts";

const CRON_PATH = "/internal/superadmin/resumen-diario";

describe("resumen diario -> alertas salientes", () => {
  it("notifica cada alerta critica de salud (tipo salud:<titulo>) y la respuesta del cron no cambia", async () => {
    const base = await buildTestDeps();
    const notificar = vi.fn(async (_a: AlertaSaliente) => ({ resultados: [] }));
    const deps = { ...base.deps, alertas: { notificar } satisfies DespachadorAlertas };
    // Un cron cuyo ultimo latido termino en error -> alerta CRITICA de salud (ver salud/motor.ts).
    const iso = new Date().toISOString();
    (deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).seedCronHeartbeats([
      { cronName: "/internal/hoteles/night-audit", lastStartedAt: iso, lastFinishedAt: iso, lastStatus: "error", lastError: "fallo cliente@correo.com", lastDurationMs: 1, consecutiveFailures: 1 },
    ]);
    const res = await buildApp(deps).request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fecha: string; alertas: number };
    expect(body.ok).toBe(true);

    const fila = await (deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).getDailyOpsSummaryForSystem(body.fecha);
    const agregados = fila!.agregados as { salud: { alertas: { severidad: string; titulo: string }[] } };
    const criticas = agregados.salud.alertas.filter((a) => a.severidad === "critica");
    expect(criticas.length).toBeGreaterThanOrEqual(1);
    expect(notificar).toHaveBeenCalledTimes(criticas.length);
    for (const [llamada, a] of notificar.mock.calls.map((c, i) => [c[0], criticas[i]!] as const)) {
      expect(llamada).toMatchObject({ tipo: `salud:${a.titulo}`, severidad: "critica", titulo: a.titulo });
    }
  });

  it("si el despachador lanza, el cron responde igual (el aviso es best-effort)", async () => {
    const base = await buildTestDeps();
    const notificar = vi.fn().mockRejectedValue(new Error("canal roto"));
    const deps = { ...base.deps, alertas: { notificar } };
    const res = await buildApp(deps).request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(res.status).toBe(200);
  });

  it("sin despachador configurado el cron funciona como siempre", async () => {
    const base = await buildTestDeps();
    const res = await buildApp(base.deps).request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);
  });
});
