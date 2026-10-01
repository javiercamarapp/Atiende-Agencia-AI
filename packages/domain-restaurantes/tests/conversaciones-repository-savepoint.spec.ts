// REGLA DURA de compatibilidad con la base SIN migrar (migracion 027): el repositorio corre dentro de la
// transaccion unica del request. `AbortAwareFakeSession` reproduce el estado abortado de Postgres (25P02):
// cada caso verifica (1) el vacio honesto / error 503-409-403 correcto y (2) que la MISMA sesion sigue viva.
import { describe, expect, it } from "vitest";
import {
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  HandoffYaTomadoError,
  PostgresConversacionesRepository,
  PostgresHandoffAgentGate,
  SinNumeroWhatsappError,
} from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const ID = "00000000-0000-4000-8000-0000000000c1";
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

describe("lecturas contra la base sin migrar: vacio honesto (disponible=false), nunca error", () => {
  it("listarBandeja", async () => {
    const s = new AbortAwareFakeSession([{ match: /bandeja_conversaciones/i, respond: () => sinFuncion("bandeja_conversaciones") }, SIGUIENTE]);
    expect(await new PostgresConversacionesRepository(s).listarBandeja(ORG, PROP, {})).toEqual({ disponible: false, valor: { items: [], total: 0 } });
    await sesionSigueViva(s);
  });

  it("detalle (la primera consulta ya falla por tabla inexistente)", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_conversations/i, respond: () => sinTabla("whatsapp_conversations") }, SIGUIENTE]);
    expect(await new PostgresConversacionesRepository(s).detalle(ORG, PROP, "whatsapp", ID)).toEqual({ disponible: false, valor: null });
    await sesionSigueViva(s);
  });

  it("listarTurnos y listarCallbacks", async () => {
    const s = new AbortAwareFakeSession([
      { match: /turnos_sucursal/i, respond: () => sinFuncion("turnos_sucursal") },
      { match: /callbacks_sucursal/i, respond: () => sinFuncion("callbacks_sucursal") },
      SIGUIENTE,
    ]);
    const repo = new PostgresConversacionesRepository(s);
    expect(await repo.listarTurnos(ORG, PROP)).toEqual({ disponible: false, valor: [] });
    // la MISMA sesion sigue viva para la lectura siguiente del request (no 25P02)
    expect(await repo.listarCallbacks(ORG, PROP, false)).toEqual({ disponible: false, valor: [] });
    await sesionSigueViva(s);
  });

  it("un error real que NO es de compatibilidad se repropaga (tras dejar la sesion viva)", async () => {
    const s = new AbortAwareFakeSession([{ match: /bandeja_conversaciones/i, respond: () => pgError("57P01", "connection terminated") }, SIGUIENTE]);
    await expect(new PostgresConversacionesRepository(s).listarBandeja(ORG, PROP, {})).rejects.toMatchObject({ code: "57P01" });
    await sesionSigueViva(s);
  });

  it("42501 en una lectura es un rechazo de acceso (403), no un vacio", async () => {
    const s = new AbortAwareFakeSession([{ match: /bandeja_conversaciones/i, respond: () => pgError("42501", "sin acceso") }, SIGUIENTE]);
    await expect(new PostgresConversacionesRepository(s).listarBandeja(ORG, PROP, {})).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await sesionSigueViva(s);
  });
});

