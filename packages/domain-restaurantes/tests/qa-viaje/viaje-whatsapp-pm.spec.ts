// QA R1 lente VIAJE -- pedido de prueba de punta a punta por WhatsApp en T7 (Garcia Lavin) con el catalogo y las reglas REALES
// de PM: primer mensaje (aviso de privacidad) -> producto por kilo (fraccion a precio proporcional) + extra de pina ($19) + doble
// salsa ($19) -> cotizacion -> confirmacion en un mensaje POSTERIOR -> pedido -> comanda en cocina (estados del staff) -> avisos
// al cliente -> cierre (entregado/completado) -> ventas del dia. Mas: duplicados, reenvio de Meta, fuera de horario.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOrderStatus } from "../../src/order-lifecycle.ts";
import { getSalesKpis } from "../../src/kpis.ts";
import { MARTES_14H, MIERCOLES_0230, nuevoViaje, pedidosDe, type Viaje } from "./arnes-viaje.ts";

const PASTOR_500 = "Pastor — 500 g";
const EXTRA_PINA = "Extra Piña";
const COCA = "Coca-Cola";

function renglones(v: Viaje) {
  return [
    { product_id: v.producto(PASTOR_500), product_name: PASTOR_500, requested_quantity: 1 },
    { product_id: v.producto(EXTRA_PINA), product_name: EXTRA_PINA, requested_quantity: 1 },
    { product_id: v.producto(COCA), product_name: COCA, requested_quantity: 2 },
  ];
}

