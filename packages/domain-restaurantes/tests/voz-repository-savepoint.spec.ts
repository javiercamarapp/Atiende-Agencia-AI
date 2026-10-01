// REGLA DURA de compatibilidad con la base SIN migrar (migracion 025, voz): el repositorio corre
// dentro de la transaccion unica del request. `AbortAwareFakeSession` reproduce el estado
// abortado de Postgres (25P02): cada caso verifica (1) el vacio honesto / VozNoDisponibleError y
// (2) que la MISMA sesion sigue utilizable despues (la siguiente query del request resuelve).
import { describe, expect, it } from "vitest";
import { PostgresVozRepository, VOZ_CONFIG_POR_DEFECTO, VozNoDisponibleError, VozRechazadaError } from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const sinTabla = (t: string) => pgError("42P01", `relation "restaurantes.${t}" does not exist`);
const sinFuncion = (f: string) => pgError("42883", `function restaurantes.${f} does not exist`);

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("lecturas contra la base sin migrar: vacio honesto, nunca error", () => {
  it("getConfig: disponible=false con la config por defecto (no 'configurada') y sesion viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_voice_config/i, respond: () => sinTabla("branch_voice_config") }, SIGUIENTE]);
    expect(await new PostgresVozRepository(s).getConfig(PROP)).toEqual({ disponible: false, valor: VOZ_CONFIG_POR_DEFECTO });
    expect(VOZ_CONFIG_POR_DEFECTO.configurada).toBe(false);
    await sesionSigueViva(s);
  });

  it("listConversaciones: lista vacia con disponible=false y sesion viva (42703 tambien)", async () => {
    for (const err of [sinTabla("voice_conversation"), pgError("42703", 'column "resultado" does not exist')]) {
      const s = new AbortAwareFakeSession([{ match: /from restaurantes\.voice_conversation/i, respond: () => err }, SIGUIENTE]);
      expect(await new PostgresVozRepository(s).listConversaciones(ORG, PROP, {})).toEqual({ disponible: false, valor: { items: [], total: 0 } });
      await sesionSigueViva(s);
    }
  });

  it("getConversacion: disponible=false y sesion viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.voice_conversation/i, respond: () => sinTabla("voice_conversation") }, SIGUIENTE]);
    expect(await new PostgresVozRepository(s).getConversacion(ORG, PROP, CONV)).toEqual({ disponible: false, valor: null });
    await sesionSigueViva(s);
  });

  it("un error real que NO es de compatibilidad se repropaga (tras dejar la sesion viva)", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_voice_config/i, respond: () => pgError("57P01", "connection terminated") }, SIGUIENTE]);
    await expect(new PostgresVozRepository(s).getConfig(PROP)).rejects.toMatchObject({ code: "57P01" });
    await sesionSigueViva(s);
  });
});

describe("escrituras contra la base sin migrar: VozNoDisponibleError (503) y sesion viva", () => {
  const casos: Array<[string, RegExp, Error, (r: PostgresVozRepository) => Promise<unknown>]> = [
    ["upsertConfig", /insert into restaurantes\.branch_voice_config/i, sinTabla("branch_voice_config"), (r) => r.upsertConfig(ORG, PROP, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "" })],
    ["crearPreviewSession", /insert into restaurantes\.voice_preview_sessions/i, sinTabla("voice_preview_sessions"), (r) => r.crearPreviewSession({ organizationId: ORG, propertyId: PROP, createdBy: ORG, proveedor: "gemini-3.8-live", voiceId: "Kore", ttlSegundos: 300 })],
    ["iniciarConversacion", /voz_iniciar_conversacion/i, sinFuncion("voz_iniciar_conversacion"), (r) => r.iniciarConversacion({ organizationId: ORG, propertyId: PROP, externalId: "x", canal: "llamada", proveedor: "gemini-3.8-live", voiceId: null, callerHash: null, startedAt: null })],
    ["registrarTurno", /voz_registrar_turno/i, sinFuncion("voz_registrar_turno"), (r) => r.registrarTurno({ organizationId: ORG, conversationId: CONV, seq: 0, rol: "cliente", texto: "hola", duracionMs: null, latenciaMs: null, costoMicroUsd: 0 })],
    ["cerrarConversacion", /voz_cerrar_conversacion/i, sinFuncion("voz_cerrar_conversacion"), (r) => r.cerrarConversacion({ organizationId: ORG, conversationId: CONV, resultado: "escalado", endedAt: null, orderId: null })],
    ["consumirPreview", /voz_consumir_preview/i, sinFuncion("voz_consumir_preview"), (r) => r.consumirPreview({ sessionId: CONV, organizationId: ORG, propertyId: PROP })],
  ];
  for (const [nombre, match, err, ejecutar] of casos) {
    it(nombre, async () => {
      const s = new AbortAwareFakeSession([{ match, respond: () => err }, SIGUIENTE]);
      await expect(ejecutar(new PostgresVozRepository(s))).rejects.toBeInstanceOf(VozNoDisponibleError);
      await sesionSigueViva(s);
    });
  }

  it("42501 / 23505 de las funciones (pertenencia, no-sistema, external_id ajeno) -> VozRechazadaError, sesion viva", async () => {
    for (const code of ["42501", "23505"]) {
      const s = new AbortAwareFakeSession([{ match: /voz_iniciar_conversacion/i, respond: () => pgError(code, "rechazado") }, SIGUIENTE]);
      await expect(new PostgresVozRepository(s).iniciarConversacion({ organizationId: ORG, propertyId: PROP, externalId: "x", canal: "llamada", proveedor: "gemini-3.8-live", voiceId: null, callerHash: null, startedAt: null })).rejects.toBeInstanceOf(VozRechazadaError);
      await sesionSigueViva(s);
    }
  });

  it("un error inesperado de escritura se repropaga, no se enmascara como 'no disponible'", async () => {
    const s = new AbortAwareFakeSession([{ match: /voz_registrar_turno/i, respond: () => pgError("23514", "check violation") }, SIGUIENTE]);
    await expect(new PostgresVozRepository(s).registrarTurno({ organizationId: ORG, conversationId: CONV, seq: 0, rol: "cliente", texto: "x", duracionMs: null, latenciaMs: null, costoMicroUsd: 0 })).rejects.toMatchObject({ code: "23514" });
  });
});

