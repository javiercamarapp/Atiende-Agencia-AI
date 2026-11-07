// R23 (migracion 120) en el adaptador Postgres: asignar, alertas y los extras del detalle (resumen/telefono de voz). Cada caso afirma el SQL emitido
// y la degradacion contra la base SIN migrar (42883/42703): nunca un 500, la sesion sigue viva (AbortAwareFakeSession).
import { describe, expect, it } from "vitest";
import { ConversacionesNoDisponibleError, ConversacionesRechazadaError, PostgresConversacionesRepository, estadoDeTrabajo } from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const H = "00000000-0000-4000-8000-0000000000e1";
const ANA = "00000000-0000-4000-8000-0000000000f1";
const CONV = "00000000-0000-4000-8000-0000000000d1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const err = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("estado de trabajo del staff", () => {
  it("pendiente = nuevo, tomada = en atencion, cerrada = resuelto; agente y devuelta no son trabajo del staff", () => {
    expect(estadoDeTrabajo("pendiente")).toBe("nuevo");
    expect(estadoDeTrabajo("tomada")).toBe("en_atencion");
    expect(estadoDeTrabajo("cerrada")).toBe("resuelto");
    expect(estadoDeTrabajo("devuelta")).toBe("con_agente");
    expect(estadoDeTrabajo("agente")).toBe("con_agente");
  });
});

describe("asignar (handoff_asignar)", () => {
  it("llama a la funcion con organizacion, sucursal, handoff y persona, y devuelve si hubo cambio", async () => {
    const s = new AbortAwareFakeSession([{ match: /restaurantes\.handoff_asignar/i, respond: () => [{ ok: true }] }]);
    await expect(new PostgresConversacionesRepository(s).asignar(ORG, PROP, H, ANA)).resolves.toBe(true);
    const s2 = new AbortAwareFakeSession([{ match: /restaurantes\.handoff_asignar/i, respond: () => [{ ok: false }] }]);
    await expect(new PostgresConversacionesRepository(s2).asignar(ORG, PROP, H, ANA)).resolves.toBe(false);
  });

  it("42501 (sin acceso / persona ajena) -> rechazada; base sin migrar -> no disponible; la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /handoff_asignar/i, respond: () => err("42501", "sin acceso") }, SIGUIENTE]);
    await expect(new PostgresConversacionesRepository(s).asignar(ORG, PROP, H, ANA)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    const s2 = new AbortAwareFakeSession([{ match: /handoff_asignar/i, respond: () => err("42883", "function does not exist") }, SIGUIENTE]);
    await expect(new PostgresConversacionesRepository(s2).asignar(ORG, PROP, H, ANA)).rejects.toBeInstanceOf(ConversacionesNoDisponibleError);
    await expect(s2.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

describe("alertas del panel (panel_alertas)", () => {
  it("mapea los cuatro tipos, numeros y nulos; descarta tipos desconocidos", async () => {
    const filas = [
      { tipo: "pedido_por_aprobar", canal: null, conversation_id: null, handoff_id: null, order_id: "o1", referencia: "#901", minutos: "7", monto: "4500.00", resumen: null, telefono: null },
      { tipo: "llamada_por_devolver", canal: "voz", conversation_id: CONV, handoff_id: H, order_id: null, referencia: "+5219991112222", minutos: 4, monto: null, resumen: "Queja", telefono: "+5219991112222" },
      { tipo: "sin_tomar", canal: "whatsapp", conversation_id: CONV, handoff_id: H, order_id: null, referencia: "+5219990000001", minutos: 12, monto: null, resumen: "queja", telefono: null },
      { tipo: "inventado", canal: null, conversation_id: null, handoff_id: null, order_id: null, referencia: "x", minutos: 1, monto: null, resumen: null, telefono: null },
    ];
    const s = new AbortAwareFakeSession([{ match: /panel_alertas/i, respond: () => filas }]);
    const r = await new PostgresConversacionesRepository(s).listarAlertas(ORG, PROP, { sinRespuestaMin: 10, montoMin: 4000 });
    expect(r.disponible).toBe(true);
    expect(r.valor.map((a) => a.tipo)).toEqual(["pedido_por_aprobar", "llamada_por_devolver", "sin_tomar"]);
    expect(r.valor[0]).toMatchObject({ monto: 4500, minutos: 7, canal: null, orderId: "o1" });
    expect(r.valor[1]).toMatchObject({ canal: "voz", telefono: "+5219991112222", resumen: "Queja" });
  });

  it("base sin migrar -> disponible:false y vacio; sin permiso (42501) -> rechazada", async () => {
    const s = new AbortAwareFakeSession([{ match: /panel_alertas/i, respond: () => err("42883", "no existe") }, SIGUIENTE]);
    const r = await new PostgresConversacionesRepository(s).listarAlertas(ORG, PROP, { sinRespuestaMin: 10, montoMin: 4000 });
    expect(r).toEqual({ disponible: false, valor: [] });
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    const s2 = new AbortAwareFakeSession([{ match: /panel_alertas/i, respond: () => err("42501", "sin acceso") }]);
    await expect(new PostgresConversacionesRepository(s2).listarAlertas(ORG, PROP, { sinRespuestaMin: 10, montoMin: 4000 })).rejects.toBeInstanceOf(ConversacionesRechazadaError);
  });
});

describe("detalle de una llamada escalada: extras de la migracion 120", () => {
  const base = (extra: FakeSessionHandler): FakeSessionHandler[] => [
    { match: /from restaurantes\.voice_conversation/i, respond: () => [{ id: CONV }] },
    { match: /from restaurantes\.voice_turn/i, respond: () => [{ rol: "cliente", texto: "Quiero quejarme", created_at: "2026-10-30T18:00:00.000Z" }] },
    { match: /from restaurantes\.handoff_detalle/i, respond: () => [{ handoff_id: H, estado: "pendiente", solicitado_por: "agente", motivo: "escalada:queja", solicitada_at: "2026-10-30T18:01:00.000Z", ultimo_cliente_at: null, tomada_por: null, tomada_por_nombre: null, tomada_at: null }] },
    extra,
    { match: /from restaurantes\.handoff_notas/i, respond: () => [] },
    SIGUIENTE,
  ];

  it("trae resumen, telefono para devolver la llamada y quien asigno", async () => {
    const s = new AbortAwareFakeSession(base({ match: /handoff_extra/i, respond: () => [{ resumen: "Tacos fríos", telefono_devolucion: "+5219991112222", callback_id: "cb1", asignada_por: ANA, asignada_por_nombre: "Ana", asignada_at: "2026-10-30T18:02:00.000Z", tomada_por_app: false }] }));
    const r = await new PostgresConversacionesRepository(s).detalle(ORG, PROP, "voz", CONV);
    expect(r.valor!.handoff).toMatchObject({ resumen: "Tacos fríos", telefonoDevolucion: "+5219991112222", callbackId: "cb1", asignadaPorNombre: "Ana", asignadaAt: "2026-10-30T18:02:00.000Z", tomadaPorApp: false });
  });

  it("sin la migracion 120 el detalle igual se ve (sin extras) y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession(base({ match: /handoff_extra/i, respond: () => err("42883", "function handoff_extra does not exist") }));
    const r = await new PostgresConversacionesRepository(s).detalle(ORG, PROP, "voz", CONV);
    expect(r.disponible).toBe(true);
    expect(r.valor!.handoff).toMatchObject({ handoffId: H, estado: "pendiente" });
    expect(r.valor!.handoff!.resumen).toBeUndefined();
    expect(r.valor!.mensajes).toHaveLength(1);
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});
