// rescate-orig-restaurantes-1 §2 (X37, T-HO10): el aviso al equipo es idempotente por mensaje y por motivo. Porta el caso del original
// `whatsapp-agent-core.test.ts:541` (el mismo id de Meta no crea dos avisos) y agrega el dedupe por motivo, la compatibilidad con la base
// SIN migrar (SAVEPOINT real, no un try/catch) y la ausencia de notificaciones duplicadas.
import { describe, expect, it } from "vitest";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { registerCallbackRequest } from "../src/callback-requests.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CB = "00000000-0000-4000-8000-0000000000e1";
const REGISTRAR = /restaurantes\.callback_registrar_agente/i;
const INSERT_CALLBACK = /insert into restaurantes\.callback_requests/i;
const EMITIR = /core\.emit_notification/i;
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("aviso al equipo en memoria: mismas reglas que la funcion SQL", () => {
  const base = { organizationId: "o1", customerName: "Marcela", customerPhone: "+5219991110001", source: "whatsapp" as const };

  it("Meta reenvia el mismo id 3 veces -> 1 aviso", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await registerCallbackRequest(repo, { ...base, reason: "escalada:queja", message: "m", sourceEventId: "wamid.1:escalada:queja" }));
    expect(r.map((x) => x.registro)).toEqual(["nuevo", "evento_repetido", "evento_repetido"]);
    expect(repo.listCallbackRequests("o1")).toHaveLength(1);
  });

  it("el cliente repite 'quiero hablar con una persona' 3 veces (3 ids) -> 1 aviso abierto con las notas de las otras 2", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const r = [];
    for (let i = 1; i <= 3; i++) r.push(await registerCallbackRequest(repo, { ...base, reason: "escalada:cliente_lo_pide", message: `intento ${i}`, sourceEventId: `wamid.${i}:escalada:cliente_lo_pide` }));
    expect(r.map((x) => x.registro)).toEqual(["nuevo", "nota_agregada", "nota_agregada"]);
    const [aviso, ...otros] = repo.listCallbackRequests("o1");
    expect(otros).toHaveLength(0);
    expect(aviso!.message).toContain("intento 1");
    expect(aviso!.message).toContain("intento 2");
    expect(aviso!.message).toContain("intento 3");
    // un reenvio del evento 2 (ya agregado como nota) no repite la nota
    const reenvio = await registerCallbackRequest(repo, { ...base, reason: "escalada:cliente_lo_pide", message: "intento 2", sourceEventId: "wamid.2:escalada:cliente_lo_pide" });
    expect(reenvio.registro).toBe("evento_repetido");
    expect(repo.listCallbackRequests("o1")[0]!.message!.match(/intento 2/g)).toHaveLength(1);
  });

  it("dos motivos distintos -> 2 avisos; otro canal u otro telefono -> aviso aparte", async () => {
    const repo = new InMemoryRestaurantesRepository();
    await registerCallbackRequest(repo, { ...base, reason: "escalada:queja", sourceEventId: "e1" });
    await registerCallbackRequest(repo, { ...base, reason: "escalada:alergia_salud", sourceEventId: "e2" });
    await registerCallbackRequest(repo, { ...base, source: "voice", reason: "escalada:queja", sourceEventId: "e3" });
    await registerCallbackRequest(repo, { ...base, customerPhone: "+5219992220002", reason: "escalada:queja", sourceEventId: "e4" });
    expect(repo.listCallbackRequests("o1")).toHaveLength(4);
  });

  it("sin id de evento (llamada sin id) el dedupe por motivo sigue agrupando; los avisos web/admin nunca se agrupan", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const a = await registerCallbackRequest(repo, { ...base, source: "voice", reason: "escalada:queja" });
    const b = await registerCallbackRequest(repo, { ...base, source: "voice", reason: "escalada:queja" });
    expect([a.registro, b.registro]).toEqual(["nuevo", "nota_agregada"]);
    await registerCallbackRequest(repo, { ...base, source: "web", reason: "contacto" });
    await registerCallbackRequest(repo, { ...base, source: "web", reason: "contacto" });
    expect(repo.listCallbackRequests("o1").filter((c) => c.source === "web")).toHaveLength(2);
  });

  it("otra organizacion con el mismo id de evento registra el suyo", async () => {
    const repo = new InMemoryRestaurantesRepository();
    await registerCallbackRequest(repo, { ...base, reason: "escalada:queja", sourceEventId: "e1" });
    const otra = await registerCallbackRequest(repo, { ...base, organizationId: "o2", reason: "escalada:queja", sourceEventId: "e1" });
    expect(otra.registro).toBe("nuevo");
  });
});

