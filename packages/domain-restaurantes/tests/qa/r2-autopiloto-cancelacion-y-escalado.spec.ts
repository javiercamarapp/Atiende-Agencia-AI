// QA R2 -- autopiloto: caos-02 (cancelar/rechazar desde "Por aprobar" corta la comanda pendiente del POS) y automatizacion-10 (una alerta de aprobacion vencida
// que falla por un error transitorio se reintenta en el siguiente tick en vez de perderse con la marca ya confirmada).
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresAutopilotoRepository, InMemoryAutopilotoRepository, escalarSolicitudesVencidas, resolverSolicitudAprobacion, retenerPedidoGrande } from "../../src/autopiloto/index.ts";
import type { AutopilotoServicioDeps, PedidoMemoria } from "../../src/autopiloto/index.ts";
import { createOrder } from "../../src/orders.ts";
import type { Order } from "../../src/types.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

/** Sesion falsa de notificaciones: `fallos` = SQLSTATE a lanzar en las primeras emisiones (antes de aceptar). */
class SesionFalsa implements TenantDbSession {
  readonly emitidas: { evento: string; clave: string }[] = [];
  intentos = 0;
  readonly fallos: string[] = [];
  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (/core\.emit_notification/.test(sql)) {
      this.intentos += 1;
      const codigo = this.fallos.shift();
      if (codigo) throw Object.assign(new Error("fallo simulado"), { code: codigo });
      const p = params ?? [];
      this.emitidas.push({ evento: String(p[2]), clave: String(p[10]) });
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
  const cortadas: Order[] = [];
  const deps: AutopilotoServicioDeps = { auto, repo: fixture.repo, db, encolarComandas: async () => undefined, cortarComandaCancelado: async (o) => void cortadas.push(o) };
  async function pedidoPorAprobar() {
    const creado = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9990001111", customerAddress: "Calle 80 #30",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", paymentMethod: "efectivo",
    });
    const mem: PedidoMemoria = { id: creado.id, organizationId: creado.organizationId, propertyId: creado.propertyId, status: "pending", total: creado.total, clienteNombre: "Deb", telefono: creado.customerPhone, canal: "domicilio", numero: 1, renglones: [{ nombre: "Coca-Cola", cantidad: 2 }] };
    auto.pedidos.set(creado.id, mem);
    const ret = await retenerPedidoGrande(deps, { organizationId: creado.organizationId, orderId: creado.id, detalle: {} });
    if (ret.estado !== "por_aprobar") throw new Error("esperaba por_aprobar");
    return { order: creado, mem, solicitudId: ret.solicitudId };
  }
  return { fixture, auto, db, deps, cortadas, pedidoPorAprobar };
}

describe("caos-02: cancelar o rechazar desde Por aprobar corta la comanda pendiente del POS", () => {
  it("rechazar un pedido grande (queda cancelado) corta su comanda, UNA vez", async () => {
    const t = await montar();
    const { order, solicitudId } = await t.pedidoPorAprobar();
    const r = await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId, decision: "rechazar", motivo: "cliente_desistio" });
    expect(r?.efectos).toContain("comanda_cortada");
    expect(t.cortadas.map((o) => o.id)).toEqual([order.id]);
    // Doble clic: no se repite.
    await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId, decision: "rechazar", motivo: "cliente_desistio" });
    expect(t.cortadas).toHaveLength(1);
  });

  it("aprobar NO corta nada", async () => {
    const t = await montar();
    const { order, solicitudId } = await t.pedidoPorAprobar();
    await resolverSolicitudAprobacion(t.deps, { organizationId: order.organizationId, solicitudId, decision: "aprobar" });
    expect(t.cortadas).toHaveLength(0);
  });

  it("un fallo del corte nunca revierte la decision ya tomada", async () => {
    const t = await montar();
    const deps = { ...t.deps, cortarComandaCancelado: async () => { throw new Error("POS caido"); } };
    const { order, mem, solicitudId } = await t.pedidoPorAprobar();
    const r = await resolverSolicitudAprobacion(deps, { organizationId: order.organizationId, solicitudId, decision: "rechazar", motivo: "otro" });
    expect(r?.resultado.aplicado).toBe(true);
    expect(mem.status).toBe("cancelado");
    expect(r?.efectos).not.toContain("comanda_cortada");
  });
});

