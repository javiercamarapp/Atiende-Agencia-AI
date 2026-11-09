// Adaptador del CFO de la plataforma (0085): base sin migrar con una sesion que reproduce el estado
// ABORTADO real de una transaccion, errores de negocio tipados, mapeo de filas y semantica en memoria.
import { describe, expect, it } from "vitest";
import { InMemoryCfoCockpitRepository, PostgresCfoCockpitRepository, PostgresCfoRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresCfoCockpitRepository -- base sin migrar", () => {
  it("todas las lecturas y escrituras devuelven not_migrated y la sesion sigue viva (no 25P02)", async () => {
    const falta = () => pgError("42883", "function core.get_cfo_uso_for_superadmin(uuid, date, date) does not exist");
    const session = new AbortAwareFakeSession([
      { match: /list_cfo_supuestos_for_superadmin/, respond: falta },
      { match: /list_cfo_supuestos_for_system/, respond: falta },
      { match: /superadmin_set_cfo_supuesto/, respond: falta },
      { match: /list_cfo_capturas_for_superadmin/, respond: falta },
      { match: /superadmin_set_cfo_captura/, respond: falta },
      { match: /get_cfo_uso_for_superadmin/, respond: falta },
      { match: /get_cfo_uso_for_system/, respond: falta },
      { match: /list_billing_snapshots_for_superadmin/, respond: () => [] },
    ]);
    const repo = new PostgresCfoCockpitRepository(session);
    await expect(repo.listSupuestos("u1")).resolves.toEqual({ availability: "not_migrated", supuestos: [] });
    await expect(repo.listSupuestosForSystem()).resolves.toEqual({ availability: "not_migrated", supuestos: [] });
    await expect(repo.setSupuesto("u1", "umbral_margen_pct", "*", 30, "dueño", null)).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.listCapturas("u1", "2026-01-01", "2026-03-01")).resolves.toEqual({ availability: "not_migrated", capturas: [] });
    await expect(repo.setCaptura("u1", "2026-03-01", "gasto_fijo", "Nomina", 1, null)).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.getUso("u1", "2026-01-01", "2026-03-01")).resolves.toEqual({ availability: "not_migrated", uso: [] });
    await expect(repo.getUsoForSystem("2026-01-01", "2026-03-01")).resolves.toEqual({ availability: "not_migrated", uso: [] });
    // Misma transaccion: el CFO (0030) se sigue leyendo despues de los 7 fallos.
    await expect(new PostgresCfoRepository(session).listSnapshots("u1", "2026-01-01", "2026-03-01")).resolves.toMatchObject({ availability: "available" });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(7);
  });

  it("42P01 tambien degrada; un 42883 de operador NO se enmascara", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /get_cfo_uso/, respond: () => pgError("42P01", 'relation "core.cfo_supuesto" does not exist') }]);
    await expect(new PostgresCfoCockpitRepository(s1).getUso("u1", "2026-03-01", "2026-03-01")).resolves.toMatchObject({ availability: "not_migrated" });
    const s2 = new AbortAwareFakeSession([{ match: /get_cfo_uso/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresCfoCockpitRepository(s2).getUso("u1", "2026-03-01", "2026-03-01")).rejects.toThrow(/operator does not exist/);
  });
});