describe("escrituras contra la base sin migrar: ConversacionesNoDisponibleError (503) y sesion viva", () => {
  const casos: Array<[string, RegExp, Error, (r: PostgresConversacionesRepository) => Promise<unknown>]> = [
    ["tomar", /handoff_tomar/i, sinFuncion("handoff_tomar"), (r) => r.tomar(ORG, PROP, "whatsapp", ID)],
    ["devolver", /handoff_devolver/i, sinFuncion("handoff_devolver"), (r) => r.devolver(ORG, PROP, ID)],
    ["cerrar", /handoff_cerrar/i, sinFuncion("handoff_cerrar"), (r) => r.cerrar(ORG, PROP, ID)],
    ["agregarNota", /handoff_agregar_nota/i, sinFuncion("handoff_agregar_nota"), (r) => r.agregarNota(ORG, PROP, ID, "hola")],
    ["responderWhatsapp", /handoff_responder_whatsapp/i, sinFuncion("handoff_responder_whatsapp"), (r) => r.responderWhatsapp(ORG, PROP, ID, "hola")],
    ["registrarIntentoCallback", /callback_registrar_intento/i, sinFuncion("callback_registrar_intento"), (r) => r.registrarIntentoCallback(ORG, ID, { resultado: "buzon", nota: null, proximoIntentoAt: null })],
    ["reemplazarTurnos", /delete from restaurantes\.branch_shift/i, sinTabla("branch_shift"), (r) => r.reemplazarTurnos(ORG, PROP, [])],
  ];
  for (const [nombre, match, err, ejecutar] of casos) {
    it(nombre, async () => {
      const s = new AbortAwareFakeSession([{ match, respond: () => err }, SIGUIENTE]);
      await expect(ejecutar(new PostgresConversacionesRepository(s))).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
      await sesionSigueViva(s);
    });
  }

  it("55006 -> HandoffYaTomadoError (409); P0002 -> SinNumeroWhatsappError; 42501 -> ConversacionesRechazadaError (403)", async () => {
    const mk = (code: string) => new AbortAwareFakeSession([{ match: /handoff_tomar|handoff_responder_whatsapp/i, respond: () => pgError(code, "x") }, SIGUIENTE]);
    let s = mk("55006");
    await expect(new PostgresConversacionesRepository(s).tomar(ORG, PROP, "whatsapp", ID)).rejects.toBeInstanceOf(HandoffYaTomadoError);
    await sesionSigueViva(s);
    s = mk("P0002");
    await expect(new PostgresConversacionesRepository(s).responderWhatsapp(ORG, PROP, ID, "hola")).rejects.toBeInstanceOf(SinNumeroWhatsappError);
    await sesionSigueViva(s);
    s = mk("42501");
    await expect(new PostgresConversacionesRepository(s).tomar(ORG, PROP, "whatsapp", ID)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await sesionSigueViva(s);
  });

  it("un fallo a mitad de reemplazarTurnos (FK 23503) revierte al savepoint y deja la sesion viva", async () => {
    const s = new AbortAwareFakeSession([
      { match: /delete from restaurantes\.branch_shift/i, respond: () => [] },
      { match: /insert into restaurantes\.branch_shift \(/i, respond: () => [{ id: ID }] },
      { match: /insert into restaurantes\.branch_shift_member/i, respond: () => pgError("23503", "fk") },
      SIGUIENTE,
    ]);
    await expect(
      new PostgresConversacionesRepository(s).reemplazarTurnos(ORG, PROP, [{ nombre: "T1", dias: [1], inicia: "12:00", termina: "18:00", miembros: [{ userId: ID, orden: 1 }] }]),
    ).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await sesionSigueViva(s);
  });
});

describe("gate del agente de WhatsApp contra la base sin migrar: el agente sigue respondiendo como antes", () => {
  it("estadoParaAgente -> null y la sesion sigue viva (el turno del agente continua en la misma transaccion)", async () => {
    const s = new AbortAwareFakeSession([{ match: /handoff_whatsapp_estado/i, respond: () => sinFuncion("handoff_whatsapp_estado") }, SIGUIENTE]);
    expect(await new PostgresHandoffAgentGate(s).estadoParaAgente(ORG, "+5219991234567")).toBeNull();
    await sesionSigueViva(s);
  });

  it("solicitarHumano -> null sin romper la transaccion", async () => {
    const s = new AbortAwareFakeSession([{ match: /handoff_solicitar_whatsapp/i, respond: () => sinFuncion("handoff_solicitar_whatsapp") }, SIGUIENTE]);
    expect(await new PostgresHandoffAgentGate(s).solicitarHumano({ organizationId: ORG, propertyId: PROP, phone: "+521", motivo: "queja" })).toBeNull();
    await sesionSigueViva(s);
  });

  it("con la base migrada devuelve el estado y el id", async () => {
    const s = new AbortAwareFakeSession([
      { match: /handoff_whatsapp_estado/i, respond: () => [{ estado: "tomada" }] },
      { match: /handoff_solicitar_whatsapp/i, respond: () => [{ id: ID }] },
    ]);
    const gate = new PostgresHandoffAgentGate(s);
    expect(await gate.estadoParaAgente(ORG, "+521")).toBe("tomada");
    expect(await gate.solicitarHumano({ organizationId: ORG, propertyId: null, phone: "+521", motivo: "queja" })).toBe(ID);
  });
});
