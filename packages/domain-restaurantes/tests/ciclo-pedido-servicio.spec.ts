// F4b -- servicio del ciclo operativo del pedido sobre adaptadores en memoria: aceptar/rechazar con tiempo prometido y motivo (y su aviso al cliente por el canal
// ya existente), salida y entrega con hora real (y tiempo real vs prometido en los ratios), encuesta post-entrega (una sola vez, ventana de 24 h o plantilla,
// baja, registro) y recordatorios de pedidos sin aceptar. Sin red, sin reloj real, sin modelo.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { InMemoryCicloPedidoRepository } from "../src/ciclo-pedido/in-memory-repository.ts";
import {
  aceptarPedido,
  barrerEncuestas,
  barrerRecordatorios,
  obtenerRatiosOperacion,
  procesarMensajeDeEncuesta,
  rechazarPedido,
  registrarEntrega,
  registrarSalida,
} from "../src/ciclo-pedido/servicio.ts";
import { CicloConflictoError, CicloNoDisponibleError, CicloNoEncontradoError, CicloValidacionError } from "../src/ciclo-pedido/tipos.ts";
import { normalizePhone } from "../src/phone.ts";
import { actorHash } from "../src/rate-limit.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { CreateOrderInput } from "../src/types.ts";

const T0 = new Date("2026-10-20T18:00:00.000Z"); // 12:00 en Merida
const min = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const CHOFER = randomUUID();

function montar(opciones: { canal?: boolean } = {}) {
  const fixture = buildRestaurantFixture();
  if (opciones.canal !== false) fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
  const ciclo = new InMemoryCicloPedidoRepository(fixture.repo);
  ciclo.ahora = () => T0;
  const deps = { repo: fixture.repo, ciclo };
  async function pedido(over: Partial<CreateOrderInput> = {}) {
    const input: CreateOrderInput = {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Ana",
      customerPhone: "9990001111",
      customerAddress: "Calle 80 #30",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
      ...over,
    };
    return createOrder(fixture.repo, input);
  }
  const salida = () => fixture.repo.getOutbox();
  return { fixture, ciclo, deps, pedido, salida, org: fixture.organizationId };
}