describe("PostgresCfoCockpitRepository -- errores y mapeo", () => {
  it("42501 -> forbidden, 22023 -> invalid", async () => {
    const f = new AbortAwareFakeSession([{ match: /superadmin_set_cfo_captura/, respond: () => pgError("42501", "rol finanzas") }]);
    await expect(new PostgresCfoCockpitRepository(f).setCaptura("u1", "2026-03-01", "gasto_fijo", "Renta", 1, null)).rejects.toMatchObject({ name: "SuperadminSeguridadError", code: "forbidden" });
    const i = new AbortAwareFakeSession([{ match: /superadmin_set_cfo_supuesto/, respond: () => pgError("22023", "clave desconocida") }]);
    await expect(new PostgresCfoCockpitRepository(i).setSupuesto("u1", "umbral_margen_pct", "*", 1, "x x", null)).rejects.toMatchObject({ code: "invalid" });
  });

  it("mapea bigint/numeric en texto, segundos por proveedor y NULL honestos", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /get_cfo_uso_for_superadmin/,
        respond: () => [
          {
            organization_id: "o1",
            mes: "2026-03-01",
            vertical: "restaurantes",
            llm_micro_usd: "1500",
            eventos_micro_usd: "90000",
            llamadas: 3,
            segundos_voz: "210",
            segundos_por_proveedor: { "elevenlabs-agents": "180", "gpt-live-1": 30 },
            pedidos: 2,
            pedidos_voz: 1,
            pedidos_whatsapp: 1,
            conversaciones_wa: null,
            minutos_facturables: null,
            plan: { id: "p1", modelo_cobro: "medido" },
          },
        ],
      },
      { match: /list_cfo_supuestos_for_superadmin/, respond: () => [{ clave: "voz_usd_minuto", proveedor: "elevenlabs-agents", valor: "0.045000", fuente: "medido", nota: null, updated_at: "2026-11-07T00:00:00Z" }] },
    ]);
    const repo = new PostgresCfoCockpitRepository(session);
    const uso = await repo.getUso("u1", "2026-03-01", "2026-03-01");
    expect(uso.uso[0]).toEqual({
      organizationId: "o1",
      mes: "2026-03-01",
      vertical: "restaurantes",
      llmMicroUsd: 1500,
      eventosMicroUsd: 90000,
      llamadas: 3,
      segundosVoz: 210,
      segundosPorProveedor: { "elevenlabs-agents": 180, "gpt-live-1": 30 },
      pedidos: 2,
      pedidosVoz: 1,
      pedidosWhatsapp: 1,
      conversacionesWa: null,
      minutosFacturables: null,
      plan: { id: "p1", modelo_cobro: "medido" },
    });
    await expect(repo.listSupuestos("u1")).resolves.toEqual({
      availability: "available",
      supuestos: [{ clave: "voz_usd_minuto", proveedor: "elevenlabs-agents", valor: 0.045, fuente: "medido", nota: null, updatedAt: "2026-11-07T00:00:00.000Z" }],
    });
  });
});

describe("InMemoryCfoCockpitRepository", () => {
  const NOW = Date.parse("2026-11-07T12:00:00Z");
  it("superadmin escribe y lee; finanzas solo lee; otro no ve nada", async () => {
    const repo = new InMemoryCfoCockpitRepository({ now: () => NOW });
    repo.seedSuperadmin("sa");
    repo.seedSuperadmin("fin", "finanzas");
    await repo.setCaptura("sa", "2026-11-15", "gasto_fijo", "Nomina", 100, null);
    await expect(repo.listCapturas("fin", "2026-11-01", "2026-11-01")).resolves.toMatchObject({ capturas: [{ mes: "2026-11-01", concepto: "Nomina" }] });
    await expect(repo.listCapturas("otro", "2026-11-01", "2026-11-01")).resolves.toEqual({ availability: "available", capturas: [] });
    await expect(repo.setCaptura("fin", "2026-11-01", "gasto_fijo", "Renta", 1, null)).rejects.toMatchObject({ code: "forbidden" });
    await expect(repo.setSupuesto("otro", "umbral_margen_pct", "*", 1, "fuente", null)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("gasto futuro rechazado, presupuesto futuro aceptado; NULL borra y deja bitacora", async () => {
    const repo = new InMemoryCfoCockpitRepository({ now: () => NOW });
    repo.seedSuperadmin("sa");
    await expect(repo.setCaptura("sa", "2026-12-01", "marketing", "Meta", 1, null)).rejects.toMatchObject({ code: "invalid" });
    await repo.setCaptura("sa", "2027-01-01", "presupuesto_ingreso", "Meta MRR", 1000, null);
    await repo.setSupuesto("sa", "voz_usd_minuto", "elevenlabs-agents", 0.05, "factura oct", null);
    await repo.setSupuesto("sa", "voz_usd_minuto", "elevenlabs-agents", null, "x", null);
    await expect(repo.setSupuesto("sa", "umbral_margen_pct", "elevenlabs-agents", 1, "xxx", null)).rejects.toMatchObject({ code: "invalid" });
    expect(repo.bitacora.map((b) => b.evento)).toEqual(["captura_set", "supuesto_set", "supuesto_borrado"]);
  });
});
