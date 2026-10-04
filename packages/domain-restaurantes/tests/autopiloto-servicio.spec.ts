// Autopiloto (repositorio en memoria + reloj controlado): pedido grande por_aprobar sin comanda, aprobar/rechazar con un solo efecto,
// cancelacion pedida por el cliente, regreso del handoff, avance desde el POS, limpieza por tiempo, agotado por hoy en la zona de la sucursal
// y confirmacion de voz/web. La semantica real de SQL (RLS, bloqueos, concurrencia) la prueba scripts/verify-restaurantes-autopiloto.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { describe, expect, it } from "vitest";
import {
  AutopilotoAccesoError, AutopilotoValidacionError, InMemoryAutopilotoRepository, aplicarEstadosSinClic, avanzarDesdePos, confirmarPedidoRecibido, destinoDesdeEstadoPos,
  devolverHandoffsVencidos, escalarSolicitudesVencidas, reponerAgotadosDelDia, resolverSolicitudAprobacion, retenerPedidoGrande, solicitarCancelacion,
  registrarQuejaConPedido, estimarTiempoSucursal,
} from "../src/autopiloto/index.ts";
import type { AutopilotoServicioDeps, PedidoMemoria } from "../src/autopiloto/index.ts";
import type { Order } from "../src/types.ts";
import type { SoftRestaurantPort } from "../src/softrestaurant/types.ts";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

/** Sesion falsa: registra cada emision de notificacion (core.emit_notification) y responde "1 destinatario". */
class SesionFalsa implements TenantDbSession {
  readonly emisiones: { evento: string; clave: string }[] = [];
  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (/core\.emit_notification/.test(sql)) {
      const p = params ?? [];
      const clave = String(p[10]);
      // Dedupe real de la base: misma clave = no vuelve a emitir.
      if (this.emisiones.some((e) => e.clave === clave)) return { rows: [{ emit_notification: 0 } as T] };
      this.emisiones.push({ evento: String(p[2]), clave });
      return { rows: [{ emit_notification: 1 } as T] };
    }
    return { rows: [] };
  }
  async exec(): Promise<void> {}
}

async function montar() {
  const fixture = buildRestaurantFixture();
  fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PNID-1");
  const auto = new InMemoryAutopilotoRepository();
  const db = new SesionFalsa();
  const comandas: Order[][] = [];
  const deps: AutopilotoServicioDeps = { auto, repo: fixture.repo, db, encolarComandas: async (o) => void comandas.push([...o]) };
  const propertyId = (await fixture.repo.findBranch(fixture.organizationId, { slug: "fco-montejo" }))!.propertyId;

  async function pedido(opts: { status?: PedidoMemoria["status"]; source?: "web" | "voice" | "whatsapp" | "admin"; telefono?: string; canal?: "domicilio" | "recoger"; programadoPara?: Date | null } = {}): Promise<{ order: Order; mem: PedidoMemoria }> {
    const creado = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: opts.telefono ?? "9990001111", customerAddress: "Calle 80 #30",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }], source: opts.source ?? "whatsapp", paymentMethod: "efectivo",
    });
    // El repositorio principal es el que lee el servicio (findLatestOrderByPhone/findOrderById): se alinea con el estado simulado.
    const status = opts.status ?? "pending";
    const order = status === "pending" ? creado : ((await fixture.repo.updateOrderStatus(creado.organizationId, creado.id, "pending", status)) ?? creado);
    const mem: PedidoMemoria = {
      id: order.id, organizationId: order.organizationId, propertyId: order.propertyId, status: opts.status ?? "pending", total: order.total, clienteNombre: "Deb",
      telefono: order.customerPhone, canal: opts.canal ?? "domicilio", numero: 101, renglones: [{ nombre: "Coca-Cola", cantidad: 2 }, { nombre: "Agua", cantidad: 1 }], programadoPara: opts.programadoPara ?? null,
    };
    auto.pedidos.set(order.id, mem);
    return { order, mem };
  }
  const outbox = (tipo?: string) => fixture.repo.getOutbox().filter((r) => !tipo || r.eventType === tipo);
  return { fixture, auto, db, deps, comandas, pedido, outbox, propertyId };
}