describe("camino migrado: mapeo y parametros", () => {
  it("getConfig lee la fila; sin fila devuelve el valor inicial con configurada=false", async () => {
    const con = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_voice_config/i, respond: () => [{ habilitado: true, proveedor: "gemini-3.8-live", voice_id: "Puck", comportamiento: "usted", mensaje_inicial: "hola" }] }]);
    expect(await new PostgresVozRepository(con).getConfig(PROP)).toEqual({ disponible: true, valor: { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Puck", comportamiento: "usted", mensajeInicial: "hola", configurada: true } });
    const sin = new AbortAwareFakeSession([{ match: /from restaurantes\.branch_voice_config/i, respond: () => [] }]);
    expect(await new PostgresVozRepository(sin).getConfig(PROP)).toEqual({ disponible: true, valor: VOZ_CONFIG_POR_DEFECTO });
  });

  it("listConversaciones pagina y mapea micro-USD (bigint llega como string)", async () => {
    let params: unknown[] | undefined;
    const s = new AbortAwareFakeSession([
      { match: /select count\(\*\)/i, respond: () => [{ total: 1 }] },
      { match: /select id, property_id/i, respond: () => [{ id: CONV, property_id: PROP, external_id: "sala-1", canal: "llamada", proveedor: "gemini-3.8-live", voice_id: "Kore", started_at: new Date("2026-09-30T12:00:00Z"), ended_at: null, duration_s: null, costo_estimado_micro_usd: "300", latencia_p95_ms: 900, resultado: "escalado", order_id: null }] },
    ]);
    const original = s.query.bind(s);
    s.query = (async (sql: string, p?: unknown[]) => {
      if (/select id, property_id/i.test(sql)) params = p;
      return original(sql, p);
    }) as typeof s.query;
    const r = await new PostgresVozRepository(s).listConversaciones(ORG, PROP, { resultado: "escalado", limit: 10, offset: 20 });
    expect(params).toEqual([ORG, PROP, "escalado", 10, 20]);
    expect(r.disponible).toBe(true);
    expect(r.valor.total).toBe(1);
    expect(r.valor.items[0]).toMatchObject({ id: CONV, costoEstimadoMicroUsd: 300, latenciaP95Ms: 900, resultado: "escalado", startedAt: "2026-09-30T12:00:00.000Z" });
  });

  it("getConversacion devuelve null si la conversacion no es de esa organizacion/sucursal", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.voice_conversation/i, respond: () => [] }]);
    expect(await new PostgresVozRepository(s).getConversacion(ORG, PROP, CONV)).toEqual({ disponible: true, valor: null });
  });

  it("registrarTurno / cerrarConversacion / consumirPreview devuelven el booleano de la funcion", async () => {
    const s = new AbortAwareFakeSession([
      { match: /voz_registrar_turno/i, respond: () => [{ insertado: false }] },
      { match: /voz_cerrar_conversacion/i, respond: () => [{ cerrada: true }] },
      { match: /voz_consumir_preview/i, respond: () => [{ consumida: true }] },
    ]);
    const r = new PostgresVozRepository(s);
    expect(await r.registrarTurno({ organizationId: ORG, conversationId: CONV, seq: 0, rol: "agente", texto: "x", duracionMs: null, latenciaMs: null, costoMicroUsd: 0 })).toBe(false);
    expect(await r.cerrarConversacion({ organizationId: ORG, conversationId: CONV, resultado: "pedido_creado", endedAt: null, orderId: null })).toBe(true);
    expect(await r.consumirPreview({ sessionId: CONV, organizationId: ORG, propertyId: PROP })).toBe(true);
  });
});