describe("aceptar un pedido con tiempo prometido", () => {
  it("pasa pending -> preparando, guarda el tiempo y avisa al cliente por el canal de notificaciones de pedido con el tiempo prometido", async () => {
    const { deps, pedido, salida, org, fixture } = montar();
    const o = await pedido();
    const r = await aceptarPedido(deps, { organizationId: org, orderId: o.id, tiempoPrometidoMin: 50 });
    expect(r).toMatchObject({ resultado: "aceptado", tiempoPrometidoMin: 50, aviso: { encolado: true } });
    expect((await fixture.repo.findOrderById(org, o.id))?.status).toBe("preparando");
    const fila = salida().find((x) => x.eventType === "order.status.preparando")!;
    const payload = fila.payload as { to: string; phone_number_id: string; body: string; transaccional: boolean; template: { name: string; params: string[] } };
    expect(payload.to).toBe("+529990001111");
    expect(payload.phone_number_id).toBe("PHONE_NUMBER_ID_123");
    expect(payload.body).toContain("50 minutos");
    expect(payload.transaccional).toBe(true);
    expect(payload.template.name).toBe("pedido_aceptado_con_tiempo");
    expect(payload.template.params[3]).toBe("50 minutos");
  });

  it("sin tiempo usa el valor por omision del canal: 45 domicilio, 20 recoger", async () => {
    const { deps, pedido, org } = montar();
    const dom = await pedido();
    expect((await aceptarPedido(deps, { organizationId: org, orderId: dom.id })).tiempoPrometidoMin).toBe(45);
    const rec = await pedido({ canal: "recoger", horaRecogida: undefined, customerPhone: "9990002222" });
    expect((await aceptarPedido(deps, { organizationId: org, orderId: rec.id })).tiempoPrometidoMin).toBe(20);
  });

  it("rechaza un tiempo fuera de 5 a 240 y un pedido inexistente", async () => {
    const { deps, pedido, org } = montar();
    const o = await pedido();
    await expect(aceptarPedido(deps, { organizationId: org, orderId: o.id, tiempoPrometidoMin: 4 })).rejects.toBeInstanceOf(CicloValidacionError);
    await expect(aceptarPedido(deps, { organizationId: org, orderId: o.id, tiempoPrometidoMin: 241 })).rejects.toBeInstanceOf(CicloValidacionError);
    await expect(aceptarPedido(deps, { organizationId: org, orderId: randomUUID() })).rejects.toBeInstanceOf(CicloNoEncontradoError);
  });

  it("es idempotente: reintentar no cambia el estado ni duplica el aviso", async () => {
    const { deps, pedido, salida, org } = montar();
    const o = await pedido();
    await aceptarPedido(deps, { organizationId: org, orderId: o.id, tiempoPrometidoMin: 30 });
    const otra = await aceptarPedido(deps, { organizationId: org, orderId: o.id, tiempoPrometidoMin: 30 });
    expect(otra.resultado).toBe("ya_aplicado");
    expect(salida().filter((x) => x.eventType === "order.status.preparando")).toHaveLength(1);
  });

  it("un pedido que ya no esta pendiente (otro lo movio) es conflicto 409, no una aceptacion falsa", async () => {
    const { deps, pedido, fixture, org } = montar();
    const o = await pedido();
    await fixture.repo.updateOrderStatus(org, o.id, "pending", "preparando");
    await expect(aceptarPedido(deps, { organizationId: org, orderId: o.id })).rejects.toBeInstanceOf(CicloConflictoError);
  });

  it("sin canal de WhatsApp la aceptacion SI queda registrada y el aviso lo dice honestamente", async () => {
    const { deps, pedido, salida, org, fixture } = montar({ canal: false });
    const o = await pedido();
    const r = await aceptarPedido(deps, { organizationId: org, orderId: o.id });
    expect(r.aviso).toEqual({ encolado: false, motivo: "sin_canal_whatsapp" });
    expect((await fixture.repo.findOrderById(org, o.id))?.status).toBe("preparando");
    expect(salida()).toHaveLength(0);
  });

  it("base sin migrar: CicloNoDisponibleError (503 honesto) y el pedido no se toca", async () => {
    const { deps, ciclo, pedido, org, fixture } = montar();
    const o = await pedido();
    ciclo.migrado = false;
    await expect(aceptarPedido(deps, { organizationId: org, orderId: o.id })).rejects.toBeInstanceOf(CicloNoDisponibleError);
    expect((await fixture.repo.findOrderById(org, o.id))?.status).toBe("pending");
  });
});

describe("rechazar un pedido con motivo", () => {
  it("cancela, avisa con la frase del motivo y NUNCA envia la nota interna al cliente", async () => {
    const { deps, pedido, salida, org, fixture } = montar();
    const o = await pedido();
    const r = await rechazarPedido(deps, { organizationId: org, orderId: o.id, motivo: "sin_insumos", nota: "se acabo el pastor, avisar a compras" });
    expect(r).toMatchObject({ resultado: "rechazado", motivo: "sin_insumos", aviso: { encolado: true } });
    expect((await fixture.repo.findOrderById(org, o.id))?.status).toBe("cancelado");
    const fila = salida().find((x) => x.eventType === "order.status.cancelado")!;
    const payload = fila.payload as { body: string; template: { name: string } };
    expect(payload.body).toContain("no contamos con algunos de los productos");
    expect(JSON.stringify(fila.payload)).not.toContain("compras");
    expect(payload.template.name).toBe("pedido_rechazado");
  });

  it("solo se rechaza un pedido pendiente; reintento idempotente; nota larga invalida", async () => {
    const { deps, pedido, salida, org, fixture } = montar();
    const o = await pedido();
    await rechazarPedido(deps, { organizationId: org, orderId: o.id, motivo: "cerrado" });
    expect((await rechazarPedido(deps, { organizationId: org, orderId: o.id, motivo: "cerrado" })).resultado).toBe("ya_aplicado");
    expect(salida().filter((x) => x.eventType === "order.status.cancelado")).toHaveLength(1);
    const p = await pedido({ customerPhone: "9990003333" });
    await fixture.repo.updateOrderStatus(org, p.id, "pending", "preparando");
    await expect(rechazarPedido(deps, { organizationId: org, orderId: p.id, motivo: "otro" })).rejects.toBeInstanceOf(CicloConflictoError);
    const q = await pedido({ customerPhone: "9990004444" });
    await expect(rechazarPedido(deps, { organizationId: org, orderId: q.id, motivo: "otro", nota: "x".repeat(241) })).rejects.toBeInstanceOf(CicloValidacionError);
  });
});