describe("pedido grande: por_aprobar sin comanda, aprobacion con un clic", () => {
  it("retener deja el pedido por_aprobar, SIN comanda, con una solicitud y UN aviso in-app", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    const r = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: { total: order.total, motivo: "monto" } });
    expect(r).toMatchObject({ estado: "por_aprobar", creada: true });
    expect(mem.status).toBe("por_aprobar");
    expect(t.comandas).toHaveLength(0);
    expect(t.db.emisiones.filter((e) => e.evento === "restaurantes.aprobacion.pedido_grande")).toHaveLength(1);
    // Reintento idempotente: misma solicitud, sin segundo aviso.
    const r2 = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    expect(r2).toMatchObject({ estado: "por_aprobar", creada: false });
    expect(t.db.emisiones).toHaveLength(1);
    expect(t.auto.eventos.filter((e) => e.orderId === order.id && e.hacia === "por_aprobar")).toHaveLength(1);
  });

  it("aprobar: pending, la comanda se encola UNA vez y sale UN WhatsApp 'confirmado'", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    const ret = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    const r = await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "aprobar" });
    expect(r?.resultado.aplicado).toBe(true);
    expect(mem.status).toBe("pending");
    expect(t.comandas).toHaveLength(1);
    expect(t.outbox("order.aprobado")).toHaveLength(1);
    const cuerpo = t.outbox("order.aprobado")[0]!.payload as { body: string; to: string; template: { name: string; params: string[] } };
    expect(cuerpo.body).toMatch(/confirmado por la sucursal/);
    expect(cuerpo.to).toBe("+529990001111");
    expect(cuerpo.template.name).toBe("pedido_aprobado");
    expect(cuerpo.template.params).toHaveLength(3);
  });

  it("doble clic: el segundo no repite comanda ni aviso", async () => {
    const t = await montar();
    const { order } = await t.pedido();
    const ret = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    const a = await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "aprobar" });
    const b = await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "aprobar" });
    expect(a?.efectos.length).toBeGreaterThan(0);
    expect(b?.resultado.aplicado).toBe(false);
    expect(b?.efectos).toEqual([]);
    expect(t.comandas).toHaveLength(1);
    expect(t.outbox("order.aprobado")).toHaveLength(1);
  });

  it("aprobar un pedido grande programado para mas tarde lo deja programado, sin comanda ahora", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido({ programadoPara: new Date(Date.now() + 86_400_000) });
    const ret = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "aprobar" });
    expect(mem.status).toBe("programado");
    expect(t.comandas).toHaveLength(0);
    expect(t.outbox("order.aprobado")[0]!.payload).toMatchObject({ body: expect.stringContaining("para la hora indicada") });
  });

  it("rechazar: cancelado, aviso honesto UNA vez y un callback para que una persona llame", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    const ret = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "rechazar", motivo: "fuera_de_zona" });
    expect(mem.status).toBe("cancelado");
    expect(t.outbox("order.no_confirmado")).toHaveLength(1);
    expect((t.outbox("order.no_confirmado")[0]!.payload as { body: string }).body).toMatch(/no pudo confirmar su pedido/);
    expect(t.comandas).toHaveLength(0);
    expect(t.auto.eventos.find((e) => e.orderId === order.id && e.hacia === "cancelado")?.motivo).toBe("fuera_de_zona");
    await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "rechazar", motivo: "fuera_de_zona" });
    expect(t.outbox("order.no_confirmado")).toHaveLength(1);
  });

  it("rechazar sin motivo de la lista cerrada se rechaza y el pedido sigue por_aprobar", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    const ret = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    await expect(resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "rechazar", motivo: "porque si" })).rejects.toBeInstanceOf(AutopilotoValidacionError);
    expect(mem.status).toBe("por_aprobar");
  });

  it("sin alcance (otra organizacion o rol) la resolucion es 403 y no cambia nada", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    const ret = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    t.auto.actorConAlcance = false;
    await expect(resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: ret.solicitudId, decision: "aprobar" })).rejects.toBeInstanceOf(AutopilotoAccesoError);
    expect(mem.status).toBe("por_aprobar");
  });

  it("NUNCA se autoaprueba: sin respuesta solo se escala al owner, una vez, y el pedido sigue por_aprobar", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    const inicio = new Date("2026-10-04T12:00:00Z");
    t.auto.ahora = () => inicio;
    const ret = await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    expect((await escalarSolicitudesVencidas(t.deps, new Date(inicio.getTime() + 5 * 60_000))).escaladas).toBe(0);
    expect((await escalarSolicitudesVencidas(t.deps, new Date(inicio.getTime() + 11 * 60_000))).escaladas).toBe(1);
    expect((await escalarSolicitudesVencidas(t.deps, new Date(inicio.getTime() + 60 * 60_000))).escaladas).toBe(0);
    expect(t.db.emisiones.filter((e) => e.evento === "restaurantes.aprobacion.vencida")).toHaveLength(1);
    expect(mem.status).toBe("por_aprobar");
    expect(t.comandas).toHaveLength(0);
  });

  it("los minutos de escalado salen de la configuracion de la sucursal", async () => {
    const t = await montar();
    const { order } = await t.pedido();
    const inicio = new Date("2026-10-04T12:00:00Z");
    t.auto.ahora = () => inicio;
    t.auto.configs.set(order.propertyId, { ...(await t.auto.leerConfig("", order.propertyId)).valor, aprobacionMinutos: 3, configurada: true });
    await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    expect((await escalarSolicitudesVencidas(t.deps, new Date(inicio.getTime() + 4 * 60_000))).escaladas).toBe(1);
  });

  it("base SIN migrar: retener devuelve no_disponible y resolver devuelve null (el flujo anterior sigue)", async () => {
    const t = await montar();
    const { order } = await t.pedido();
    t.auto.disponible = false;
    expect(await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} })).toEqual({ estado: "no_disponible" });
    expect(await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: "x", decision: "aprobar" })).toBeNull();
    expect((await escalarSolicitudesVencidas(t.deps, new Date())).disponible).toBe(false);
  });
});