describe("viaje WhatsApp PM (T7): pedido para recoger de punta a punta", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());

  it("medio kilo de pastor + extra pina + doble salsa + 2 cocas: precio del catalogo real, confirmacion posterior, cocina, avisos y ventas", async () => {
    const v = await nuevoViaje();
    // 1) Saludo: el agente presenta y pregunta (sin tools). Primer contacto => aviso de privacidad antepuesto.
    v.guion([{ texto: "Buenas tardes, le atiende el asistente virtual de Los Taquitos de PM. ¿Su pedido es para recoger o a domicilio?" }]);
    const r1 = await v.escribe("Hola buenas tardes");
    expect(r1.ok).toBe(true);
    expect(r1.reply).toMatch(/asistente virtual/i);
    expect(r1.reply).toMatch(/privacidad/i);

    // 2) Pide: busca, cotiza con doble salsa verde.
    const items = renglones(v);
    v.guion([
      { tools: [{ name: "buscar_producto", args: { query: "medio kilo pastor", branch_slug: "garcia-lavin" } }] },
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", items, doble_salsas: ["salsa_verde"], payment_method: "efectivo" } }] },
      { texto: "Permítame repetirle su pedido: 1/2 kg de pastor, extra piña, doble salsa verde y 2 Coca-Cola. Total $594.00. ¿Es correcto?" },
    ]);
    const r2 = await v.escribe("Para recoger. Medio kilo de pastor con extra piña, doble salsa verde y dos cocas");
    expect(r2.ok).toBe(true);
    // Precio real: 450 (1/2 kg, proporcional del kilo de 900) + 19 (extra pina) + 19 (doble salsa) + 2 x 53 (coca) = 594.
    expect(r2.reply).toContain("594");
    expect(await pedidosDe(v)).toHaveLength(0);

    // 3) El cliente confirma en un mensaje POSTERIOR -> confirmar y crear.
    v.guion([
      { tools: [{ name: "confirmar_resumen", args: {} }] },
      { tools: [{ name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Cliente QA", items, doble_salsas: ["salsa_verde"], payment_method: "efectivo", hora_recogida: "2026-10-13T14:40:00-06:00" } }] },
      { texto: "Listo, su pedido quedó registrado. Total $594.00. Lo esperamos a las 2:40." },
    ]);
    const r3 = await v.escribe("Sí, es correcto");
    expect(r3.ok).toBe(true);
    expect(r3.orderId).toBeTruthy();
    const [pedido] = await pedidosDe(v);
    expect(pedido).toMatchObject({ status: "pending", total: 594, source: "whatsapp", paymentMethod: "efectivo" });
    expect(pedido!.items.map((i) => i.name)).toEqual(expect.arrayContaining([PASTOR_500, EXTRA_PINA, COCA]));

    // 4) Meta reenvia el MISMO mensaje (at-least-once): no se reprocesa ni duplica.
    v.guion([{ tools: [{ name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Cliente QA", items, doble_salsas: ["salsa_verde"], payment_method: "efectivo" } }] }]);
    const dup = await v.escribe("Sí, es correcto", { messageId: "wamid.qa-viaje-3" });
    expect(dup).toEqual({ ok: true, retryable: false });
    expect(await pedidosDe(v)).toHaveLength(1);

    // 5) Cocina: preparando -> listo para recoger -> entregado -> completado; el cliente recibe sus avisos por el outbox.
    const org = v.world.organizationId;
    let o = await changeOrderStatus(v.world.repo, org, pedido!, "preparando");
    o = await changeOrderStatus(v.world.repo, org, o, "listo_para_recoger");
    o = await changeOrderStatus(v.world.repo, org, o, "entregado");
    o = await changeOrderStatus(v.world.repo, org, o, "completado");
    expect(o.status).toBe("completado");
    const avisos = v.world.repo.getOutbox().filter((x) => x.eventType !== "whatsapp.inbound_reply");
    expect(avisos.map((x) => x.eventType)).toEqual(["order.status.preparando", "order.status.listo_para_recoger", "order.status.entregado"]);
    expect(avisos.every((x) => (x.payload as { to?: string }).to === "5219995550111" || /9995550111$/.test(String((x.payload as { to?: string }).to)))).toBe(true);

    // 6) Ventas de hoy: exactamente lo que se cobro.
    const hoy = await getSalesKpis(v.world.repo, org, null, "today", new Date());
    expect(hoy).toMatchObject({ revenue: 594, orders: 1, customers: 1 });
  });

  it("el agente intenta crear dos veces en el mismo turno tras confirmar: solo un pedido", async () => {
    const v = await nuevoViaje();
    const items = renglones(v);
    v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", items } }] }, { texto: "Total $575.00. ¿Es correcto?" }]);
    await v.escribe("Medio kilo de pastor, extra piña y 2 cocas para recoger");
    const crear = { name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Cliente QA", items, payment_method: "tarjeta" } };
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { tools: [crear, crear] }, { texto: "Listo." }]);
    await v.escribe("sí");
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("fuera de horario (02:30): la cotizacion se rechaza con el horario y no hay pedido", async () => {
    vi.setSystemTime(new Date(MIERCOLES_0230));
    const v = await nuevoViaje();
    const items = renglones(v);
    v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", items } }] }, { texto: "Lo siento, ya cerramos." }]);
    await v.escribe("Medio kilo de pastor para recoger");
    const tool = v.requests.flatMap((r) => r.messages).find((m) => m.role === "tool");
    expect(String(tool?.content)).toMatch(/cerrad|abre|horario/i);
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("cliente recurrente: segundo pedido el mismo dia (despues de uno ya creado) se cotiza, confirma y crea sin chocar con el primero", async () => {
    const v = await nuevoViaje();
    const items = renglones(v);
    const crear = { name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Cliente QA", items, payment_method: "efectivo" } };
    v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", items } }] }, { texto: "Total $575.00. ¿Es correcto?" }]);
    await v.escribe("lo mismo de siempre para recoger");
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { tools: [crear] }, { texto: "Listo." }]);
    await v.escribe("sí");
    vi.setSystemTime(new Date(Date.parse(MARTES_14H) + 90 * 60_000));
    v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", items } }] }, { texto: "Total $575.00. ¿Es correcto?" }]);
    await v.escribe("otra vez lo mismo por favor, para recoger");
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { tools: [crear] }, { texto: "Listo." }]);
    const r = await v.escribe("sí");
    expect(r.orderId).toBeTruthy();
    expect(await pedidosDe(v)).toHaveLength(2);
  });

  it("ARCO por WhatsApp a mitad de un pedido: solicitud determinista (sin LLM), CONFIRMO la registra y el pedido no se toca", async () => {
    const v = await nuevoViaje();
    const items = renglones(v);
    v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", items } }] }, { texto: "Total $575.00. ¿Es correcto?" }]);
    await v.escribe("medio kilo de pastor y dos cocas para recoger");
    const llamadasAntes = v.requests.length;
    const r1 = await v.escribe("Quiero que borren mis datos personales");
    expect(r1.reply).toMatch(/CONFIRMO/);
    expect(v.requests.length).toBe(llamadasAntes);
    const r2 = await v.escribe("CONFIRMO");
    expect(r2.reply).toMatch(/folio/i);
    expect(v.privacidad.requests).toHaveLength(1);
    expect(v.privacidad.requests[0]).toMatchObject({ rightType: "cancelacion" });
    expect(await pedidosDe(v)).toHaveLength(0);
  });
});
