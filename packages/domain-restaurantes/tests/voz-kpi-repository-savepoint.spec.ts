// REGLA DURA de compatibilidad con la base SIN migrar (migracion 035, KPI de voz): el repositorio corre dentro de la
// transaccion unica del request. `AbortAwareFakeSession` reproduce el estado abortado de Postgres (25P02): cada caso
// verifica (1) el vacio honesto / VozNoDisponibleError y (2) que la MISMA sesion sigue utilizable despues.
import { describe, expect, it } from "vitest";
import { PostgresVozKpiRepository, VOZ_UMBRALES_POR_DEFECTO, VozNoDisponibleError, VozRechazadaError } from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000e1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const sinFuncion = (f: string) => pgError("42883", `function restaurantes.${f} does not exist`);
const sinTabla = (t: string) => pgError("42P01", `relation "restaurantes.${t}" does not exist`);

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("lecturas contra la base sin migrar: vacio honesto, nunca error", () => {
  it("getKpisDiarios: lista vacia con disponible=false y sesion viva (42883, 42P01 y 42703)", async () => {
    for (const err of [sinFuncion("voz_kpis_diarios"), sinTabla("voice_event"), pgError("42703", 'column "resultado" does not exist')]) {
      const s = new AbortAwareFakeSession([{ match: /voz_kpis_diarios/i, respond: () => err }, SIGUIENTE]);
      expect(await new PostgresVozKpiRepository(s).getKpisDiarios(ORG, PROP, "2026-03-01", "2026-03-10")).toEqual({ disponible: false, valor: [] });
      await sesionSigueViva(s);
    }
  });

  it("getUmbrales: umbrales por defecto (todo apagado) con disponible=false y sesion viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.voice_alert_config/i, respond: () => sinTabla("voice_alert_config") }, SIGUIENTE]);
    expect(await new PostgresVozKpiRepository(s).getUmbrales(PROP)).toEqual({ disponible: false, valor: VOZ_UMBRALES_POR_DEFECTO });
    await sesionSigueViva(s);
  });

  it("evaluarAlertas y listAlertas: vacio con disponible=false y sesion viva", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /voz_evaluar_alertas/i, respond: () => sinFuncion("voz_evaluar_alertas") }, SIGUIENTE]);
    expect(await new PostgresVozKpiRepository(s1).evaluarAlertas(ORG, PROP)).toEqual({ disponible: false, valor: [] });
    await sesionSigueViva(s1);
    const s2 = new AbortAwareFakeSession([{ match: /from restaurantes\.voice_alert\b/i, respond: () => sinTabla("voice_alert") }, SIGUIENTE]);
    expect(await new PostgresVozKpiRepository(s2).listAlertas(ORG, PROP, 20)).toEqual({ disponible: false, valor: [] });
    await sesionSigueViva(s2);
  });

  it("un error real que NO es de compatibilidad se repropaga (tras dejar la sesion viva)", async () => {
    const s = new AbortAwareFakeSession([{ match: /voz_kpis_diarios/i, respond: () => pgError("57P01", "connection terminated") }, SIGUIENTE]);
    await expect(new PostgresVozKpiRepository(s).getKpisDiarios(ORG, PROP, "2026-03-01", "2026-03-10")).rejects.toMatchObject({ code: "57P01" });
    await sesionSigueViva(s);
  });
});

describe("escritura de umbrales", () => {
  const entrada = { umbralCostoDiaCentavosMxn: 5000, umbralTasaErrorPct: 30, minLlamadasTasaError: 5 };

  it("base sin migrar: VozNoDisponibleError (503) y sesion viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /insert into restaurantes\.voice_alert_config/i, respond: () => sinTabla("voice_alert_config") }, SIGUIENTE]);
    await expect(new PostgresVozKpiRepository(s).upsertUmbrales(ORG, PROP, USER, entrada)).rejects.toBeInstanceOf(VozNoDisponibleError);
    await sesionSigueViva(s);
  });

  it("RLS niega (42501): VozRechazadaError y sesion viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /insert into restaurantes\.voice_alert_config/i, respond: () => pgError("42501", "new row violates row-level security policy") }, SIGUIENTE]);
    await expect(new PostgresVozKpiRepository(s).upsertUmbrales(ORG, PROP, USER, entrada)).rejects.toBeInstanceOf(VozRechazadaError);
    await sesionSigueViva(s);
  });

  it("camino feliz: mapea la fila y no usa el fallback", async () => {
    const s = new AbortAwareFakeSession([{ match: /insert into restaurantes\.voice_alert_config/i, respond: () => [{ umbral_costo_dia_centavos_mxn: "5000", umbral_tasa_error_pct: 30, min_llamadas_tasa_error: 5 }] }]);
    expect(await new PostgresVozKpiRepository(s).upsertUmbrales(ORG, PROP, USER, entrada)).toEqual({ configurado: true, ...entrada });
  });
});

describe("camino feliz de lectura", () => {
  it("mapea bigint como string a numero entero y null a null", async () => {
    const fila = {
      fecha: "2026-03-10", zona_horaria: "America/Mexico_City", llamadas: 4, llamadas_cerradas: 3, duracion_total_s: "1290", pedidos_voz: 1, escaladas: 1, abandonadas: 1,
      errores_proveedor: 4, errores_twilio: 1, errores_otros: 1, tool_calls: 20, tool_p95_ms: 950,
      costo_voz_micro_usd: "1500000", costo_telefonia_micro_usd: "500000", costo_total_centavos_mxn: "4000", costo_llm_org_micro_usd: null, costo_llm_org_centavos_mxn: null,
    };
    const s = new AbortAwareFakeSession([{ match: /voz_kpis_diarios/i, respond: () => [fila] }]);
    const r = await new PostgresVozKpiRepository(s).getKpisDiarios(ORG, PROP, "2026-03-10", "2026-03-10");
    expect(r.disponible).toBe(true);
    expect(r.valor[0]).toMatchObject({ fecha: "2026-03-10", duracionTotalS: 1290, costoVozMicroUsd: 1_500_000, costoTotalCentavosMxn: 4000, costoLlmOrgCentavosMxn: null, toolP95Ms: 950 });
  });
});