describe("cancelacion pedida por el cliente", () => {
  const desde = new Date(Date.now() - 12 * 3_600_000).toISOString();

  it("pending sin comanda y politica encendida: cancelacion automatica con aviso y sin solicitud", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    t.auto.configs.set(order.propertyId, { ...(await t.auto.leerConfig("", order.propertyId)).valor, cancelacionAuto: true, configurada: true });
    const r = await solicitarCancelacion(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde });
    expect(r.resultado).toBe("cancelado");
    expect(mem.status).toBe("cancelado");
    expect(t.outbox("order.status.cancelado")).toHaveLength(1);
    expect(t.db.emisiones.some((e) => e.evento === "restaurantes.pedido.cancelado_por_cliente")).toBe(true);
    // Idempotente: el pedido ya no esta activo (el repositorio principal refleja la cancelacion de la base).
    await t.fixture.repo.updateOrderStatus(order.organizationId, order.id, "pending", "cancelado");
    expect((await solicitarCancelacion(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde })).resultado).toBe("sin_pedido_activo");
  });

  it("politica APAGADA (por omision): crea solicitud, NO cancela", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    const r = await solicitarCancelacion(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde });
    expect(r.resultado).toBe("solicitud_creada");
    expect(mem.status).toBe("pending");
    expect(r.mensaje).toMatch(/sin prometerlo/);
    expect(t.db.emisiones.some((e) => e.evento === "restaurantes.aprobacion.cancelacion")).toBe(true);
  });

  it("pedido en preparacion: solicitud aunque la politica este encendida; no promete cancelar", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido({ status: "preparando" });
    t.auto.configs.set(order.propertyId, { ...(await t.auto.leerConfig("", order.propertyId)).valor, cancelacionAuto: true, configurada: true });
    const r = await solicitarCancelacion(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde });
    expect(r.resultado).toBe("solicitud_creada");
    expect(mem.status).toBe("preparando");
    expect(r.mensaje).not.toMatch(/cancelado\./);
  });

  it("pedido por_aprobar: no promete ni crea solicitud; devuelve no_disponible para que el turno escale a una persona", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido({ status: "por_aprobar" });
    const r = await solicitarCancelacion(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde });
    expect(r.resultado).toBe("no_disponible");
    expect(mem.status).toBe("por_aprobar");
  });

  it("pedido pending con comanda ya en el POS: solicitud, no cancelacion automatica", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido();
    mem.comanda = { estado: "confirmada", folio: "F1" };
    t.auto.configs.set(order.propertyId, { ...(await t.auto.leerConfig("", order.propertyId)).valor, cancelacionAuto: true, configurada: true });
    expect((await solicitarCancelacion(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde })).resultado).toBe("solicitud_creada");
    expect(mem.status).toBe("pending");
  });

  it("el staff cancela con motivo: aviso al cliente UNA vez; si ya salio, queda 'mantener' y se le explica", async () => {
    const t = await montar();
    const a = await t.pedido({ status: "preparando", telefono: "9990002222" });
    const sa = await solicitarCancelacion(t.deps, { organizationId: a.order.organizationId, customerPhone: a.order.customerPhone, desdeIso: desde });
    if (sa.resultado !== "solicitud_creada" || !sa.solicitudId) throw new Error("esperaba solicitud");
    await resolverSolicitudAprobacion(t.deps, { organizationId: a.order.organizationId, solicitudId: sa.solicitudId, decision: "cancelar", motivo: "cliente_desistio" });
    expect(a.mem.status).toBe("cancelado");
    expect(t.outbox("order.status.cancelado")).toHaveLength(1);
    const b = await t.pedido({ status: "en_camino", telefono: "9990003333" });
    const sb = await solicitarCancelacion(t.deps, { organizationId: b.order.organizationId, customerPhone: b.order.customerPhone, desdeIso: desde });
    if (sb.resultado !== "solicitud_creada" || !sb.solicitudId) throw new Error("esperaba solicitud");
    const r = await resolverSolicitudAprobacion(t.deps, { organizationId: b.order.organizationId, solicitudId: sb.solicitudId, decision: "cancelar", motivo: "cliente_desistio" });
    expect(r?.resultado.decision).toBe("mantener");
    expect(b.mem.status).toBe("en_camino");
  });

  it("el pedido sale del telefono del contexto: otro telefono no cancela el pedido ajeno", async () => {
    const t = await montar();
    const { order, mem } = await t.pedido({ telefono: "9990004444" });
    const r = await solicitarCancelacion(t.deps, { organizationId: order.organizationId, customerPhone: "9991230000", desdeIso: desde });
    expect(r.resultado).toBe("sin_pedido_activo");
    expect(mem.status).toBe("pending");
  });
});

