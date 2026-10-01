// REGLA DURA de compatibilidad con la base SIN migrar (migracion 033, R-10): la lectura del agente corre dentro de la
// transaccion unica del turno de WhatsApp y el guardado dentro de la del request. `AbortAwareFakeSession` reproduce el
// estado abortado (25P02) de Postgres: cada caso verifica el camino anterior (029 / agente generico) y que la MISMA sesion
// sigue viva despues del error (ROLLBACK TO SAVEPOINT), nunca un 500 ni un COMMIT que devuelve ROLLBACK.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { WhatsAppAgentConfigConflictError } from "../src/errors.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { FALLBACK_CONFIG, resolveAgentConfig } from "../src/whatsapp/llm-turn-handler.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
const ACTOR_ID = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message = "no existe"): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

const V2 = { property_id: null, perfil: "taqueria_pm", agent_name: "Lupe", business_name: null, tone_style: null, delivery_time_text: null, greeting_text: "Hola", salsas_text: null, promos_text: null, escalation_reasons_off: ["pedido_grande", "queja"], version: 3 };
const LEGACY = { property_id: null, perfil: "taqueria_pm", agent_name: "Lupita", business_name: null, tone_style: null, delivery_time_text: null };

const LEER_V2 = /select property_id, perfil[\s\S]*greeting_text[\s\S]*from restaurantes\.whatsapp_agent_config\s+where organization_id = \$1 and enabled/i;
const LEER_029 = /select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text\s+from restaurantes\.whatsapp_agent_config\s+where organization_id = \$1 and enabled/i;
const EXACTA_V2 = /greeting_text[\s\S]*from restaurantes\.whatsapp_agent_config\s+where organization_id = \$1 and property_id is not distinct from/i;
const UPSERT_V2 = /insert into restaurantes\.whatsapp_agent_config as c/i;
const UPSERT_029 = /insert into restaurantes\.whatsapp_agent_config \(/i;
const HISTORIAL_INSERT = /insert into restaurantes\.whatsapp_agent_config_history/i;
const HISTORIAL_LEER = /from restaurantes\.whatsapp_agent_config_history h/i;

const CONFIG = { perfil: "taqueria_pm", agentName: "Lupe", businessName: null, toneStyle: null, deliveryTimeText: null, greetingText: "Hola", salsasText: null, promosText: null, escalationReasonsOff: [] } as const;
const CONFIG_029 = { perfil: "taqueria_pm", agentName: "Lupe", businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const META = { accion: "actualizado", actorUserId: ACTOR_ID, versionEsperada: 2 } as const;

describe("lectura (findWhatsAppAgentConfig)", () => {
  it("con la 033: trae los campos nuevos y la version; un motivo no desactivable guardado a mano se descarta", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER_V2, respond: () => [V2] }]);
    expect(await new PostgresRestaurantesRepository(session).findWhatsAppAgentConfig(ORG_ID, PROPERTY_ID)).toMatchObject({
      greetingText: "Hola",
      escalationReasonsOff: ["pedido_grande"],
      version: 3,
    });
  });

  it("sin la 033 (42703): cae al SELECT de 029 con SAVEPOINT, devuelve la config de siempre y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER_V2, respond: () => pgError("42703", "column greeting_text does not exist") }, { match: LEER_029, respond: () => [LEGACY] }, SIGUIENTE]);
    const fila = await new PostgresRestaurantesRepository(session).findWhatsAppAgentConfig(ORG_ID, PROPERTY_ID);
    expect(fila).toEqual({ propertyId: null, perfil: "taqueria_pm", agentName: "Lupita", businessName: null, toneStyle: null, deliveryTimeText: null });
    await sesionSigueViva(session);
  });

  it("sin la tabla (42P01 en ambos SELECT): agente generico y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER_V2, respond: () => pgError("42P01") }, { match: LEER_029, respond: () => pgError("42P01") }, SIGUIENTE]);
    expect(await resolveAgentConfig(new PostgresRestaurantesRepository(session), ORG_ID, PROPERTY_ID)).toBe(FALLBACK_CONFIG);
    await sesionSigueViva(session);
  });

  it("un error real (no de compatibilidad) se repropaga", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER_V2, respond: () => pgError("57P01", "connection terminated") }]);
    await expect(new PostgresRestaurantesRepository(session).findWhatsAppAgentConfig(ORG_ID, null)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("guardado (guardarWhatsAppAgentConfig)", () => {
  it("con la 033: upsert versionado + una entrada de historial con la version nueva, el actor y las fotos anterior/nueva", async () => {
    const params: Record<string, unknown[]> = {};
    const session = new AbortAwareFakeSession([
      { match: EXACTA_V2, respond: () => [{ ...V2, version: 2, agent_name: "Lupita", greeting_text: null }] },
      { match: UPSERT_V2, respond: () => [V2] },
      { match: HISTORIAL_INSERT, respond: () => [] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (/insert into restaurantes\.whatsapp_agent_config(_history)?\b/i.test(sql)) params[/_history/.test(sql) ? "historial" : "upsert"] = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    const guardada = await new PostgresRestaurantesRepository(session).guardarWhatsAppAgentConfig(ORG_ID, null, CONFIG, META);
    expect(guardada).toMatchObject({ version: 3, greetingText: "Hola" });
    expect(params.upsert!.at(-1)).toBe(2); // version esperada
    const h = params.historial!;
    expect(h.slice(0, 4)).toEqual([ORG_ID, null, 3, "actualizado"]);
    expect(JSON.parse(h[4] as string)).toMatchObject({ agentName: "Lupita", greetingText: null });
    expect(JSON.parse(h[5] as string)).toMatchObject({ agentName: "Lupe", greetingText: "Hola" });
    expect(h[6]).toBe(ACTOR_ID);
  });

  it("version vieja (el upsert no devuelve fila): WhatsAppAgentConfigConflictError, sin historial y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: EXACTA_V2, respond: () => [V2] }, { match: UPSERT_V2, respond: () => [] }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).guardarWhatsAppAgentConfig(ORG_ID, null, CONFIG, META)).rejects.toBeInstanceOf(WhatsAppAgentConfigConflictError);
    expect(session.calls.some((c) => /insert into restaurantes\.whatsapp_agent_config_history/i.test(c))).toBe(false);
    await sesionSigueViva(session);
  });

  it("dos guardados con la misma version (23505 en el historial): conflicto, no 500, y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: EXACTA_V2, respond: () => [V2] }, { match: UPSERT_V2, respond: () => [V2] }, { match: HISTORIAL_INSERT, respond: () => pgError("23505", "duplicate key") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).guardarWhatsAppAgentConfig(ORG_ID, null, CONFIG, META)).rejects.toBeInstanceOf(WhatsAppAgentConfigConflictError);
    await sesionSigueViva(session);
  });

  it("sin la 033 y SIN campos nuevos: guarda con el upsert de 029 (flujo que hoy funciona) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: EXACTA_V2, respond: () => pgError("42703") },
      { match: UPSERT_029, respond: () => [LEGACY] },
      SIGUIENTE,
    ]);
    const guardada = await new PostgresRestaurantesRepository(session).guardarWhatsAppAgentConfig(ORG_ID, null, CONFIG_029, META);
    expect(guardada).toMatchObject({ perfil: "taqueria_pm", agentName: "Lupita" });
    expect(guardada.version).toBeUndefined();
    await sesionSigueViva(session);
  });

  it("sin la 033 y CON campos nuevos: RestaurantesConfigUnavailableError (503 honesto) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: EXACTA_V2, respond: () => pgError("42P01") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).guardarWhatsAppAgentConfig(ORG_ID, null, CONFIG, META)).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("un error real durante el guardado se repropaga (no se disfraza de compatibilidad)", async () => {
    const session = new AbortAwareFakeSession([{ match: EXACTA_V2, respond: () => [V2] }, { match: UPSERT_V2, respond: () => pgError("57P01", "connection terminated") }]);
    await expect(new PostgresRestaurantesRepository(session).guardarWhatsAppAgentConfig(ORG_ID, null, CONFIG, META)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("historial (listWhatsAppAgentConfigHistorial)", () => {
  it("devuelve las entradas mas recientes primero con el nombre del actor", async () => {
    const session = new AbortAwareFakeSession([
      { match: HISTORIAL_LEER, respond: () => [{ version: 2, accion: "restablecido", property_id: null, anterior: { agentName: "A" }, nuevo: { agentName: null }, actor_id: ACTOR_ID, actor_nombre: "Owner", created_at: new Date("2026-10-01T00:00:00Z") }] },
    ]);
    expect(await new PostgresRestaurantesRepository(session).listWhatsAppAgentConfigHistorial(ORG_ID, null, 20)).toEqual([
      { version: 2, accion: "restablecido", propertyId: null, anterior: { agentName: "A" }, nuevo: { agentName: null }, actorUserId: ACTOR_ID, actorNombre: "Owner", creadoAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("sin la tabla de historial (42P01): lista vacia y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: HISTORIAL_LEER, respond: () => pgError("42P01") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listWhatsAppAgentConfigHistorial(ORG_ID, PROPERTY_ID, 20)).toEqual([]);
    await sesionSigueViva(session);
  });
});