describe("escalar_a_humano arma el id de evento con el id del mensaje o de la llamada y el motivo", () => {
  it("WhatsApp: el mismo mensaje reprocesado (mismo id) no duplica; mensajes distintos con el mismo motivo se agrupan; otro motivo, otro aviso", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const ctx = (id: string) => ({ organizationId, channel: "whatsapp" as const, phone: "9991111111", sourceEventId: id });
    for (const id of ["wamid.A", "wamid.A", "wamid.B", "wamid.C"]) await invokeAgentTool(repo, ctx(id), "escalar_a_humano", { customer_name: "Ana", motivo: "cliente_lo_pide", resumen: "pide una persona" });
    await invokeAgentTool(repo, ctx("wamid.D"), "escalar_a_humano", { customer_name: "Ana", motivo: "queja", resumen: "llego frio" });
    const avisos = repo.listCallbackRequests(organizationId);
    expect(avisos.map((a) => a.reason)).toEqual(["escalada:cliente_lo_pide", "escalada:queja"]);
    expect(avisos[0]!.sourceEventId).toBe("wamid.A:escalada:cliente_lo_pide");
  });

  it("voz: la llamada es el evento (un aviso por llamada y motivo); sin id de evento sigue agrupando por motivo", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const ctx = { organizationId, channel: "voz" as const, phone: "9991111111", sourceEventId: "call:abc" };
    await invokeAgentTool(repo, ctx, "escalar_a_humano", { customer_name: "Ana", motivo: "queja", resumen: "a" });
    await invokeAgentTool(repo, ctx, "escalar_a_humano", { customer_name: "Ana", motivo: "queja", resumen: "a" });
    await invokeAgentTool(repo, { ...ctx, sourceEventId: null }, "escalar_a_humano", { customer_name: "Ana", motivo: "queja", resumen: "otra" });
    expect(repo.listCallbackRequests(organizationId)).toHaveLength(1);
  });
});

describe("Postgres: compatibilidad con la base SIN migrar (REGLA DURA, SAVEPOINT)", () => {
  const INPUT = { organizationId: ORG, propertyId: PROP, customerName: "Ana", customerPhone: "+525500000000", reason: "escalada:queja", message: "m", source: "whatsapp" as const, sourceEventId: "wamid.1:escalada:queja" };

  it("la funcion no existe (42883): cae al INSERT de siempre, la MISMA sesion sigue viva (sin 25P02) y el aviso queda registrado", async () => {
    const session = new AbortAwareFakeSession([
      { match: REGISTRAR, respond: () => pgError("42883", "function restaurantes.callback_registrar_agente does not exist") },
      { match: INSERT_CALLBACK, respond: () => [{ id: CB, resolved: false, created_at: "2026-10-01T10:00:00.000Z" }] },
      { match: EMITIR, respond: () => [{ emit_notification: 1 }] },
      SIGUIENTE,
    ]);
    const r = await new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT);
    expect(r).toMatchObject({ id: CB, registro: "nuevo" });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("un error de Postgres que NO es 42883 (p. ej. 42501 del rechazo real) se repropaga, no se esconde tras el INSERT", async () => {
    const session = new AbortAwareFakeSession([{ match: REGISTRAR, respond: () => pgError("42501", "callback_registrar_agente es solo de sistema") }, { match: INSERT_CALLBACK, respond: () => [{ id: CB, resolved: false, created_at: "x" }] }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT)).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("manda a la funcion el id de evento y el canal; un reenvio o una nota agregada NO vuelven a notificar, uno nuevo si", async () => {
    for (const [registro, notifica] of [["evento_repetido", 0], ["nota_agregada", 0], ["nuevo", 1]] as const) {
      const emisiones: unknown[][] = [];
      let params: unknown[] = [];
      const session = new AbortAwareFakeSession([
        { match: REGISTRAR, respond: () => [{ callback_id: CB, resuelto: false, creado_at: "2026-10-01T10:00:00.000Z", registro }] },
        { match: EMITIR, respond: () => [{ emit_notification: 1 }] },
      ]);
      const original = session.query.bind(session);
      session.query = (async (sql: string, p?: unknown[]) => {
        if (REGISTRAR.test(sql)) params = p ?? [];
        if (EMITIR.test(sql)) emisiones.push(p ?? []);
        return original(sql, p);
      }) as typeof session.query;
      const r = await new PostgresRestaurantesRepository(session).createCallbackRequest(INPUT);
      expect(r.registro).toBe(registro);
      expect(emisiones).toHaveLength(notifica);
      expect(params).toEqual([ORG, PROP, "Ana", "+525500000000", "escalada:queja", "m", "whatsapp", "wamid.1:escalada:queja"]);
    }
  });

  it("los avisos web y admin conservan el INSERT de siempre (no pasan por la funcion del agente)", async () => {
    const session = new AbortAwareFakeSession([
      { match: INSERT_CALLBACK, respond: () => [{ id: CB, resolved: false, created_at: "2026-10-01T10:00:00.000Z" }] },
      { match: EMITIR, respond: () => [{ emit_notification: 1 }] },
    ]);
    const r = await new PostgresRestaurantesRepository(session).createCallbackRequest({ ...INPUT, source: "web", sourceEventId: undefined });
    expect(r.id).toBe(CB);
    expect(session.calls.some((c) => REGISTRAR.test(c))).toBe(false);
  });
});