describe("queja con compensacion: nunca automatica", () => {
  const desde = new Date(Date.now() - 12 * 3_600_000).toISOString();

  it("la queja se liga al ultimo pedido entregado y pide decision (una vez)", async () => {
    const t = await montar();
    const { order } = await t.pedido({ status: "entregado" });
    const a = await registrarQuejaConPedido(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde, subtipo: "faltante" });
    const b = await registrarQuejaConPedido(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde, subtipo: "faltante" });
    expect(a.estado).toBe("creada");
    expect(b.estado).toBe("existente");
    expect(t.db.emisiones.filter((e) => e.evento === "restaurantes.aprobacion.compensacion")).toHaveLength(1);
  });

  it("'Sin compensacion' avisa al cliente; no crea pedido ni codigo", async () => {
    const t = await montar();
    const { order } = await t.pedido({ status: "entregado" });
    const q = await registrarQuejaConPedido(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde, subtipo: "frio" });
    await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: q.solicitudId!, decision: "sin_compensacion" });
    expect(t.outbox("order.compensacion")).toHaveLength(1);
    expect([...t.auto.pedidos.values()].filter((p) => p.total === 0)).toHaveLength(0);
  });

  it("'Reponer producto' crea un pedido de $0 a cocina y avisa una vez", async () => {
    const t = await montar();
    const { order } = await t.pedido({ status: "entregado" });
    const q = await registrarQuejaConPedido(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde, subtipo: "faltante" });
    const r = await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: q.solicitudId!, decision: "reponer_producto", indices: [1] });
    expect(r?.resultado.reposicionOrderId).toBeTruthy();
    const repo = t.auto.pedidos.get(r!.resultado.reposicionOrderId!)!;
    expect(repo.total).toBe(0);
    expect(repo.renglones).toEqual([{ nombre: "Agua", cantidad: 1 }]);
    expect(t.outbox("order.compensacion")).toHaveLength(1);
    // Doble clic: sin segundo pedido ni segundo aviso.
    await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: q.solicitudId!, decision: "reponer_producto", indices: [1] });
    expect([...t.auto.pedidos.values()].filter((p) => p.total === 0)).toHaveLength(1);
    expect(t.outbox("order.compensacion")).toHaveLength(1);
  });

  it("'Reponer' con renglones invalidos se rechaza", async () => {
    const t = await montar();
    const { order } = await t.pedido({ status: "entregado" });
    const q = await registrarQuejaConPedido(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde, subtipo: "faltante" });
    await expect(resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: q.solicitudId!, decision: "reponer_producto", indices: [9] })).rejects.toBeInstanceOf(AutopilotoValidacionError);
  });

  it("'Descuento en el proximo pedido': codigo de un solo uso, con tope por sucursal; el mensaje lleva el codigo", async () => {
    const t = await montar();
    const { order } = await t.pedido({ status: "entregado" });
    const q = await registrarQuejaConPedido(t.deps, { organizationId: order.organizationId, customerPhone: order.customerPhone, desdeIso: desde, subtipo: "tarde" });
    await expect(resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: q.solicitudId!, decision: "descuento_proximo", valor: 50 })).rejects.toBeInstanceOf(AutopilotoValidacionError);
    const r = await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId: q.solicitudId!, decision: "descuento_proximo", valor: 15 });
    expect(r?.resultado.codigoDescuento).toMatch(/^GRACIAS-/);
    expect((t.outbox("order.compensacion")[0]!.payload as { body: string }).body).toContain(r!.resultado.codigoDescuento!);
    expect((t.outbox("order.compensacion")[0]!.payload as { body: string }).body).toContain("un solo uso");
  });

  it("una queja sin pedido entregado no inventa nada", async () => {
    const t = await montar();
    const r = await registrarQuejaConPedido(t.deps, { organizationId: t.fixture.organizationId, customerPhone: "9990009999", desdeIso: desde, subtipo: "otro" });
    expect(r.estado).toBe("sin_pedido");
  });
});

