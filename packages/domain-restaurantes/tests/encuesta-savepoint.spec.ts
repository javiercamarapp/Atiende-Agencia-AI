// REGLA DURA de compatibilidad con la base SIN migrar (migracion 061, encuesta post-entrega): el repositorio Postgres corre dentro de la
// transaccion UNICA del request. Con una sesion que reproduce el estado ABORTADO de Postgres (25P02) cada lectura degrada a "no disponible" y
// deja la MISMA sesion utilizable (ROLLBACK TO SAVEPOINT); la escritura explicita de la configuracion no finge exito.
import { describe, expect, it } from "vitest";
import { EncuestaNoDisponibleError, EncuestaValidationError, PostgresEncuestaRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-000000000a01";
const PROP = "00000000-0000-0000-0000-000000000b01";
const ORDER = "00000000-0000-0000-0000-000000000c01";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const fallo = (code: string): FakeSessionHandler["respond"] => () => {
  throw pgError(code, "base sin migrar");
};

async function sesionViva(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe.each([["42883"], ["42P01"], ["42703"]])("PostgresEncuestaRepository contra la base sin migrar (SQLSTATE %s)", (code) => {
  it("leerConfig: disponible=false con la configuracion por defecto (apagada) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /encuesta_config_leer/, respond: fallo(code) }, SIGUIENTE]);
    const r = await new PostgresEncuestaRepository(session).leerConfig(ORG, PROP);
    expect(r).toEqual({ disponible: false, valor: { activa: false, esperaMin: 30, resenasUrl: null, umbralResena: 4 } });
    await sesionViva(session);
  });

  it("resumen: disponible=false con un resumen vacio (promedio null) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /encuesta_resumen/, respond: fallo(code) }, SIGUIENTE]);
    const r = await new PostgresEncuestaRepository(session).resumen(ORG, "2026-03-01", "2026-03-10", null);
    expect(r.disponible).toBe(false);
    expect(r.valor.global).toMatchObject({ enviadas: 0, respondidas: 0, promedio: null });
    await sesionViva(session);
  });

  it("candidatas: disponible=false y lista vacia (el barrido no hace nada)", async () => {
    const session = new AbortAwareFakeSession([{ match: /encuesta_candidatas/, respond: fallo(code) }, SIGUIENTE]);
    expect(await new PostgresEncuestaRepository(session).candidatas(null, null, 50)).toEqual({ disponible: false, valor: [] });
    await sesionViva(session);
  });

  it("publica y responder: disponible=false (la pagina publica responde 'no disponible', nunca un 500)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /encuesta_publica/, respond: fallo(code) },
      { match: /encuesta_responder/, respond: fallo(code) },
      SIGUIENTE,
    ]);
    const repo = new PostgresEncuestaRepository(session);
    expect(await repo.publica(ORG, ORDER)).toEqual({ disponible: false, valor: null });
    expect(await repo.responder(ORG, ORDER, 5, null)).toEqual({ disponible: false, valor: null });
    await sesionViva(session);
  });

  it("guardarConfig: lanza EncuestaNoDisponibleError (una escritura explicita no finge exito) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /encuesta_config_guardar/, respond: fallo(code) }, SIGUIENTE]);
    await expect(new PostgresEncuestaRepository(session).guardarConfig(ORG, PROP, { activa: true, esperaMin: 30, resenasUrl: null, umbralResena: 4 })).rejects.toBeInstanceOf(EncuestaNoDisponibleError);
    await sesionViva(session);
  });
});

