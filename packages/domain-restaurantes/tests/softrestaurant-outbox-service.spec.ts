import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { MapaProductoCodigo } from "../src/softrestaurant/catalog-map.ts";
import { FakeSoftRestaurantAdapter } from "../src/softrestaurant/fake-adapter.ts";
import { InMemoryComandaOutboxStore } from "../src/softrestaurant/outbox-memory-store.ts";
import {
  crearAlertaCapturaManual,
  crearResolverSucursalPos,
  drenarComandas,
  encolarComandaParaPedido,
  llaveIdempotenciaComanda,
  type DepsComandaPos,
} from "../src/softrestaurant/outbox-service.ts";
import type { ComandaResultado, SoftRestaurantPort } from "../src/softrestaurant/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const T0 = new Date("2026-09-30T18:00:00.000Z");

async function preparar(opciones: { codigos?: boolean; sucursal?: boolean; modo?: "apagado" | "sombra" | "activo" } = {}) {
  const fx = buildRestaurantFixture();
  const order = await createOrder(fx.repo, {
    organizationId: fx.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Deb",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30 x 5 y 7, Centro",
    paymentMethod: "efectivo",
    items: [{ productId: fx.products.cocaCola, requestedQuantity: 2 }],
    source: "web",
  });
  let reloj = T0;
  const ahora = () => reloj;
  const store = new InMemoryComandaOutboxStore({ ahora });
  store.ponerModo(fx.organizationId, opciones.modo ?? "activo");
  const port = new FakeSoftRestaurantAdapter({ ahora });
  const mapa = new MapaProductoCodigo(opciones.codigos === false ? [] : [{ productId: fx.products.cocaCola, codigo: "FAKE-003" }]);
  const alertar = vi.fn(async () => undefined);
  const deps: DepsComandaPos = {
    store,
    port,
    resolverCodigos: mapa,
    resolverSucursal: crearResolverSucursalPos(opciones.sucursal === false ? {} : { [fx.propertyId]: "T2" }),
    ahora,
    alertar,
    politica: { maxIntentos: 3, baseMs: 30_000, maxMs: 900_000, leaseMs: 120_000 },
  };
  return {
    fx,
    order,
    store,
    port,
    deps,
    alertar,
    avanzar: (ms: number) => {
      reloj = new Date(reloj.getTime() + ms);
    },
    drenar: (limite = 10) =>
      drenarComandas({ port, abrirUnidad: async (fn) => fn({ store, alertar }), resolverCodigos: mapa, politica: deps.politica, ahora }, limite),
  };
}

describe("encolarComandaParaPedido: bandera", () => {
  it("APAGADO (default): no hace nada, no toca el POS, el agente no dice nada de la comanda", async () => {
    const t = await preparar({ modo: "apagado" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r).toMatchObject({ modo: "apagado", fila: null, agente: null });
    expect(t.store.todas()).toHaveLength(0);
    expect(t.port.llamadasCrear).toHaveLength(0);
  });

  it("sin la migracion (store no disponible) la bandera efectiva es apagado y el pedido sigue igual", async () => {
    const t = await preparar();
    t.store.disponible = false;
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r).toMatchObject({ modo: "apagado", agente: null });
    expect(t.port.llamadasCrear).toHaveLength(0);
  });

  it("si leer la bandera lanza, se asume apagado (nunca rompe el pedido)", async () => {
    const t = await preparar();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(t.store, "leerModo").mockRejectedValue(new Error("boom"));
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r.modo).toBe("apagado");
  });
});

