// REGLA DURA de compatibilidad con la base SIN migrar (migracion 029, config del agente de WhatsApp): la
// lectura corre dentro de la transaccion unica del turno de WhatsApp. Un 42P01/42703/42501/42883 sin
// SAVEPOINT la dejaria abortada (25P02) y el COMMIT seria un ROLLBACK silencioso. `AbortAwareFakeSession`
// reproduce ese estado; cada caso verifica el camino anterior (agente generico) y que la MISMA sesion sigue viva.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { FALLBACK_CONFIG, resolveAgentConfig } from "../src/whatsapp/llm-turn-handler.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

const LEER = /from restaurantes\.whatsapp_agent_config/i;
const ESCRIBIR = /insert into restaurantes\.whatsapp_agent_config/i;

describe("whatsapp_agent_config sobre Postgres", () => {
  it("lee la fila y la traduce al perfil (valor desconocido -> generico, tono desconocido -> null)", async () => {
    const session = new AbortAwareFakeSession([
      { match: LEER, respond: () => [{ property_id: null, perfil: "taqueria_pm", agent_name: "Lupita", business_name: null, tone_style: "formal_directo", delivery_time_text: "de 40 a 50 minutos" }] },
    ]);
    expect(await new PostgresRestaurantesRepository(session).findWhatsAppAgentConfig(ORG_ID, PROPERTY_ID)).toEqual({
      propertyId: null,
      perfil: "taqueria_pm",
      agentName: "Lupita",
      businessName: null,
      toneStyle: "formal_directo",
      deliveryTimeText: "de 40 a 50 minutos",
    });
    const futuro = new AbortAwareFakeSession([{ match: LEER, respond: () => [{ property_id: null, perfil: "perfil_del_futuro", agent_name: null, business_name: null, tone_style: "raro", delivery_time_text: null }] }]);
    expect(await new PostgresRestaurantesRepository(futuro).findWhatsAppAgentConfig(ORG_ID, null)).toMatchObject({ perfil: "generico", toneStyle: null });
  });

  it("sin fila: null y el agente generico", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER, respond: () => [] }]);
    expect(await resolveAgentConfig(new PostgresRestaurantesRepository(session), ORG_ID, PROPERTY_ID)).toBe(FALLBACK_CONFIG);
  });

  for (const [codigo, nombre] of [
    ["42P01", "tabla inexistente"],
    ["42703", "columna inexistente"],
    ["42883", "funcion inexistente"],
    ["42501", "GRANT nuevo sin aplicar"],
  ] as const) {
    it(`base SIN migrar (${codigo}, ${nombre}): cae al agente generico y la sesion sigue viva`, async () => {
      const session = new AbortAwareFakeSession([{ match: LEER, respond: () => pgError(codigo, "no existe") }, SIGUIENTE]);
      expect(await resolveAgentConfig(new PostgresRestaurantesRepository(session), ORG_ID, PROPERTY_ID)).toBe(FALLBACK_CONFIG);
      await sesionSigueViva(session);
    });
  }

  it("un error real de Postgres (no de compatibilidad) se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: LEER, respond: () => pgError("57P01", "connection terminated") }]);
    await expect(new PostgresRestaurantesRepository(session).findWhatsAppAgentConfig(ORG_ID, null)).rejects.toMatchObject({ code: "57P01" });
  });

  it("base SIN migrar: la escritura lanza RestaurantesConfigUnavailableError (503 honesto) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: ESCRIBIR, respond: () => pgError("42P01", "no existe") }, SIGUIENTE]);
    await expect(
      new PostgresRestaurantesRepository(session).upsertWhatsAppAgentConfig(ORG_ID, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null }),
    ).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("el upsert de organizacion y el de sucursal usan el predicado de indice parcial correcto", async () => {
    const sqls: string[] = [];
    const fila = { property_id: null, perfil: "taqueria_pm", agent_name: null, business_name: null, tone_style: null, delivery_time_text: null };
    const session = new AbortAwareFakeSession([{ match: ESCRIBIR, respond: () => [fila] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      sqls.push(sql);
      return original(sql, p);
    }) as typeof session.query;
    const repo = new PostgresRestaurantesRepository(session);
    const cfg = { perfil: "taqueria_pm" as const, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null };
    await repo.upsertWhatsAppAgentConfig(ORG_ID, null, cfg);
    await repo.upsertWhatsAppAgentConfig(ORG_ID, PROPERTY_ID, cfg);
    expect(sqls.filter((s) => /on conflict \(organization_id\) where property_id is null/.test(s))).toHaveLength(1);
    expect(sqls.filter((s) => /on conflict \(organization_id, property_id\) where property_id is not null/.test(s))).toHaveLength(1);
  });
});
