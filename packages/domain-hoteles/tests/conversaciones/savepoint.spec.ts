// H-20 -- REGLA DURA de compatibilidad con la base sin migrar contra los adaptadores Postgres REALES + AbortAwareFakeSession (reproduce el
// estado ABORTADO de una transaccion de Postgres: tras un error, cualquier consulta posterior lanza 25P02 salvo un ROLLBACK TO SAVEPOINT; una
// sesion falsa plana NO sirve). Cada test FALLA si se quita el SAVEPOINT. Lecturas -> `disponible: false` / vacio honesto; escrituras -> 503
// tipado; el webhook (puerto de sistema) -> degrada a "agente" y la sesion sigue utilizable para el resto del turno.
import { describe, expect, it } from "vitest";
import {
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  PostgresConversacionesRepository,
  PostgresConversacionesSistema,
  type ConversacionActor,
} from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const C = "00000000-0000-0000-0000-0000000000c1";
const actor: ConversacionActor = { userId: "u1", role: "frontdesk" };
const filtro = { modo: null, soloNoLeidas: false, telefonoClave: null, limit: 25, offset: 0 } as const;

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const siguiente = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
const sigueUtil = async (session: AbortAwareFakeSession) => {
  await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
};
const sinFuncion = (nombre: string) => pgError("42883", `function hoteles.${nombre} does not exist`);

describe("bandeja contra la base sin la migracion 043", () => {
  it("listar -> disponible:false con lista vacia (no 'sin conversaciones') y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /conversaciones_listar/i, respond: () => sinFuncion("conversaciones_listar(uuid, text, boolean, text, integer, integer)") }, siguiente]);
    await expect(new PostgresConversacionesRepository(session).listar(actor, P, filtro)).resolves.toEqual({ disponible: false, total: 0, items: [] });
    await sigueUtil(session);
  });

  it("detalle -> disponible:false", async () => {
    const session = new AbortAwareFakeSession([{ match: /conversacion_detalle/i, respond: () => sinFuncion("conversacion_detalle(uuid)") }, siguiente]);
    await expect(new PostgresConversacionesRepository(session).detalle(actor, P, C)).resolves.toEqual({ disponible: false, valor: null });
    await sigueUtil(session);
  });

  it("escrituras -> 503 tipado (ConversacionesNoDisponibleError) y la sesion sigue utilizable", async () => {
    const enProp = { match: /select 1 as ok from hoteles\.whatsapp_conversations/i, respond: () => [{ ok: 1 }] };
    const session = new AbortAwareFakeSession([
      enProp,
      { match: /conversacion_tomar/i, respond: () => sinFuncion("conversacion_tomar(uuid, boolean)") },
      { match: /conversacion_responder/i, respond: () => sinFuncion("conversacion_responder(uuid, text)") },
      { match: /conversacion_agregar_nota/i, respond: () => sinFuncion("conversacion_agregar_nota(uuid, text)") },
      { match: /conversacion_cerrar/i, respond: () => sinFuncion("conversacion_cerrar(uuid)") },
      siguiente,
    ]);
    const repo = new PostgresConversacionesRepository(session);
    await expect(repo.tomar(actor, P, C, false)).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
    await sigueUtil(session);
    await expect(repo.responder(actor, P, C, "hola")).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
    await sigueUtil(session);
    await expect(repo.agregarNota(actor, P, C, "nota")).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
    await expect(repo.cerrar(actor, P, C)).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
    await sigueUtil(session);
  });

  it("un error real que NO es de migracion pendiente se repropaga tipado o tal cual (no se enmascara como 'no disponible')", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select 1 as ok from hoteles\.whatsapp_conversations/i, respond: () => [{ ok: 1 }] },
      { match: /conversacion_cerrar/i, respond: () => pgError("42501", "solo la persona responsable, owner o gm pueden cerrar la conversacion") },
      { match: /conversaciones_listar/i, respond: () => pgError("57014", "statement timeout") },
      siguiente,
    ]);
    const repo = new PostgresConversacionesRepository(session);
    await expect(repo.cerrar(actor, P, C)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await sigueUtil(session);
    await expect(repo.listar(actor, P, filtro)).rejects.toMatchObject({ code: "57014" });
    await sigueUtil(session);
  });

  it("una conversacion de otra property no existe para esta ruta (404 de dominio, sin llamar a la funcion)", async () => {
    const session = new AbortAwareFakeSession([{ match: /select 1 as ok from hoteles\.whatsapp_conversations/i, respond: () => [] }, siguiente]);
    await expect(new PostgresConversacionesRepository(session).tomar(actor, P, C, false)).rejects.toMatchObject({ name: "ConversacionesNoEncontradaError" });
    expect(session.calls.some((c) => /conversacion_tomar/i.test(c))).toBe(false);
  });
});