describe("encolarComandaParaPedido: modo sombra", () => {
  it("encola la comanda sin enviarla en linea y sin cambiar lo que dice el agente", async () => {
    const t = await preparar({ modo: "sombra" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r).toMatchObject({ modo: "sombra", agente: null });
    expect(r.fila?.estado).toBe("pendiente");
    expect(t.port.llamadasCrear).toHaveLength(0);
  });

  it("con programarEnvio, el envio corre despues (post-respuesta) y no bloquea", async () => {
    const t = await preparar({ modo: "sombra" });
    const tareas: Array<() => Promise<void>> = [];
    const r = await encolarComandaParaPedido({ ...t.deps, programarEnvio: (f) => tareas.push(f) }, { order: t.order });
    expect(r.fila?.estado).toBe("pendiente");
    expect(t.port.llamadasCrear).toHaveLength(0);
    await tareas[0]!();
    expect(t.port.llamadasCrear).toHaveLength(1);
    expect(t.store.fila(r.fila!.id)?.estado).toBe("confirmada");
  });

  it("una falla del POS en sombra nunca llega al agente ni rompe nada", async () => {
    const t = await preparar({ modo: "sombra" });
    t.port.inyectarFalla("crearComanda", { tipo: "http_5xx" });
    const tareas: Array<() => Promise<void>> = [];
    const r = await encolarComandaParaPedido({ ...t.deps, programarEnvio: (f) => tareas.push(f) }, { order: t.order });
    await tareas[0]!();
    expect(r.agente).toBeNull();
    expect(t.store.fila(r.fila!.id)?.estado).toBe("fallida");
  });
});

describe("encolarComandaParaPedido: modo activo", () => {
  it("camino feliz: confirmada, el folio sale del POS y el agente lo dice", async () => {
    const t = await preparar();
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r.modo).toBe("activo");
    expect(r.fila?.estado).toBe("confirmada");
    expect(r.agente).toMatchObject({ estado: "confirmada", folio: r.fila!.folio });
    expect(t.port.comandas).toHaveLength(1);
    const enviada = t.port.llamadasCrear[0]!;
    expect(enviada).toMatchObject({ sucursal: "T2", tipo: "domicilio", formaPago: "efectivo", idempotencyKey: llaveIdempotenciaComanda(t.order.organizationId, t.order.id) });
    expect(enviada.items).toEqual([expect.objectContaining({ codigo: "FAKE-003", cantidad: 2, nombre: "Coca-Cola" })]);
    expect(enviada.direccion?.texto).toContain("Calle 80");
    expect(t.alertar).not.toHaveBeenCalled();
  });

  it("POS caido: el agente dice 'pendiente de confirmar' SIN folio, la fila queda fallida con backoff", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "timeout" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r.agente).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
    expect(r.agente?.mensaje).not.toMatch(/folio/i);
    expect(r.fila).toMatchObject({ estado: "fallida", folio: null, intentos: 1 });
    expect(t.alertar).not.toHaveBeenCalled();
    expect(new Date(r.fila!.proximoIntentoEn).getTime()).toBe(T0.getTime() + 30_000);
  });

  it("reintento por el drenaje tras el backoff: confirma sin duplicar la comanda", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "http_5xx" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect((await t.drenar()).reclamadas).toBe(0); // aun dentro del backoff
    t.avanzar(31_000);
    const resumen = await t.drenar();
    expect(resumen).toMatchObject({ reclamadas: 1, confirmadas: 1 });
    expect(t.store.fila(r.fila!.id)).toMatchObject({ estado: "confirmada", intentos: 2 });
    expect(t.port.comandas).toHaveLength(1);
  });

  it("respuesta perdida tras crear en el POS: el reintento recibe el MISMO folio (idempotencia), una sola comanda", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "duplicado" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r.agente?.folio).toBeNull();
    expect(t.port.comandas).toHaveLength(1);
    t.avanzar(31_000);
    await t.drenar();
    expect(t.port.comandas).toHaveLength(1);
    expect(t.store.fila(r.fila!.id)).toMatchObject({ estado: "confirmada", folio: t.port.comandas[0]!.folio });
  });

  it("agota los intentos: captura manual, UNA alerta, y el agente nunca tuvo un folio", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "timeout" }, 10);
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    for (let i = 0; i < 2; i += 1) {
      t.avanzar(16 * 60_000);
      await t.drenar();
    }
    const final = t.store.fila(r.fila!.id)!;
    expect(final).toMatchObject({ estado: "captura_manual", folio: null, intentos: 3 });
    expect(final.ultimoError).toContain("intentos_agotados");
    expect(t.alertar).toHaveBeenCalledTimes(1);
    t.avanzar(16 * 60_000);
    expect((await t.drenar()).reclamadas).toBe(0);
  });

  it("el POS rechaza (producto inexistente): captura manual inmediata y alerta, sin reintentos", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "producto_inexistente" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r.fila).toMatchObject({ estado: "captura_manual", intentos: 1 });
    expect(r.agente).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
    expect(t.alertar).toHaveBeenCalledTimes(1);
  });

  it("producto sin codigo POS: captura manual SIN tocar el POS (no se inventan codigos)", async () => {
    const t = await preparar({ codigos: false });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r.fila).toMatchObject({ estado: "captura_manual", ultimoError: "rechazada:producto_sin_codigo_pos" });
    expect(t.port.llamadasCrear).toHaveLength(0);
    expect(r.agente?.folio).toBeNull();
    expect(r.fila!.payload.items[0]).toMatchObject({ nombre: "Coca-Cola", cantidad: 2 });
  });

  it("sucursal sin clave T#: captura manual sin tocar el POS", async () => {
    const t = await preparar({ sucursal: false });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r.fila).toMatchObject({ estado: "captura_manual", ultimoError: "rechazada:sucursal_sin_codigo_pos" });
    expect(t.port.llamadasCrear).toHaveLength(0);
  });

  it("el resolver de sucursal reconoce 'T3' en el nombre de la sucursal", () => {
    const res = crearResolverSucursalPos();
    expect(res({ propertyId: "x", nombre: "Pensiones (T3)" })).toBe("T3");
    expect(res({ propertyId: "x", nombre: "Pensiones" })).toBeNull();
    expect(res({ propertyId: "x", nombre: "Sucursal T9" })).toBeNull();
  });

  it("un adaptador que LANZA se trata como no_disponible (nunca revienta el pedido)", async () => {
    const t = await preparar();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const roto: SoftRestaurantPort = { ...t.port, nombre: "roto", esReal: false, crearComanda: async () => { throw new Error("socket hang up"); } } as unknown as SoftRestaurantPort;
    const r = await encolarComandaParaPedido({ ...t.deps, port: roto }, { order: t.order });
    expect(r.fila).toMatchObject({ estado: "fallida", folio: null });
    expect(r.agente?.folio).toBeNull();
  });

  it("un POS colgado se corta por timeout y la comanda queda fallida", async () => {
    const t = await preparar();
    const colgado = { ...t.port, crearComanda: () => new Promise<ComandaResultado>(() => undefined) } as unknown as SoftRestaurantPort;
    const r = await encolarComandaParaPedido({ ...t.deps, port: colgado, timeoutInlineMs: 15 }, { order: t.order });
    expect(r.fila).toMatchObject({ estado: "fallida", ultimoError: "no_disponible:timeout" });
  });

  it("reencolar el mismo pedido (reintento del agente) no duplica ni reenvia una comanda ya confirmada", async () => {
    const t = await preparar();
    const a = await encolarComandaParaPedido(t.deps, { order: t.order });
    const b = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(t.store.todas()).toHaveLength(1);
    expect(t.port.llamadasCrear).toHaveLength(1);
    expect(b.agente).toMatchObject({ estado: "confirmada", folio: a.fila!.folio });
  });

  it("si encolar lanza (error inesperado de BD) el pedido NO se ve afectado y el agente dice pendiente", async () => {
    const t = await preparar();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(t.store, "encolar").mockRejectedValue(new Error("db down"));
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    expect(r).toMatchObject({ modo: "activo", motivo: "error", agente: { estado: "pendiente_de_confirmar", folio: null } });
  });

  it("recoger sin direccion y tarjeta con propina arman la comanda correcta", async () => {
    const t = await preparar();
    const sinDireccion = { ...t.order, customerAddress: null, paymentMethod: "tarjeta" as const };
    await encolarComandaParaPedido(t.deps, { order: sinDireccion, propina: 20 });
    expect(t.port.llamadasCrear[0]).toMatchObject({ tipo: "recoger", formaPago: "tarjeta", propina: 20 });
    expect(t.port.llamadasCrear[0]!.direccion).toBeUndefined();
  });

  it("propina con efectivo viola el contrato: captura manual, no se manda al POS", async () => {
    const t = await preparar();
    const r = await encolarComandaParaPedido(t.deps, { order: t.order, propina: 20 });
    expect(r.fila).toMatchObject({ estado: "captura_manual", ultimoError: "rechazada:entrada_invalida" });
    expect(t.port.llamadasCrear).toHaveLength(0);
  });
});