describe("regreso automatico del handoff", () => {
  const ahora = new Date("2026-10-04T18:00:00Z");
  function handoff(t: Awaited<ReturnType<typeof montar>>, extra: Partial<Parameters<typeof t.auto.handoffs.push>[0]> = {}) {
    t.auto.handoffs.push({
      id: `h-${t.auto.handoffs.length + 1}`, organizationId: t.fixture.organizationId, propertyId: t.propertyId, conversationId: randomUUID(), telefono: "9995550001", estado: "tomada",
      tomadaAt: new Date(ahora.getTime() - 20 * 60_000), ultimaHumanaAt: null, ultimoClienteAt: new Date(ahora.getTime() - 10 * 60_000), ...extra,
    });
  }

  it("a los 15 minutos (por omision) sin respuesta humana vuelve al agente UNA sola vez, con la frase fija", async () => {
    const t = await montar();
    handoff(t);
    expect((await devolverHandoffsVencidos(t.deps, ahora)).devueltos).toBe(1);
    expect((await devolverHandoffsVencidos(t.deps, ahora)).devueltos).toBe(0);
    expect(t.auto.mensajesRegreso).toHaveLength(1);
    expect(t.db.emisiones.filter((e) => e.evento === "restaurantes.handoff.devuelto_automatico")).toHaveLength(1);
  });

  it("con respuesta humana reciente no se devuelve", async () => {
    const t = await montar();
    handoff(t, { ultimaHumanaAt: new Date(ahora.getTime() - 5 * 60_000) });
    expect((await devolverHandoffsVencidos(t.deps, ahora)).devueltos).toBe(0);
  });

  it("con un pedido por aprobar del mismo telefono no se devuelve", async () => {
    const t = await montar();
    const { order } = await t.pedido({ telefono: "9995550001" });
    await retenerPedidoGrande(t.deps, { organizationId: order.organizationId, orderId: order.id, detalle: {} });
    handoff(t, { telefono: "9995550001" });
    expect((await devolverHandoffsVencidos(t.deps, ahora)).devueltos).toBe(0);
  });

  it("fuera de la ventana de 24 h se devuelve sin mandar la frase", async () => {
    const t = await montar();
    handoff(t, { ultimoClienteAt: new Date(ahora.getTime() - 30 * 3_600_000) });
    expect((await devolverHandoffsVencidos(t.deps, ahora)).devueltos).toBe(1);
    expect(t.auto.mensajesRegreso).toHaveLength(0);
  });

  it("los minutos por sucursal mandan", async () => {
    const t = await montar();
    t.auto.configs.set(t.propertyId, { ...(await t.auto.leerConfig("", t.propertyId)).valor, handoffRegresoMinutos: 60, configurada: true });
    handoff(t);
    expect((await devolverHandoffsVencidos(t.deps, ahora)).devueltos).toBe(0);
  });
});