describe("automatizacion-10: la alerta de aprobacion vencida que falla se reintenta", () => {
  const inicio = new Date("2026-10-04T12:00:00Z");
  const minutos = (n: number) => new Date(inicio.getTime() + n * 60_000);

  it("un SQLSTATE transitorio (55P03) LANZA para que la transaccion de la unidad revierta la marca y el siguiente tick reintente", async () => {
    const t = await montar();
    t.auto.ahora = () => inicio;
    await t.pedidoPorAprobar();
    t.db.fallos.push("55P03");
    await expect(escalarSolicitudesVencidas(t.deps, minutos(11))).rejects.toThrow(/55P03/);
    // Simula el rollback del tick: la base deja la solicitud sin marcar; el segundo tick vuelve a intentar y ahora si emite.
    for (const s of (t.auto as unknown as { solicitudes: { escaladaAt: Date | null }[] }).solicitudes) s.escaladaAt = null;
    const r = await escalarSolicitudesVencidas(t.deps, minutos(12));
    expect(r.escaladas).toBe(1);
    expect(t.db.intentos).toBe(3); // 1 aviso de pedido grande + 1 intento fallido + 1 reintento
    expect(t.db.emitidas.filter((e) => e.evento === "restaurantes.aprobacion.vencida")).toHaveLength(1);
  });

  it("un error NO transitorio no bloquea el barrido (se registra y se sigue): reintentarlo para siempre lo atascaria", async () => {
    const t = await montar();
    t.auto.ahora = () => inicio;
    await t.pedidoPorAprobar();
    t.db.fallos.push("22023");
    await expect(escalarSolicitudesVencidas(t.deps, minutos(11))).resolves.toMatchObject({ disponible: true, escaladas: 1 });
  });
});

describe("caos-09: cancelar un pedido que ya salio avisa al cliente que no se pudo (no se vuelve 'mantener' en silencio)", () => {
  it("la solicitud se cierra como mantener, SI se aplica (aplicado) y el cliente recibe UN aviso 'no se pudo cancelar'; el doble clic no repite", async () => {
    const t = await montar();
    const creado = await createOrder(t.fixture.repo, {
      organizationId: t.fixture.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9990001111", customerAddress: "Calle 80 #30",
      items: [{ productId: t.fixture.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", paymentMethod: "efectivo",
    });
    const enCamino = (await t.fixture.repo.updateOrderStatus(creado.organizationId, creado.id, "pending", "en_camino")) ?? creado;
    t.auto.pedidos.set(creado.id, { id: creado.id, organizationId: creado.organizationId, propertyId: creado.propertyId, status: "en_camino", total: creado.total, clienteNombre: "Deb", telefono: creado.customerPhone, canal: "domicilio", numero: 1, renglones: [] });
    const s = await t.auto.crearSolicitud(creado.organizationId, creado.propertyId, "cancelacion", creado.id, { origen: "cliente" });
    expect(enCamino.status).toBe("en_camino");
    const input = { organizationId: creado.organizationId, solicitudId: s.solicitudId!, decision: "cancelar" as const, motivo: "cliente_desistio" as const };
    const r = await resolverSolicitudAprobacion(t.deps, input);
    expect(r?.resultado).toMatchObject({ aplicado: true, decision: "mantener", estadoPedido: "en_camino", motivo: "no_cancelable_en_camino" });
    expect(r?.efectos).toContain("aviso_cliente_cancelacion_no_posible");
    expect(t.cortadas).toHaveLength(0);
    const avisos = () => t.fixture.repo.getOutbox().filter((o) => o.eventType === "order.cancelacion_no_posible");
    expect(avisos()).toHaveLength(1);
    const otra = await resolverSolicitudAprobacion(t.deps, input);
    expect(otra?.resultado.aplicado).toBe(false);
    expect(otra?.efectos).toEqual([]);
    expect(avisos()).toHaveLength(1);
  });
});

describe("compatibilidad: PostgresAutopilotoRepository.resolverSolicitud con y sin la columna motivo_resolucion de la 073", () => {
  const fila = { aplicado: true, tipo: "cancelacion", decision: "mantener", order_id: "o1", property_id: "p1", estado_pedido: "en_camino", codigo_descuento: null, reposicion_order_id: null };
  const sesion = (row: Record<string, unknown>): TenantDbSession => ({ async query<T>() { return { rows: [row as T] }; }, async exec() {} });
  it("contra la 079 lee el motivo; contra la 050 original (sin la columna) lo deja en null y no falla", async () => {
    const nueva = await new PostgresAutopilotoRepository(sesion({ ...fila, motivo_resolucion: "no_cancelable_en_camino" })).resolverSolicitud("org", "s", "cancelar", { motivo: "otro" });
    expect(nueva).toMatchObject({ aplicado: true, decision: "mantener", motivo: "no_cancelable_en_camino" });
    const vieja = await new PostgresAutopilotoRepository(sesion(fila)).resolverSolicitud("org", "s", "cancelar", { motivo: "otro" });
    expect(vieja).toMatchObject({ aplicado: true, motivo: null });
  });
});