describe("salida con repartidor y entrega con hora real", () => {
  async function preparado(m: ReturnType<typeof montar>, tel = "9990001111") {
    const o = await m.pedido({ customerPhone: tel });
    await aceptarPedido(m.deps, { organizationId: m.org, orderId: o.id, tiempoPrometidoMin: 45 });
    return o;
  }

  it("la salida asigna chofer, cambia a en_camino, registra la hora real y avisa al cliente", async () => {
    const m = montar();
    const o = await preparado(m);
    m.ciclo.ahora = () => min(10);
    const r = await registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: CHOFER, etaMin: 35 });
    expect(r).toMatchObject({ resultado: "despachado", salioAt: min(10).toISOString(), repartidorId: CHOFER, horaRealRegistrada: true });
    const guardado = await m.fixture.repo.findOrderById(m.org, o.id);
    expect(guardado).toMatchObject({ status: "en_camino", assignedRepartidorId: CHOFER });
    expect((m.salida().find((x) => x.eventType === "order.status.en_camino")!.payload as { body: string }).body).toContain("va en camino");
  });

  it("repetir la salida con el mismo chofer es ya_aplicado y no reenvia el aviso; con otro chofer es reasignado", async () => {
    const m = montar();
    const o = await preparado(m);
    await registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: CHOFER });
    expect((await registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: CHOFER })).resultado).toBe("ya_aplicado");
    expect((await registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: randomUUID() })).resultado).toBe("reasignado");
    expect(m.salida().filter((x) => x.eventType === "order.status.en_camino")).toHaveLength(1);
  });

  it("sin la 092 cae al camino anterior (asignar + cambiar estado) y dice que NO registro la hora real", async () => {
    const m = montar();
    const o = await preparado(m);
    m.ciclo.despacharDisponible = false;
    const r = await registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: CHOFER });
    expect(r).toMatchObject({ resultado: "despachado", salioAt: null, horaRealRegistrada: false });
    expect((await m.fixture.repo.findOrderById(m.org, o.id))?.status).toBe("en_camino");
  });

  it("solo se despacha un pedido ya aceptado (preparando): uno pendiente es conflicto", async () => {
    const m = montar();
    const o = await m.pedido();
    await expect(registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: CHOFER })).rejects.toBeInstanceOf(CicloConflictoError);
  });

  it("la entrega guarda la hora REAL (pasada), avisa 'entregado' y reporta el tiempo desde que se acepto", async () => {
    const m = montar();
    const o = await preparado(m);
    m.ciclo.ahora = () => min(10);
    await registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: CHOFER });
    m.ciclo.ahora = () => min(60);
    const r = await registrarEntrega(m.deps, { organizationId: m.org, orderId: o.id, ocurrioEn: min(52) });
    expect(r).toMatchObject({ resultado: "entregado", entregadoAt: min(52).toISOString(), minutosDesdeAceptado: 52, tiempoPrometidoMin: 45 });
    expect((await m.fixture.repo.findOrderById(m.org, o.id))?.status).toBe("entregado");
    expect(m.salida().some((x) => x.eventType === "order.status.entregado")).toBe(true);
    expect((await registrarEntrega(m.deps, { organizationId: m.org, orderId: o.id })).resultado).toBe("ya_aplicado");
  });

  it("la hora real no puede ser futura, ni anterior a la salida, ni de hace mas de 12 h", async () => {
    const m = montar();
    const o = await preparado(m);
    m.ciclo.ahora = () => min(10);
    await registrarSalida(m.deps, { organizationId: m.org, orderId: o.id, repartidorId: CHOFER });
    m.ciclo.ahora = () => min(30);
    await expect(registrarEntrega(m.deps, { organizationId: m.org, orderId: o.id, ocurrioEn: min(45) })).rejects.toBeInstanceOf(CicloValidacionError);
    await expect(registrarEntrega(m.deps, { organizationId: m.org, orderId: o.id, ocurrioEn: min(5) })).rejects.toBeInstanceOf(CicloValidacionError);
    m.ciclo.ahora = () => new Date(T0.getTime() + 13 * 3_600_000);
    await expect(registrarEntrega(m.deps, { organizationId: m.org, orderId: o.id, ocurrioEn: min(20) })).rejects.toBeInstanceOf(CicloValidacionError);
  });

  it("no se entrega un pedido que no salio", async () => {
    const m = montar();
    const o = await preparado(m);
    await expect(registrarEntrega(m.deps, { organizationId: m.org, orderId: o.id })).rejects.toBeInstanceOf(CicloConflictoError);
  });

  it("alimenta el tiempo real vs prometido de los ratios (aceptados, a tiempo, desvio)", async () => {
    const m = montar();
    const a = await preparado(m, "9990001111");
    const b = await preparado(m, "9990002222");
    m.ciclo.ahora = () => min(5);
    await registrarSalida(m.deps, { organizationId: m.org, orderId: a.id, repartidorId: CHOFER });
    await registrarSalida(m.deps, { organizationId: m.org, orderId: b.id, repartidorId: CHOFER });
    m.ciclo.ahora = () => min(120);
    await registrarEntrega(m.deps, { organizationId: m.org, orderId: a.id, ocurrioEn: min(40) }); // a tiempo (40 <= 45)
    await registrarEntrega(m.deps, { organizationId: m.org, orderId: b.id, ocurrioEn: min(60) }); // tarde (60 > 45)
    const rechazado = await m.pedido({ customerPhone: "9990005555" });
    await rechazarPedido(m.deps, { organizationId: m.org, orderId: rechazado.id, motivo: "saturado" });

    const r = await obtenerRatiosOperacion(m.deps, m.org, "p", min(-60), min(600));
    expect(r.disponible).toBe(true);
    expect(r.ratios).toMatchObject({ tasaAceptacionPct: 66.7, tasaRechazoPct: 33.3, cumplimientoPromesaPct: 50, desvioMinProm: 5, salidaMinProm: 5 });
  });

  it("base sin migrar: los ratios dicen 'no disponible' y no inventan ceros", async () => {
    const m = montar();
    m.ciclo.migrado = false;
    const r = await obtenerRatiosOperacion(m.deps, m.org, "p", min(0), min(60));
    expect(r).toMatchObject({ disponible: false, ratios: null });
  });
});