describe("avance de estados sin clic", () => {
  const ahora = new Date("2026-10-04T18:00:00Z");

  it("entregado -> completado a las 6 h, sin mensaje al cliente", async () => {
    const t = await montar();
    const { mem } = await t.pedido({ status: "entregado" });
    mem.entregadoAt = new Date(ahora.getTime() - 7 * 3_600_000);
    const r = await aplicarEstadosSinClic(t.deps, ahora);
    expect(r.aplicados).toBe(1);
    expect(mem.status).toBe("completado");
    expect(t.outbox()).toHaveLength(0);
    expect(t.auto.eventos.find((e) => e.hacia === "completado")).toMatchObject({ actor: "sistema", motivo: "limpieza_entregado" });
  });

  it("listo_para_recoger -> no_recogido a los X minutos, con aviso al staff y SIN mensaje al cliente", async () => {
    const t = await montar();
    const { mem } = await t.pedido({ status: "listo_para_recoger", canal: "recoger" });
    mem.horaRecogida = new Date(ahora.getTime() - 70 * 60_000);
    await aplicarEstadosSinClic(t.deps, ahora);
    expect(mem.status).toBe("no_recogido");
    expect(t.db.emisiones.some((e) => e.evento === "restaurantes.pedido.no_recogido")).toBe(true);
    expect(t.outbox()).toHaveLength(0);
    // A los 59 minutos todavia no.
    const t2 = await montar();
    const p2 = await t2.pedido({ status: "listo_para_recoger", canal: "recoger" });
    p2.mem.horaRecogida = new Date(ahora.getTime() - 59 * 60_000);
    await aplicarEstadosSinClic(t2.deps, ahora);
    expect(p2.mem.status).toBe("listo_para_recoger");
  });

  it("aceptacion automatica: solo con la bandera y la comanda capturada; avisa al cliente", async () => {
    const t = await montar();
    const { mem, order } = await t.pedido();
    mem.comanda = { estado: "capturada_manual", folio: null };
    await aplicarEstadosSinClic(t.deps, ahora);
    expect(mem.status).toBe("pending");
    t.auto.configs.set(order.propertyId, { ...(await t.auto.leerConfig("", order.propertyId)).valor, aceptacionAuto: true, configurada: true });
    await aplicarEstadosSinClic(t.deps, ahora);
    expect(mem.status).toBe("preparando");
    expect(t.outbox("order.status.preparando")).toHaveLength(1);
    // Segunda corrida: nada que hacer, sin segundo aviso.
    await aplicarEstadosSinClic(t.deps, ahora);
    expect(t.outbox("order.status.preparando")).toHaveLength(1);
  });

  it("jamas toca pedidos por_aprobar ni cancelados", async () => {
    const t = await montar();
    const a = await t.pedido({ status: "por_aprobar" });
    const b = await t.pedido({ status: "cancelado", telefono: "9990007777" });
    t.auto.configs.set(a.order.propertyId, { ...(await t.auto.leerConfig("", a.order.propertyId)).valor, aceptacionAuto: true, configurada: true });
    a.mem.comanda = { estado: "confirmada", folio: "F" };
    b.mem.comanda = { estado: "confirmada", folio: "F2" };
    await aplicarEstadosSinClic(t.deps, ahora);
    expect(a.mem.status).toBe("por_aprobar");
    expect(b.mem.status).toBe("cancelado");
  });

  it("la base sin migrar no rompe el tick", async () => {
    const t = await montar();
    t.auto.disponible = false;
    expect(await aplicarEstadosSinClic(t.deps, ahora)).toEqual({ disponible: false, aplicados: 0, omitidos: 0 });
  });
});

