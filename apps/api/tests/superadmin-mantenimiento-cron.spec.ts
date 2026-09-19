// Cron `/internal/superadmin/mantenimiento` -- hallazgo de auditoría a1
// (BAJA, rubro C): `desatascarOutboxColgadosForSystem`/
// `marcarProspectosSinMovimientoForSystem` son dos funciones SQL nuevas de
// `packages/db/migrations/0016_superadmin_acciones.sql`, sin guard -- en la
// base real SIN esa migración aplicada, este cron respondía 500 todos los
// días. Mismo criterio honesto que el cron de resumen diario (hallazgo B,
// ver `resumen-diario-cron-y-rutas.spec.ts`): captura 42883, responde 200
// { ok:false, motivo:'migracion_pendiente' }, nunca lanza -- el heartbeat
// debe seguir 'ok' porque no es un fallo real del cron.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemorySaludRepository, InMemorySuperadminAccionesRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

const CRON_PATH = "/internal/superadmin/mantenimiento";

describe("POST/GET /internal/superadmin/mantenimiento", () => {
  it("sin el secreto interno -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request(CRON_PATH, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("camino feliz -- 200 { ok:true } con el catálogo de outbox y prospectos marcados", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outbox: unknown[]; prospectosMarcados: number };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.outbox)).toBe(true);
    expect(body.prospectosMarcados).toBe(0);
  });

  it("migración 0016 sin aplicar (SQLSTATE 42883) -- 200 honesto { ok:false, motivo:'migracion_pendiente' }, nunca un 500", async () => {
    const base = await buildTestDeps();
    (base.deps.accionesRepo as InMemorySuperadminAccionesRepository).setMigracionPendiente(true);
    const app = buildApp(base.deps);

    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; motivo?: string };
    expect(body.ok).toBe(false);
    expect(body.motivo).toBe("migracion_pendiente");
  });

  it("el heartbeat del cron sigue 'ok' con la migración pendiente -- withHeartbeat solo distingue 'lanzó' de 'resolvió'", async () => {
    const base = await buildTestDeps();
    (base.deps.accionesRepo as InMemorySuperadminAccionesRepository).setMigracionPendiente(true);
    const app = buildApp(base.deps);

    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);

    const saludRepo = base.deps.saludRepo as InMemorySaludRepository;
    const superadminId = randomUUID();
    saludRepo.addPlatformSuperadmin(superadminId);
    const heartbeats = await saludRepo.listCronHeartbeatsForSuperadmin(superadminId);
    const latido = heartbeats.find((h) => h.cronName === CRON_PATH);
    expect(latido?.lastStatus).toBe("ok");
  });

  it("migración 0016 sin aplicar -- deja un warn en logs (hallazgo no-bloqueante #4: antes quedaba mudo, sin señal en /superadmin/salud ni en logs)", async () => {
    const base = await buildTestDeps();
    (base.deps.accionesRepo as InMemorySuperadminAccionesRepository).setMigracionPendiente(true);
    const app = buildApp(base.deps);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
      expect(res.status).toBe(200);
      const lineas = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(lineas.some((linea) => linea.includes("superadmin_mantenimiento_migracion_pendiente"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("un código de error que NO es 42883 se repropaga tal cual -- el cron responde 500 real, nunca se confunde con 'migración pendiente'", async () => {
    const base = await buildTestDeps();
    const accionesRepo = base.deps.accionesRepo as InMemorySuperadminAccionesRepository;
    // Simula un fallo REAL (no "función no existe") sobreescribiendo el
    // método directamente -- el repo en memoria no tiene un `setFallando`
    // genérico para este caso, a diferencia de `InMemoryResumenDiarioRepository`.
    accionesRepo.desatascarOutboxColgadosForSystem = async () => {
      throw new Error("conexión perdida con Postgres");
    };
    const app = buildApp(base.deps);

    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(500);
  });
});