describe("encuesta post-entrega", () => {
  const TEL = "9991230001";
  const HASH = actorHash(normalizePhone(TEL));

  function conEncuesta(extra: { ultimoEntrante?: Date | null; consentimiento?: boolean; plantillas?: readonly string[]; habilitada?: boolean; entregadaMinAntes?: number; ahora?: Date } = {}) {
    const m = montar();
    const ahora = extra.ahora ?? min(0);
    m.ciclo.ahora = () => ahora;
    void m.ciclo.guardarConfigEncuesta(m.org, "prop", { habilitada: extra.habilitada ?? true, linkResena: "https://g.page/r/ejemplo/review" });
    const orderId = randomUUID();
    m.ciclo.sembrarEntrega({
      orderId,
      organizationId: m.org,
      propertyId: "prop",
      customerPhone: TEL,
      deliveredAt: new Date(ahora.getTime() - (extra.entregadaMinAntes ?? 150) * 60_000),
      zonaHoraria: "America/Merida",
      phoneHash: HASH,
      ultimoEntranteAt: extra.ultimoEntrante === undefined ? new Date(ahora.getTime() - 4 * 3_600_000) : extra.ultimoEntrante,
      consentimiento: extra.consentimiento ?? false,
    });
    return { ...m, orderId, ahora, deps: { ...m.deps, plantillasAprobadas: extra.plantillas ?? [] } };
  }

  it("dentro de la ventana de 24 h envia UNA encuesta de texto, sin transaccional (la lista de supresion aplica)", async () => {
    const e = conEncuesta();
    const r = await barrerEncuestas(e.deps, e.ahora);
    expect(r).toMatchObject({ disponible: true, candidatas: 1, enviadas: 1, enviadasPlantilla: 0, omitidas: 0 });
    const fila = e.salida().find((x) => x.eventType === "encuesta.entrega")!;
    const p = fila.payload as { to: string; body: string; transaccional?: boolean; template?: unknown };
    expect(p.to).toBe("+529991230001");
    expect(p.body).toMatch(/del 1 \(muy mal\) al 5 \(excelente\)/);
    expect(p.body).toContain("BAJA");
    expect(p.transaccional).toBeUndefined();
    expect(p.template).toBeUndefined();
    expect(e.ciclo.filasEncuesta()[0]).toMatchObject({ estado: "enviada", canal: "texto" });
  });

  it("SOLO una vez por pedido: un segundo barrido (o dos instancias a la vez) no reenvia", async () => {
    const e = conEncuesta();
    await barrerEncuestas(e.deps, e.ahora);
    const otra = await barrerEncuestas(e.deps, e.ahora);
    expect(otra.candidatas).toBe(0);
    expect(e.salida().filter((x) => x.eventType === "encuesta.entrega")).toHaveLength(1);
    // la carrera: reservar dos veces el mismo pedido solo deja pasar a uno
    expect(await e.ciclo.reservarEncuesta(e.org, e.orderId, HASH, "enviada", null, "texto")).toBe(false);
  });

  it("fuera de la ventana SIN plantilla aprobada no envia nada y deja la omision registrada", async () => {
    const e = conEncuesta({ ultimoEntrante: new Date(min(0).getTime() - 3 * 86_400_000) });
    const r = await barrerEncuestas(e.deps, e.ahora);
    expect(r).toMatchObject({ enviadas: 0, omitidas: 1 });
    expect(e.salida()).toHaveLength(0);
    expect(e.ciclo.filasEncuesta()[0]).toMatchObject({ estado: "omitida", omitidoMotivo: "sin_ventana_ni_plantilla" });
  });

  it("fuera de la ventana con plantilla APROBADA y consentimiento envia la plantilla; sin consentimiento no", async () => {
    const lejos = new Date(min(0).getTime() - 3 * 86_400_000);
    const con = conEncuesta({ ultimoEntrante: lejos, plantillas: ["encuesta_entrega"], consentimiento: true });
    expect(await barrerEncuestas(con.deps, con.ahora)).toMatchObject({ enviadas: 1, enviadasPlantilla: 1 });
    const p = con.salida().find((x) => x.eventType === "encuesta.entrega")!.payload as { template: { name: string; params: string[] } };
    expect(p.template.name).toBe("encuesta_entrega");
    expect(p.template.params).toHaveLength(2);
    const sin = conEncuesta({ ultimoEntrante: lejos, plantillas: ["encuesta_entrega"], consentimiento: false });
    expect(await barrerEncuestas(sin.deps, sin.ahora)).toMatchObject({ enviadas: 0, omitidas: 1 });
  });

  it("antes de 2 h ni siquiera es candidata; en horas de silencio (23:00 a 9:00 locales) espera sin registrar nada; apagada por omision no encuesta", async () => {
    const pronto = conEncuesta({ entregadaMinAntes: 100 });
    expect(await barrerEncuestas(pronto.deps, pronto.ahora)).toMatchObject({ candidatas: 0, enviadas: 0, omitidas: 0 });
    // 13:00Z = 07:00 en Merida; entregado 04:30 locales: la base (06:30) cae en el silencio y se difiere a las 9:00
    const noche = conEncuesta({ ahora: new Date("2026-10-21T13:00:00.000Z"), entregadaMinAntes: 150 });
    expect(await barrerEncuestas(noche.deps, noche.ahora)).toMatchObject({ candidatas: 1, enviadas: 0, omitidas: 0, esperando: 1 });
    expect(noche.ciclo.filasEncuesta()).toHaveLength(0);
    expect(noche.salida()).toHaveLength(0);
    const apagada = conEncuesta({ habilitada: false });
    expect(await barrerEncuestas(apagada.deps, apagada.ahora)).toMatchObject({ candidatas: 0, enviadas: 0 });
  });

  it("la baja registrada antes impide enviar", async () => {
    const e = conEncuesta();
    await e.ciclo.registrarBajaEncuesta(e.org, HASH);
    expect(await barrerEncuestas(e.deps, e.ahora)).toMatchObject({ enviadas: 0, omitidas: 1 });
    expect(e.ciclo.filasEncuesta()[0]?.omitidoMotivo).toBe("opt_out");
  });

  it("base sin migrar: el barrido responde disponible false y no lanza", async () => {
    const e = conEncuesta();
    e.ciclo.migrado = false;
    expect(await barrerEncuestas(e.deps, e.ahora)).toMatchObject({ disponible: false, enviadas: 0 });
  });

  async function enviada() {
    const e = conEncuesta();
    await barrerEncuestas(e.deps, e.ahora);
    return e;
  }

  it("calificacion alta: se registra, agradece, invita a resenar con el link (sin incentivo) y pide comentario opcional", async () => {
    const e = await enviada();
    expect(e.ciclo.filasEncuesta()[0]?.estado).toBe("enviada");
    const r = await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "5", ahora: min(1) });
    expect(r?.tipo).toBe("calificacion");
    expect(r?.reply).toContain("https://g.page/r/ejemplo/review");
    expect(r?.reply).toContain("comentario");
    expect(e.ciclo.filasEncuesta()[0]).toMatchObject({ estado: "respondida", calificacion: 5 });
    expect(e.fixture.repo.peekCallbackRequests()).toHaveLength(0);
  });

  it("calificacion <= 3: recuperacion privada (callback encuesta_baja), nunca menciona Google", async () => {
    const e = await enviada();
    const fila = e.ciclo.filasEncuesta()[0]!;
    const real = await e.pedido({ customerPhone: TEL });
    // la fila apunta al pedido sembrado; el servicio lee el pedido por id, asi que se alinea
    (fila as { orderId: string }).orderId = real.id;
    const r = await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "2", ahora: min(1) });
    expect(r?.tipo).toBe("calificacion");
    expect(r?.reply.toLowerCase()).not.toContain("google");
    expect(r?.reply).not.toContain("http");
    const cbs = e.fixture.repo.peekCallbackRequests();
    expect(cbs).toHaveLength(1);
    expect(cbs[0]).toMatchObject({ reason: "encuesta_baja" });
    expect(cbs[0]!.message).not.toMatch(/\+?\d{10}/);
  });

  it("el comentario opcional se guarda en la ventana de 30 min; un mensaje de pedido nuevo NO se toma como comentario", async () => {
    const e = await enviada();
    await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "4", ahora: min(1) });
    expect(await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "Quiero pedir tacos otra vez", ahora: min(2) })).toBeNull();
    const c = await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "Todo muy rico, gracias", ahora: min(5) });
    expect(c?.tipo).toBe("comentario");
    expect(e.ciclo.filasEncuesta()[0]?.comentario).toBe("Todo muy rico, gracias");
    // ya con comentario: el siguiente mensaje sigue al agente
    expect(await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "otra cosa", ahora: min(6) })).toBeNull();
  });

  it("pasados 30 min ya no se guarda como comentario", async () => {
    const e = await enviada();
    await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "4", ahora: min(1) });
    expect(await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "Todo muy rico", ahora: min(40) })).toBeNull();
  });

  it("BAJA registra la baja, responde y ya no se vuelve a encuestar a ese telefono", async () => {
    const e = await enviada();
    const r = await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "BAJA", ahora: min(1) });
    expect(r?.tipo).toBe("baja");
    expect(e.ciclo.hayBaja(e.org, HASH)).toBe(true);
  });

  it("un mensaje que no es calificacion (o un telefono sin encuesta) sigue su camino normal", async () => {
    const e = await enviada();
    expect(await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219991230001", body: "Hola, quiero ver el menú", ahora: min(1) })).toBeNull();
    expect(await procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: "+5219990009999", body: "5", ahora: min(1) })).toBeNull();
    expect(e.ciclo.filasEncuesta()[0]?.estado).toBe("enviada");
  });

  it("una calificacion de otra organizacion no toca la encuesta", async () => {
    const e = await enviada();
    expect(await procesarMensajeDeEncuesta(e.deps, { organizationId: randomUUID(), phone: "+5219991230001", body: "5", ahora: min(1) })).toBeNull();
  });
});