describe("PostgresEncuestaRepository contra la base migrada", () => {
  it("mapea el resumen jsonb a numeros (los bigint llegan como texto) y conserva los NULL", async () => {
    const jsonb = {
      global: { enviadas: "4", respondidas: 3, promedio: "3.67", distribucion: [0, "1", 0, 1, 1] },
      por_sucursal: [{ property_id: PROP, nombre: "Centro", enviadas: 4, respondidas: 3, promedio: 3.67 }],
      por_repartidor: [{ repartidor_id: "r1", nombre: "Repartidor Uno", enviadas: 3, respondidas: 0, promedio: null }],
      recientes: [{ id: "e1", pedido: "1042", property_id: PROP, sucursal: "Centro", calificacion: "2", comentario: "Frio", respondida_at: "2026-03-10T19:30:00.000Z", repartidor: null }],
    };
    const session = new AbortAwareFakeSession([{ match: /encuesta_resumen/, respond: () => [{ r: jsonb }] }]);
    const { disponible, valor } = await new PostgresEncuestaRepository(session).resumen(ORG, "2026-03-10", "2026-03-10", null);
    expect(disponible).toBe(true);
    expect(valor.global).toEqual({ enviadas: 4, respondidas: 3, promedio: 3.67, distribucion: [0, 1, 0, 1, 1] });
    expect(valor.porRepartidor[0]).toMatchObject({ respondidas: 0, promedio: null });
    expect(valor.recientes[0]).toMatchObject({ pedido: 1042, calificacion: 2, repartidor: null });
  });

  it("acepta el jsonb como texto (otros drivers)", async () => {
    const session = new AbortAwareFakeSession([{ match: /encuesta_config_leer/, respond: () => [{ r: JSON.stringify({ activa: true, espera_min: 45, resenas_url: "https://g.page/r/x", umbral_resena: 5 }) }] }]);
    expect((await new PostgresEncuestaRepository(session).leerConfig(ORG, PROP)).valor).toEqual({ activa: true, esperaMin: 45, resenasUrl: "https://g.page/r/x", umbralResena: 5 });
  });

  it("candidatas: mapea cada fila y pasa el ahora como ISO", async () => {
    const fila = { order_id: ORDER, organization_id: ORG, property_id: PROP, org_slug: "los-taquitos", sucursal: "Centro", customer_name: "Ana", customer_phone: "5511112222" };
    const session = new AbortAwareFakeSession([{ match: /encuesta_candidatas/, respond: () => [{ r: [fila] }] }]);
    const r = await new PostgresEncuestaRepository(session).candidatas(ORG, new Date("2026-03-10T19:00:00Z"), 10);
    expect(r.valor).toEqual([{ orderId: ORDER, organizationId: ORG, propertyId: PROP, orgSlug: "los-taquitos", sucursal: "Centro", customerName: "Ana", customerPhone: "5511112222" }]);
  });

  it("registrarEnvio: true la primera vez, false si ya existia", async () => {
    const respuestas = [true, false];
    const session = new AbortAwareFakeSession([{ match: /encuesta_registrar_envio/, respond: () => [{ r: respuestas.shift() }] }]);
    const repo = new PostgresEncuestaRepository(session);
    expect(await repo.registrarEnvio(ORG, ORDER)).toBe(true);
    expect(await repo.registrarEnvio(ORG, ORDER)).toBe(false);
  });

  it("un error que NO es de base sin migrar (42501) no se traga", async () => {
    const session = new AbortAwareFakeSession([{ match: /encuesta_resumen/, respond: fallo("42501") }, SIGUIENTE]);
    await expect(new PostgresEncuestaRepository(session).resumen(ORG, "2026-03-01", "2026-03-10", null)).rejects.toMatchObject({ code: "42501" });
    await sesionViva(session);
  });

  it("guardarConfig: un 22023 de la base se traduce a EncuestaValidationError", async () => {
    const session = new AbortAwareFakeSession([{ match: /encuesta_config_guardar/, respond: fallo("22023") }, SIGUIENTE]);
    await expect(new PostgresEncuestaRepository(session).guardarConfig(ORG, PROP, { activa: true, esperaMin: 30, resenasUrl: null, umbralResena: 4 })).rejects.toBeInstanceOf(EncuestaValidationError);
  });
});