describe("drenarComandas", () => {
  it("kill switch: si se apaga la bandera despues de encolar, no se envia nada", async () => {
    const t = await preparar({ modo: "sombra" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    t.store.ponerModo(t.fx.organizationId, "apagado");
    expect((await t.drenar()).reclamadas).toBe(0);
    expect(t.store.fila(r.fila!.id)?.estado).toBe("pendiente");
    expect(t.port.llamadasCrear).toHaveLength(0);
  });

  it("la captura manual del staff corta los reintentos (no se manda una comanda duplicada)", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "timeout" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    const cap = await t.store.marcarCapturada(t.fx.organizationId, r.fila!.id, randomUUID(), "capturada en caja");
    expect(cap.resultado).toBe("ok");
    t.avanzar(60 * 60_000);
    expect((await t.drenar()).reclamadas).toBe(0);
    expect(t.port.comandas).toHaveLength(0);
  });

  it("aisla las unidades: una que lanza no impide procesar las demas", async () => {
    const t = await preparar({ modo: "sombra" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const otro = await createOrder(t.fx.repo, {
      organizationId: t.fx.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Ana",
      customerPhone: "9990002222",
      customerAddress: "Calle 1",
      paymentMethod: "efectivo",
      items: [{ productId: t.fx.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });
    await encolarComandaParaPedido(t.deps, { order: t.order });
    await encolarComandaParaPedido(t.deps, { order: otro });
    let unidad = 0;
    const resumen = await drenarComandas(
      {
        port: t.port,
        resolverCodigos: t.deps.resolverCodigos,
        resolverSucursal: t.deps.resolverSucursal,
        politica: t.deps.politica,
        ahora: t.deps.ahora,
        abrirUnidad: async (fn) => {
          unidad += 1;
          if (unidad === 2) throw new Error("unidad venenosa");
          return fn({ store: t.store });
        },
      },
      10,
    );
    expect(resumen).toMatchObject({ reclamadas: 2, confirmadas: 1, errores: 1 });
  });

  it("una fila `enviada` cuyo proceso murio se reclama otra vez al vencer el lease", async () => {
    const t = await preparar({ modo: "sombra" });
    const r = await encolarComandaParaPedido(t.deps, { order: t.order });
    await t.store.reclamarPorId(r.fila!.id, T0, 120_000); // reclamada y "el proceso murio"
    expect((await t.drenar()).reclamadas).toBe(0);
    t.avanzar(121_000);
    expect(await t.drenar()).toMatchObject({ reclamadas: 1, confirmadas: 1 });
  });
});

describe("crearAlertaCapturaManual", () => {
  it("usa la bandeja existente de notificaciones del staff (order.problema)", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "producto_inexistente" });
    const alertar = crearAlertaCapturaManual(t.fx.repo);
    const r = await encolarComandaParaPedido({ ...t.deps, alertar }, { order: t.order });
    const notas = await t.fx.repo.listStaffOrderNotifications(t.fx.organizationId, null, {});
    const n = notas.find((x) => x.orderId === t.order.id && x.eventType === "order.problema");
    expect(n?.message).toContain("captura manual requerida");
    expect(r.fila?.estado).toBe("captura_manual");
  });
});