describe("avance desde el POS", () => {
  function puerto(estado: string, real = true): SoftRestaurantPort {
    return {
      esReal: real,
      syncCatalog: async () => ({ items: [] }) as never,
      crearComanda: async () => ({ status: "no_disponible", causa: "no_configurado" }) as never,
      obtenerHistorialPorTelefono: async () => [],
      obtenerEstadoComanda: async ({ folio }: { folio: string }) => ({ encontrada: true, folio, estado: estado as never, impresaEnCocina: true }),
      salud: async () => ({ ok: true, latenciaMs: 1, chequeadoEn: new Date().toISOString() }),
    } as unknown as SoftRestaurantPort;
  }
  const sucursal = () => "T1" as never;

  it("mapea los estados del POS (nunca retrocede ni cancela)", () => {
    expect(destinoDesdeEstadoPos("en_preparacion", "domicilio")).toBe("preparando");
    expect(destinoDesdeEstadoPos("lista", "recoger")).toBe("listo_para_recoger");
    expect(destinoDesdeEstadoPos("lista", "domicilio")).toBe("en_camino");
    expect(destinoDesdeEstadoPos("cancelada", "domicilio")).toBeNull();
    expect(destinoDesdeEstadoPos("abierta", "domicilio")).toBeNull();
  });

  it("en_preparacion: pending -> preparando con aviso al cliente", async () => {
    const t = await montar();
    const { mem } = await t.pedido();
    mem.comanda = { estado: "confirmada", folio: "F-1" };
    const r = await avanzarDesdePos(t.deps, puerto("en_preparacion"), sucursal);
    expect(r.avanzadas).toBe(1);
    expect(mem.status).toBe("preparando");
    expect(t.outbox("order.status.preparando")).toHaveLength(1);
    // Segunda corrida: ya esta preparando y el POS sigue en preparacion: nada.
    expect((await avanzarDesdePos(t.deps, puerto("en_preparacion"), sucursal)).avanzadas).toBe(0);
    expect(t.outbox("order.status.preparando")).toHaveLength(1);
  });

  it("lista en recoger: pending -> preparando -> listo_para_recoger (dos pasos, dos avisos distintos)", async () => {
    const t = await montar();
    const { mem } = await t.pedido({ canal: "recoger" });
    mem.comanda = { estado: "confirmada", folio: "F-2" };
    await avanzarDesdePos(t.deps, puerto("lista"), sucursal);
    expect(mem.status).toBe("listo_para_recoger");
    expect(t.auto.eventos.filter((e) => e.actor === "pos")).toHaveLength(2);
  });

  it("lista a domicilio: pasa a en_camino (segun el brief)", async () => {
    const t = await montar();
    const { mem } = await t.pedido({ status: "preparando" });
    mem.comanda = { estado: "confirmada", folio: "F-3" };
    await avanzarDesdePos(t.deps, puerto("lista"), sucursal);
    expect(mem.status).toBe("en_camino");
  });

  it("sin adaptador REAL no consulta nada: estado honesto 'requiere API de SoftRestaurant'", async () => {
    const t = await montar();
    const { mem } = await t.pedido();
    mem.comanda = { estado: "confirmada", folio: "F-4" };
    const r = await avanzarDesdePos(t.deps, puerto("en_preparacion", false), sucursal);
    expect(r).toEqual({ disponible: true, consultadas: 0, avanzadas: 0, sinAdaptadorReal: true });
    expect(mem.status).toBe("pending");
  });
});

