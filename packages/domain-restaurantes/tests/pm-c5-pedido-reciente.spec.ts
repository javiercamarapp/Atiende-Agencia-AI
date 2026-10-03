// PM-C5 (recomendacion 10 del analisis): estado del pedido para "¿ya salio?". El agente solo afirma lo que la sucursal marco en el
// pedido (`en_camino`, `listo_para_recoger`...); sin pedido reciente lo dice, nunca inventa un estado ni una hora.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupCustomer, lookupCustomerConPedidoReciente } from "../src/customers.ts";
import { VENTANA_PEDIDO_RECIENTE_MIN, buscarPedidoReciente, estadoParaCliente } from "../src/pedido-reciente.ts";
import { createOrder } from "../src/orders.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { pmCustomerContextBlock } from "../src/whatsapp/perfil-pm.ts";
import type { OrderStatus } from "../src/types.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const MARTES_14H = new Date("2026-10-13T20:00:00Z"); // martes 14:00 en Merida: abierto y sin 2x1
const TELEFONO = "0001000001";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_14H);
});
afterEach(() => {
  vi.useRealTimers();
});

async function mundoConPedido(canal: "domicilio" | "recoger", telefono = TELEFONO) {
  const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
  const order = await createOrder(world.repo, {
    organizationId: world.organizationId,
    branchSlug: "garcia-lavin",
    customerName: "Cliente Prueba",
    customerPhone: telefono,
    ...(canal === "domicilio" ? { customerAddress: "Privada de prueba casa 3, Temozón Norte", colonia: "Temozón Norte" } : {}),
    canal,
    paymentMethod: "efectivo",
    source: "whatsapp",
    items: [{ productId: world.productIds.get("Bistec de Res — 1 kg")!, requestedQuantity: 1 }],
  });
  return { world, order };
}

describe("estadoParaCliente", () => {
  it.each<[OrderStatus, string | null]>([
    ["pending", "preparando"],
    ["preparando", "preparando"],
    ["en_camino", "salio"],
    ["listo_para_recoger", "listo_para_recoger"],
    ["entregado", "entregado"],
    ["completado", "entregado"],
    ["programado", "programado"],
    ["problema", "con_problema"],
    ["no_recogido", "no_recogido"],
    ["cancelado", null],
  ])("%s -> %s", (status, esperado) => {
    expect(estadoParaCliente(status)).toBe(esperado);
  });
});

