// QA R1 lente VIAJE -- desenlace del ciclo en T7: un dia con un pedido entregado, uno cancelado, uno para recoger que el cliente
// NUNCA recogio y uno programado para manana. Verifica que las "ventas de hoy" del panel (y del Copiloto, que usa la misma
// definicion `status <> 'cancelado'`) cuentan solo dinero real, que la cocina ve el pedido correcto y que los avisos al cliente
// respetan el trato de USTED que exige el dueno (P26).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOrderStatus } from "../../src/order-lifecycle.ts";
import { createOrder } from "../../src/orders.ts";
import { getSalesKpis } from "../../src/kpis.ts";
import { promoverProgramadosVencidos } from "../../src/pedidos-programados.ts";
import { MARTES_14H, nuevoViaje, type Viaje } from "./arnes-viaje.ts";

const PASTOR_500 = "Pastor — 500 g";

async function pedido(v: Viaje, extra: Partial<Parameters<typeof createOrder>[1]> = {}) {
  return createOrder(v.world.repo, {
    organizationId: v.world.organizationId,
    branchSlug: "garcia-lavin",
    customerName: "Cliente QA",
    customerPhone: "9995550111",
    items: [{ productId: v.producto(PASTOR_500), requestedQuantity: 1 }],
    source: "whatsapp",
    paymentMethod: "efectivo",
    canal: "recoger",
    ...extra,
  });
}

describe("viaje cierre del dia (T7)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());

  it("entregado cuenta, cancelado no; el programado para manana pasa a cocina solo al acercarse su hora", async () => {
    const v = await nuevoViaje();
    const org = v.world.organizationId;
    const entregado = await pedido(v);
    let o = await changeOrderStatus(v.world.repo, org, entregado, "preparando");
    o = await changeOrderStatus(v.world.repo, org, o, "listo_para_recoger");
    await changeOrderStatus(v.world.repo, org, o, "entregado");
    const cancelado = await pedido(v);
    await changeOrderStatus(v.world.repo, org, cancelado, "cancelado");
    const manana = await pedido(v, { programadoPara: "2026-10-14T13:30:00-06:00" });
    expect(manana.status).toBe("programado");
    // hoy, con el panel consultando: no se promueve
    expect((await promoverProgramadosVencidos(v.world.repo, org)).promovidos).toHaveLength(0);
    // manana 13:05 (dentro de la anticipacion de 30 min): pasa a cocina
    vi.setSystemTime(new Date("2026-10-14T19:05:00Z"));
    const r = await promoverProgramadosVencidos(v.world.repo, org);
    expect(r.promovidos.map((p) => p.id)).toEqual([manana.id]);
  });

  // `orders_bucketed_stats` (migracion 036) y las consultas del Copiloto (data-chat/sql.ts) suman TODO lo no cancelado: el
  // pedido para recoger que el cliente nunca recogio (`no_recogido`, comida no cobrada) cuenta como venta, y el programado de
  // manana cuenta como venta de HOY (por `created_at`). El dueno ve "ventas de hoy" infladas y el Copiloto repite la cifra.
  it.fails("QA-restaurantes-R1-viaje-09: las ventas de hoy no suman un pedido 'no recogido' ni un programado para manana", async () => {
    const v = await nuevoViaje();
    const org = v.world.organizationId;
    const entregado = await pedido(v);
    let o = await changeOrderStatus(v.world.repo, org, entregado, "preparando");
    o = await changeOrderStatus(v.world.repo, org, o, "listo_para_recoger");
    await changeOrderStatus(v.world.repo, org, o, "entregado");
    const nunca = await pedido(v);
    let n = await changeOrderStatus(v.world.repo, org, nunca, "preparando");
    n = await changeOrderStatus(v.world.repo, org, n, "listo_para_recoger");
    await changeOrderStatus(v.world.repo, org, n, "no_recogido");
    await pedido(v, { programadoPara: "2026-10-14T13:30:00-06:00" });
    const hoy = await getSalesKpis(v.world.repo, org, null, "today", new Date());
    expect(hoy.revenue).toBe(450);
    expect(hoy.orders).toBe(1);
  });

  // El perfil de PM exige USTED en todo mensaje al cliente (P26; el agente y la voz ya lo cumplen y G_TONO_USTED lo vigila),
  // pero los avisos automaticos de estado del pedido (order-notifications.ts) tutean: "tu pedido ... fue confirmado".
  it.fails("QA-restaurantes-R1-viaje-10: los avisos de estado al cliente de PM hablan de usted", async () => {
    const v = await nuevoViaje();
    const org = v.world.organizationId;
    const p = await pedido(v);
    const o = await changeOrderStatus(v.world.repo, org, p, "preparando");
    await changeOrderStatus(v.world.repo, org, o, "listo_para_recoger");
    const cuerpos = v.world.repo.getOutbox().map((x) => String((x.payload as { body?: string }).body ?? ""));
    expect(cuerpos.length).toBe(2);
    for (const c of cuerpos) expect(c).not.toMatch(/\btu pedido\b|\bcontáctanos\b/i);
  });

  // Las respuestas ARCO deterministas del mismo WhatsApp de PM tambien tutean ("Recibí tu solicitud... la haces tú").
  it.fails("QA-restaurantes-R1-viaje-10 (ARCO): la respuesta ARCO del WhatsApp de PM habla de usted", async () => {
    const v = await nuevoViaje();
    const arco = await v.escribe("Quiero que borren mis datos personales");
    expect(arco.reply).toMatch(/CONFIRMO/);
    expect(arco.reply).not.toMatch(/\btu solicitud\b|\bla haces tú\b/i);
  });

  it("un pedido en camino no se puede cancelar directo: pasa por incidencia y luego se cancela, con aviso al cliente", async () => {
    const v = await nuevoViaje();
    const org = v.world.organizationId;
    const p = await pedido(v, { canal: "domicilio", customerAddress: "Calle 60 número 100, Centro" });
    let o = await changeOrderStatus(v.world.repo, org, p, "preparando");
    o = await changeOrderStatus(v.world.repo, org, o, "en_camino");
    await expect(changeOrderStatus(v.world.repo, org, o, "cancelado")).rejects.toThrow(/No se puede cambiar/);
    o = await changeOrderStatus(v.world.repo, org, o, "problema");
    o = await changeOrderStatus(v.world.repo, org, o, "cancelado");
    expect(o.status).toBe("cancelado");
    expect(v.world.repo.getOutbox().some((x) => x.eventType === "order.status.cancelado")).toBe(true);
  });
});