describe("agotado solo por hoy", () => {
  it("se repone al cambiar el dia de negocio de la sucursal (Merida), no el de UTC", async () => {
    const t = await montar();
    t.auto.zonaPorSucursal.set(t.propertyId, "America/Merida");
    t.auto.agotados.push({ organizationId: t.fixture.organizationId, propertyId: t.propertyId, productId: "p1", disponible: false, agotadoHasta: "2026-03-12" });
    // 04:00Z del 12 = 22:00 del 11 en Merida: todavia es "hoy" para la sucursal.
    expect((await reponerAgotadosDelDia(t.deps, new Date("2026-03-12T04:00:00Z"))).repuestos).toBe(0);
    expect(t.auto.agotados[0]!.disponible).toBe(false);
    // 06:30Z del 12 = 00:30 del 12 en Merida: ya cambio el dia.
    expect((await reponerAgotadosDelDia(t.deps, new Date("2026-03-12T06:30:00Z"))).repuestos).toBe(1);
    expect(t.auto.agotados[0]).toMatchObject({ disponible: true, agotadoHasta: null });
    expect((await reponerAgotadosDelDia(t.deps, new Date("2026-03-12T07:30:00Z"))).repuestos).toBe(0);
  });

  it("marcar agotado exige una fecha posterior a hoy en la zona de la sucursal", async () => {
    const t = await montar();
    t.auto.zonaPorSucursal.set(t.propertyId, "America/Merida");
    t.auto.agotados.push({ organizationId: t.fixture.organizationId, propertyId: t.propertyId, productId: "p1", disponible: true, agotadoHasta: null });
    t.auto.ahora = () => new Date("2026-03-12T04:00:00Z"); // 11-mar en Merida
    await expect(t.auto.marcarAgotado(t.fixture.organizationId, t.propertyId, "p1", "2026-03-11")).rejects.toBeInstanceOf(AutopilotoValidacionError);
    expect(await t.auto.marcarAgotado(t.fixture.organizationId, t.propertyId, "p1", "2026-03-12")).toEqual({ disponible: true, aplicado: true });
  });
});

describe("confirmacion inmediata de voz y web", () => {
  it("sale una vez por pedido para voz y web; nunca para WhatsApp", async () => {
    const t = await montar();
    const voz = await t.pedido({ source: "voice", telefono: "9991110001" });
    const web = await t.pedido({ source: "web", telefono: "9991110002" });
    const wa = await t.pedido({ source: "whatsapp", telefono: "9991110003" });
    expect(await confirmarPedidoRecibido(t.fixture.repo, voz.order, "de 30 a 40 minutos", 55)).toEqual({ enviado: true });
    await confirmarPedidoRecibido(t.fixture.repo, voz.order, "de 30 a 40 minutos", 55);
    expect(await confirmarPedidoRecibido(t.fixture.repo, web.order, "de 30 a 40 minutos", 56)).toEqual({ enviado: true });
    expect(await confirmarPedidoRecibido(t.fixture.repo, wa.order, "de 30 a 40 minutos", 57)).toEqual({ enviado: false, motivo: "canal_no_aplica" });
    const filas = t.outbox("order.recibido");
    expect(filas).toHaveLength(2);
    expect((filas[0]!.payload as { body: string }).body).toMatch(/recibimos su pedido #55.*Tiempo estimado: de 30 a 40 minutos/);
    expect((filas[0]!.payload as { template: { name: string } }).template.name).toBe("pedido_recibido");
  });

  it("sin canal de WhatsApp declara el estado honesto en vez de fingir el envio", async () => {
    const t = await montar();
    const { order } = await t.pedido({ source: "voice" });
    const repoSinCanal = buildRestaurantFixture().repo;
    expect(await confirmarPedidoRecibido(repoSinCanal, order, "x", 1)).toEqual({ enviado: false, motivo: "sin_canal_whatsapp" });
  });
});

describe("tiempo prometido por sucursal", () => {
  it("con 20+ muestras usa la mediana; con menos, el texto fijo del dueno", async () => {
    const t = await montar();
    await t.fixture.repo.upsertWhatsAppAgentConfig(t.fixture.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: "Domicilio 30-45 minutos. Recoger 15-25 minutos." } as never);
    const sin = await estimarTiempoSucursal(t.deps, { organizationId: t.fixture.organizationId, propertyId: t.propertyId, canal: "domicilio", ahora: new Date() });
    expect(sin.origen).toBe("texto_fijo");
    t.auto.muestras.set(`${t.propertyId}:domicilio`, { muestras: Array.from({ length: 25 }, () => 52), abiertos: 3 });
    const con = await estimarTiempoSucursal(t.deps, { organizationId: t.fixture.organizationId, propertyId: t.propertyId, canal: "domicilio", ahora: new Date() });
    expect(con.origen).toBe("aprendido");
    expect(con.rango).toEqual({ minimo: 50, maximo: 60 });
  });
});