describe("puerto de SISTEMA del webhook contra la base sin la 043", () => {
  it("registrarEntrante -> null (el agente responde como siempre) y la sesion sigue utilizable para el resto del turno", async () => {
    const session = new AbortAwareFakeSession([{ match: /conversacion_registrar_entrante/i, respond: () => sinFuncion("conversacion_registrar_entrante(uuid, text)") }, siguiente]);
    await expect(new PostgresConversacionesSistema(session).registrarEntrante(P, "+5219991230000")).resolves.toBeNull();
    await sigueUtil(session);
  });

  it("registrarEntrante: un error real de Postgres NO se traga (el mensaje falla y se reintenta, nunca se responde sobre una conversacion que quiza es humana)", async () => {
    const session = new AbortAwareFakeSession([{ match: /conversacion_registrar_entrante/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresConversacionesSistema(session).registrarEntrante(P, "+5219991230000")).rejects.toMatchObject({ code: "57014" });
  });

  it("derivarAHumano es best-effort: sin la 043 o ante CUALQUIER error devuelve null, no lanza y deja la sesion utilizable (la respuesta del turno ya esta encolada)", async () => {
    const sinMigrar = new AbortAwareFakeSession([{ match: /conversacion_derivar_a_humano/i, respond: () => sinFuncion("conversacion_derivar_a_humano(uuid, text, text)") }, siguiente]);
    await expect(new PostgresConversacionesSistema(sinMigrar).derivarAHumano(P, "+5219991230000", "agente_derivo")).resolves.toBeNull();
    await sigueUtil(sinMigrar);
    const raro = new AbortAwareFakeSession([{ match: /conversacion_derivar_a_humano/i, respond: () => pgError("57014", "statement timeout") }, siguiente]);
    await expect(new PostgresConversacionesSistema(raro).derivarAHumano(P, "+5219991230000", "agente_derivo")).resolves.toBeNull();
    await sigueUtil(raro);
  });

  it("derivarAHumano con transicion emite la notificacion hoteles.conversacion.handoff (dedupe por conversacion + numero de derivacion); sin transicion no emite", async () => {
    const org = "00000000-0000-0000-0000-0000000000b1";
    const con = new AbortAwareFakeSession([
      { match: /conversacion_derivar_a_humano/i, respond: () => [{ conversation_id: C, organization_id: org, handoff_n: 2, transicion: true }] },
      { match: /emit_notification/i, respond: () => [{ emit_notification: 1 }] },
      siguiente,
    ]);
    const r = await new PostgresConversacionesSistema(con).derivarAHumano(P, "+5219991230000", "agente_derivo");
    expect(r).toEqual({ conversationId: C, organizationId: org, handoffN: 2, transicion: true });
    expect(con.calls.some((c) => /emit_notification/i.test(c))).toBe(true);
    const sin = new AbortAwareFakeSession([
      { match: /conversacion_derivar_a_humano/i, respond: () => [{ conversation_id: C, organization_id: org, handoff_n: 2, transicion: false }] },
      siguiente,
    ]);
    await new PostgresConversacionesSistema(sin).derivarAHumano(P, "+5219991230000", "agente_derivo");
    expect(sin.calls.some((c) => /emit_notification/i.test(c))).toBe(false);
  });
});