describe("buscarPedidoReciente", () => {
  it("sin pedidos: null (el agente lo dice y ofrece tomar uno)", async () => {
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
    expect(await buscarPedidoReciente(world.repo, world.organizationId, TELEFONO)).toBeNull();
  });

  it("recien confirmado: preparando, con la hora local de la sucursal (14:00 en Merida) y 0 minutos", async () => {
    const { world } = await mundoConPedido("domicilio");
    expect(await buscarPedidoReciente(world.repo, world.organizationId, TELEFONO)).toEqual({
      estado: "preparando",
      canal: "domicilio",
      sucursal: "García Lavín (Victory Platz)",
      confirmadoHoraLocal: "14:00",
      minutosDesdeConfirmacion: 0,
    });
  });

  it("SOLO cuando la sucursal lo marca en camino responde que salio, y cuenta los minutos desde la confirmacion", async () => {
    const { world, order } = await mundoConPedido("domicilio");
    await world.repo.updateOrderStatus(world.organizationId, order.id, "pending", "preparando");
    expect((await buscarPedidoReciente(world.repo, world.organizationId, TELEFONO))?.estado).toBe("preparando");
    await world.repo.updateOrderStatus(world.organizationId, order.id, "preparando", "en_camino");
    vi.setSystemTime(new Date(MARTES_14H.getTime() + 35 * 60_000));
    expect(await buscarPedidoReciente(world.repo, world.organizationId, TELEFONO)).toMatchObject({ estado: "salio", minutosDesdeConfirmacion: 35, confirmadoHoraLocal: "14:00" });
  });

  it("un pedido para recoger listo se reporta como listo para recoger", async () => {
    const { world, order } = await mundoConPedido("recoger");
    await world.repo.updateOrderStatus(world.organizationId, order.id, "pending", "listo_para_recoger");
    expect(await buscarPedidoReciente(world.repo, world.organizationId, TELEFONO)).toMatchObject({ estado: "listo_para_recoger", canal: "recoger" });
  });

  it("un pedido cancelado no cuenta como pedido vigente", async () => {
    const { world, order } = await mundoConPedido("recoger");
    await world.repo.updateOrderStatus(world.organizationId, order.id, "pending", "cancelado");
    expect(await buscarPedidoReciente(world.repo, world.organizationId, TELEFONO)).toBeNull();
  });

  it(`pasadas ${VENTANA_PEDIDO_RECIENTE_MIN / 60} horas ya no es "el pedido de ahora"`, async () => {
    const { world } = await mundoConPedido("recoger");
    vi.setSystemTime(new Date(MARTES_14H.getTime() + (VENTANA_PEDIDO_RECIENTE_MIN + 1) * 60_000));
    expect(await buscarPedidoReciente(world.repo, world.organizationId, TELEFONO)).toBeNull();
  });

  it("no mezcla clientes: otro telefono no ve el pedido (y el mismo telefono en otro formato si)", async () => {
    const { world } = await mundoConPedido("recoger", "999 123 4567");
    expect(await buscarPedidoReciente(world.repo, world.organizationId, "0001000002")).toBeNull();
    expect(await buscarPedidoReciente(world.repo, world.organizationId, "+52 1 999 123 4567")).toMatchObject({ estado: "preparando" });
  });

  it("no cruza organizaciones", async () => {
    const { world } = await mundoConPedido("recoger");
    expect(await buscarPedidoReciente(world.repo, "00000000-0000-4000-8000-00000000dead", TELEFONO)).toBeNull();
  });
});

describe("el agente ve el estado en su contexto", () => {
  it("lookupCustomer (ficha de admin y demas llamadores) queda igual: sin pedidoReciente", async () => {
    const { world } = await mundoConPedido("domicilio");
    const base = await lookupCustomer(world.repo, world.organizationId, TELEFONO);
    expect(base.isNew).toBe(false);
    expect("pedidoReciente" in base).toBe(false);
  });

  it("lookupCustomerConPedidoReciente agrega el estado y el contexto del prompt dice YA SALIO solo si la sucursal lo marco", async () => {
    const { world, order } = await mundoConPedido("domicilio");
    const preparando = await lookupCustomerConPedidoReciente(world.repo, world.organizationId, TELEFONO);
    expect(pmCustomerContextBlock(preparando)).toMatch(/Pedido reciente de este número \(a domicilio\) en García Lavín \(Victory Platz\): confirmado a las 14:00, hace 0 min\. Estado que marcó la sucursal: en preparación \(la sucursal todavía no lo marca como salido\)/);
    expect(pmCustomerContextBlock(preparando)).not.toMatch(/YA SALIÓ/);
    await world.repo.updateOrderStatus(world.organizationId, order.id, "pending", "en_camino");
    const salio = await lookupCustomerConPedidoReciente(world.repo, world.organizationId, TELEFONO);
    expect(pmCustomerContextBlock(salio)).toMatch(/YA SALIÓ a reparto \(la sucursal lo marcó en camino\)/);
  });

  it("cliente conocido sin pedido de las ultimas 12 h: el contexto lo dice para que el agente no invente", async () => {
    const { world } = await mundoConPedido("recoger");
    vi.setSystemTime(new Date(MARTES_14H.getTime() + 13 * 60 * 60_000));
    const c = await lookupCustomerConPedidoReciente(world.repo, world.organizationId, TELEFONO);
    expect(pmCustomerContextBlock(c)).toMatch(/No tiene un pedido de las últimas 12 horas/);
  });

  it("un cliente nunca visto sigue siendo isNew", async () => {
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
    expect(await lookupCustomerConPedidoReciente(world.repo, world.organizationId, TELEFONO)).toEqual({ isNew: true });
  });
});