describe("recordatorios de pedidos sin aceptar", () => {
  function sesionConDedupe() {
    const vistas = new Set<string>();
    const emisiones: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (/select core\.emit_notification/.test(sql)) {
        const clave = String((p ?? [])[10]);
        emisiones.push(p ?? []);
        if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
        vistas.add(clave);
      }
      return original(sql, p);
    }) as typeof session.query;
    return { session, emisiones };
  }

  async function escenario(edades: number[]) {
    const m = montar();
    const ids: string[] = [];
    let n = 100;
    for (const edad of edades) {
      const o = await m.pedido({ customerPhone: `99900${n}` });
      m.ciclo.sembrarPendiente(o.id, { organizationId: m.org, propertyId: o.propertyId, orderNumber: n }, new Date(T0.getTime() - edad * 60_000));
      ids.push(o.id);
      n += 1;
    }
    return { ...m, ids };
  }

  it("avisa al gerente (staff) del pedido que lleva mas de N minutos; con 12 min es el recordatorio 1 y NO escala", async () => {
    const e = await escenario([12]);
    const { session, emisiones } = sesionConDedupe();
    const r = await barrerRecordatorios({ ...e.deps, db: session }, T0);
    expect(r).toMatchObject({ disponible: true, candidatos: 1, emitidas: 1, escaladas: 0, errores: 0 });
    const p = emisiones[0]!;
    expect(p[2]).toBe("restaurantes.pedido.recordatorio_sin_aceptar");
    expect(p[10]).toBe(`restaurantes.pedido.recordatorio_sin_aceptar:${e.ids[0]}:1`);
    expect(p[11]).toEqual(["staff"]);
    expect(String(p[6])).toContain("12 minutos");
    expect(String(p[6])).not.toMatch(/\d{10}/); // sin PII
  });

  it("el ultimo recordatorio se escala tambien a owner/admin (critico)", async () => {
    const e = await escenario([35]);
    const { session, emisiones } = sesionConDedupe();
    const r = await barrerRecordatorios({ ...e.deps, db: session }, T0);
    expect(r).toMatchObject({ emitidas: 1, escaladas: 1 });
    const escalado = emisiones.find((p) => p[2] === "restaurantes.pedido.escalado_sin_aceptar")!;
    expect(escalado[4]).toBe("critica");
    expect(escalado[11] ?? []).toEqual([]); // solo owner/admin: sin roles de vertical
  });

  it("idempotente: dos ticks seguidos no repiten; un tick 10 min despues emite el siguiente numero", async () => {
    const e = await escenario([12]);
    const { session } = sesionConDedupe();
    await barrerRecordatorios({ ...e.deps, db: session }, T0);
    expect(await barrerRecordatorios({ ...e.deps, db: session }, T0)).toMatchObject({ emitidas: 0, sinNuevas: 1 });
    expect(await barrerRecordatorios({ ...e.deps, db: session }, min(10))).toMatchObject({ emitidas: 1 });
  });

  it("no avisa de lo que aun no cumple N ni de lo ya aceptado; respeta la config por sucursal", async () => {
    const e = await escenario([5, 12]);
    const { session } = sesionConDedupe();
    expect(await barrerRecordatorios({ ...e.deps, db: session }, T0)).toMatchObject({ candidatos: 1 });
    await aceptarPedido(e.deps, { organizationId: e.org, orderId: e.ids[1]! });
    expect(await barrerRecordatorios({ ...e.deps, db: session }, T0)).toMatchObject({ candidatos: 0 });
    // N = 3 min: ahora si entra el de 5 min
    const o = await e.fixture.repo.findOrderById(e.org, e.ids[0]!);
    await e.ciclo.guardarConfigRecordatorio(e.org, o!.propertyId, { habilitado: true, primeroMin: 3, repetirMin: 5, maximo: 2 });
    expect(await barrerRecordatorios({ ...e.deps, db: session }, T0)).toMatchObject({ candidatos: 1 });
    await e.ciclo.guardarConfigRecordatorio(e.org, o!.propertyId, { habilitado: false, primeroMin: 3, repetirMin: 5, maximo: 2 });
    expect(await barrerRecordatorios({ ...e.deps, db: session }, T0)).toMatchObject({ candidatos: 0 });
  });

  it("base sin migrar: disponible false", async () => {
    const e = await escenario([12]);
    e.ciclo.migrado = false;
    const { session } = sesionConDedupe();
    expect(await barrerRecordatorios({ ...e.deps, db: session }, T0)).toMatchObject({ disponible: false, candidatos: 0 });
  });
});
