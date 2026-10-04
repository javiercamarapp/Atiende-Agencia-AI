import { describe, expect, it } from "vitest";
import { ConversacionesRechazadaError, HandoffYaTomadoError, InMemoryConversacionesRepository, SinNumeroWhatsappError, VentanaWhatsappCerradaError } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const ANA = "00000000-0000-4000-8000-0000000000f1";
const BETO = "00000000-0000-4000-8000-0000000000f2";

function base() {
  const r = new InMemoryConversacionesRepository({ actorUserId: ANA, nombres: { [ANA]: "Ana", [BETO]: "Beto" } });
  r.conversaciones.push({ canal: "whatsapp", id: CONV, organizationId: ORG, propertyId: PROP, telefono: "+5219990000001", mensajes: [{ rol: "cliente", texto: "Hola", createdAt: null }], actividadAt: new Date().toISOString() });
  r.numeroPorSucursal.add(PROP);
  return r;
}

describe("toma / devolucion / cierre", () => {
  it("la segunda persona no pisa la toma de la primera", async () => {
    const ana = base();
    const beto = ana.comoActor(BETO);
    await ana.tomar(ORG, PROP, "whatsapp", CONV);
    await expect(beto.tomar(ORG, PROP, "whatsapp", CONV)).rejects.toBeInstanceOf(HandoffYaTomadoError);
  });

  it("tomar es idempotente para la misma persona", async () => {
    const ana = base();
    expect(await ana.tomar(ORG, PROP, "whatsapp", CONV)).toBe(await ana.tomar(ORG, PROP, "whatsapp", CONV));
  });

  it("solo quien la tiene (o un administrador) devuelve; despues el agente la retoma y puede tomarse de nuevo", async () => {
    const ana = base();
    const beto = ana.comoActor(BETO);
    const admin = ana.comoActor(BETO, true);
    const id = await ana.tomar(ORG, PROP, "whatsapp", CONV);
    await expect(beto.devolver(ORG, PROP, id)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    expect(await admin.devolver(ORG, PROP, id)).toBe(true);
    expect(await ana.devolver(ORG, PROP, id)).toBe(false); // idempotente: ya devuelta
    const otra = await beto.tomar(ORG, PROP, "whatsapp", CONV);
    expect(otra).not.toBe(id);
  });

  it("una conversacion de otra organizacion o sucursal se rechaza", async () => {
    const ana = base();
    await expect(ana.tomar("otra-org", PROP, "whatsapp", CONV)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await expect(ana.tomar(ORG, "00000000-0000-4000-8000-0000000000a9", "whatsapp", CONV)).rejects.toBeInstanceOf(ConversacionesRechazadaError);
  });
});

describe("bandeja", () => {
  it("lista por estado: pendiente y tomada primero, con filtro por estado y canal", async () => {
    const ana = base();
    ana.conversaciones.push({ canal: "voz", id: "v1", organizationId: ORG, propertyId: PROP, telefono: null, mensajes: [], actividadAt: "2026-09-30T21:00:00.000Z" });
    expect((await ana.listarBandeja(ORG, PROP, {})).valor.items.map((i) => i.estado)).toEqual(["agente", "agente"]);
    await ana.tomar(ORG, PROP, "whatsapp", CONV);
    const todo = await ana.listarBandeja(ORG, PROP, {});
    expect(todo.valor.items[0]).toMatchObject({ canal: "whatsapp", estado: "tomada", tomadaPorNombre: "Ana" });
    expect((await ana.listarBandeja(ORG, PROP, { canal: "voz" })).valor.total).toBe(1);
    expect((await ana.listarBandeja(ORG, PROP, { estado: "tomada" })).valor.total).toBe(1);
  });

  it("base sin migrar: disponible=false con lista vacia", async () => {
    const ana = base();
    ana.disponible = false;
    expect(await ana.listarBandeja(ORG, PROP, {})).toEqual({ disponible: false, valor: { items: [], total: 0 } });
  });
});

describe("notas y respuesta humana", () => {
  it("las notas quedan con autor; solo quien tomo responde por WhatsApp y el mensaje sale por el outbox", async () => {
    const ana = base();
    const beto = ana.comoActor(BETO);
    const id = await ana.tomar(ORG, PROP, "whatsapp", CONV);
    await ana.agregarNota(ORG, PROP, id, "  Pide factura ");
    expect((await ana.detalle(ORG, PROP, "whatsapp", CONV)).valor?.notas[0]).toMatchObject({ texto: "Pide factura", autorNombre: "Ana" });
    await expect(beto.responderWhatsapp(ORG, PROP, id, "hola")).rejects.toBeInstanceOf(ConversacionesRechazadaError);
    await ana.responderWhatsapp(ORG, PROP, id, "Ya le atiendo");
    expect(ana.outbox).toEqual([{ organizationId: ORG, to: "+5219990000001", body: "Ya le atiendo" }]);
    expect((await ana.detalle(ORG, PROP, "whatsapp", CONV)).valor?.mensajes.at(-1)).toMatchObject({ rol: "humano", texto: "Ya le atiendo" });
  });

  // QA R1 agentes-20: Meta rechaza (131047) el texto libre si el cliente escribio hace mas de 24 h; el panel no debe decir "encolado".
  it("ventana de 24 h: el ultimo mensaje del cliente de hace 25 h rechaza la respuesta; de hace 23 h la deja pasar", async () => {
    const ahora = new Date("2026-10-13T20:00:00.000Z");
    const hace = (h: number) => new Date(ahora.getTime() - h * 3_600_000).toISOString();
    for (const [horas, debePasar] of [[25, false], [23, true]] as const) {
      const r = new InMemoryConversacionesRepository({ actorUserId: ANA, ahora: () => ahora });
      r.conversaciones.push({ canal: "whatsapp", id: CONV, organizationId: ORG, propertyId: PROP, telefono: "+5219990000001", mensajes: [{ rol: "cliente", texto: "Hola", createdAt: hace(horas) }], actividadAt: hace(horas) });
      r.numeroPorSucursal.add(PROP);
      const id = await r.tomar(ORG, PROP, "whatsapp", CONV);
      if (debePasar) {
        await r.responderWhatsapp(ORG, PROP, id, "Ya le atiendo");
        expect(r.outbox).toHaveLength(1);
      } else {
        await expect(r.responderWhatsapp(ORG, PROP, id, "Una disculpa por la demora")).rejects.toBeInstanceOf(VentanaWhatsappCerradaError);
        expect(r.outbox).toHaveLength(0);
        expect(r.conversaciones[0]!.mensajes).toHaveLength(1);
      }
    }
  });

  it("ventana de 24 h: si el cliente vuelve a escribir mientras la toma esta abierta (ping del agente), la ventana se reabre", async () => {
    const ahora = new Date("2026-10-13T20:00:00.000Z");
    const r = new InMemoryConversacionesRepository({ actorUserId: ANA, ahora: () => ahora });
    const viejo = new Date(ahora.getTime() - 30 * 3_600_000).toISOString();
    r.conversaciones.push({ canal: "whatsapp", id: CONV, organizationId: ORG, propertyId: PROP, telefono: "+5219990000001", mensajes: [{ rol: "cliente", texto: "Hola", createdAt: viejo }], actividadAt: viejo });
    r.numeroPorSucursal.add(PROP);
    const id = await r.tomar(ORG, PROP, "whatsapp", CONV);
    r.handoffs[0]!.ultimoClienteAt = new Date(ahora.getTime() - 60_000).toISOString();
    await r.responderWhatsapp(ORG, PROP, id, "Ya le atiendo");
    expect(r.outbox).toHaveLength(1);
  });

  it("sin numero de WhatsApp en la sucursal falla con un error claro", async () => {
    const ana = base();
    ana.numeroPorSucursal.clear();
    const id = await ana.tomar(ORG, PROP, "whatsapp", CONV);
    await expect(ana.responderWhatsapp(ORG, PROP, id, "hola")).rejects.toBeInstanceOf(SinNumeroWhatsappError);
  });
});

describe("callbacks y turnos", () => {
  it("un intento 'contactado' resuelve el callback; 'no_contesto' lo deja abierto y queda en el registro", async () => {
    const ana = base();
    ana.callbacks.push({ organizationId: ORG, id: "cb1", propertyId: PROP, customerName: "Cliente", customerPhone: "+521", reason: "queja", message: null, source: "voice", resolved: false, createdAt: "2026-09-30T20:00:00.000Z", intentos: [] });
    await ana.registrarIntentoCallback(ORG, "cb1", { resultado: "no_contesto", nota: null, proximoIntentoAt: null });
    expect((await ana.listarCallbacks(ORG, PROP, true)).valor).toHaveLength(1);
    await ana.registrarIntentoCallback(ORG, "cb1", { resultado: "contactado", nota: "Resuelto", proximoIntentoAt: null });
    expect((await ana.listarCallbacks(ORG, PROP, true)).valor).toHaveLength(0);
    expect((await ana.listarCallbacks(ORG, PROP, false)).valor[0]!.intentos.map((i) => i.resultado)).toEqual(["contactado", "no_contesto"]);
  });

  it("reemplazarTurnos sustituye todos los turnos de la sucursal", async () => {
    const ana = base();
    await ana.reemplazarTurnos(ORG, PROP, [{ nombre: "T1", dias: [1], inicia: "12:00", termina: "18:00", miembros: [{ userId: ANA, orden: 1 }] }]);
    await ana.reemplazarTurnos(ORG, PROP, [{ nombre: "T2", dias: [2], inicia: "18:00", termina: "01:00", miembros: [] }]);
    expect((await ana.listarTurnos(ORG, PROP)).valor.map((t) => t.nombre)).toEqual(["T2"]);
  });
});
