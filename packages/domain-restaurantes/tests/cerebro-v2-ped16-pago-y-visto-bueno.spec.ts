// C3 PED-16 (cerebro v2): el resumen completo ya estaba cotizado ($516) y terminaba preguntando la forma de pago; el cliente contesto «Tarjeta, la pago al momento de que llegue el
// repartidor. Sí, todo lo demás está bien» y el agente REPITIO el resumen con «¿Es correcto?» en vez de crear el pedido. El unico dato nuevo era el pago que el resumen pedia y el cliente
// afirmo lo demas: con cerebro v2 eso confirma (se adopta el pago) y el pedido se crea en el mismo turno. Sin la bandera, el cierre de siempre (un dato de pago no es el sí).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decidirConfirmacion, pagoConVistoBuenoAlResumen } from "../src/agent-tools/cierre-maquina.ts";
import type { OrderFlowContext } from "../src/agent-tools/order-flow.ts";
import { nuevoViaje, pedidosDe, type Viaje } from "./qa-viaje/arnes-viaje.ts";

const RESUMEN_PIDE_PAGO =
  "La sucursal que atiende Itzimná es Prolongación Montejo, a unos 3 km.\n\nPermítame repetirle su pedido:\n- 2 flanes\n- 1 crema de coco\n- 2 cafés\n- 1 queso fundido de rajas, con tortilla de maíz\n- A domicilio: Calle 26 #210 x 15 y 17, Itzimná\n- Sucursal: Prolongación Montejo\n- Total: $516\n\n¿Con cuánto pagaría en efectivo o prefiere tarjeta?";
const RESPUESTA = "Tarjeta, la pago al momento de que llegue el repartidor. Sí, todo lo demás está bien";

describe("PED-16 pagoConVistoBuenoAlResumen (pura)", () => {
  const base = { total: 516, canal: "domicilio" as const, datosCotizados: {} };
  it("pago pedido por el resumen + «todo lo demás está bien» => adopta tarjeta", () => {
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, RESPUESTA, base)).toMatchObject({ pago: "tarjeta" });
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, "Con tarjeta, sí así está bien", base)).toMatchObject({ pago: "tarjeta" });
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, "Efectivo, pago con 600. Todo lo demás correcto", base)).toMatchObject({ pago: "efectivo", efectivoCon: 600 });
  });
  it("no adopta: sin visto bueno, con un cambio, con pregunta, efectivo a domicilio sin monto o el resumen no pedía el pago", () => {
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, "Tarjeta", base)).toBeNull();
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, "Tarjeta, y agrégale otro flan. Lo demás bien", base)).toBeNull();
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, "Tarjeta, todo bien. ¿Cuánto tarda?", base)).toBeNull();
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, "Efectivo, todo lo demás está bien", base)).toBeNull();
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO, "Tarjeta, no, todo lo demás está mal", base)).toBeNull();
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO.replace("¿Con cuánto pagaría en efectivo o prefiere tarjeta?", "¿A nombre de quién?"), RESPUESTA, base)).toBeNull();
    expect(pagoConVistoBuenoAlResumen(RESUMEN_PIDE_PAGO.replace("Total: $516", "Total: $480"), RESPUESTA, base)).toBeNull();
  });
});

describe("PED-16 decidirConfirmacion", () => {
  const ctx = { quotedTotal: 516, quotedCanal: "domicilio", quoteHash: "h", quotedAtMs: 0 } as unknown as OrderFlowContext;
  const historial = [{ role: "assistant", content: RESUMEN_PIDE_PAGO }, { role: "user", content: RESPUESTA }];
  it("con cerebro v2 confirma y devuelve el pago adoptado", () => {
    expect(decidirConfirmacion({ ctx, historial, turn: "t2", pagoConVistoBueno: true })).toMatchObject({ ok: true, datosAdoptados: { pago: "tarjeta" } });
  });
  it("sin la bandera no confirma (un dato de pago no es el sí)", () => {
    expect(decidirConfirmacion({ ctx, historial, turn: "t2" }).ok).toBe(false);
  });
});

describe("PED-16 turno completo (modelo guionado)", () => {
  const enMerida = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(enMerida("2026-10-13", "19:00"));
  });
  afterEach(() => vi.useRealTimers());

  const resumenSinPago = async (v: Viaje) => {
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Yolanda Tamay", items: [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }] } }] },
      { texto: "Permítame repetirle su pedido:\n- 4 Coca-Cola\n- A domicilio: Calle 60 #123 entre 21 y 23, Temozón Norte\n- Total: $212.00\n\n¿Con cuánto pagaría en efectivo o prefiere tarjeta?" },
    ]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, a nombre de Yolanda Tamay");
  };

  it("con cerebro v2: «Tarjeta… Sí, todo lo demás está bien» crea el pedido con tarjeta en ese turno", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await resumenSinPago(v);
    v.guion([{ texto: "Listo, su pedido quedó registrado; llevamos terminal." }]);
    const r = await v.escribe(RESPUESTA);
    const pedidos = await pedidosDe(v);
    expect(pedidos, JSON.stringify(r) + JSON.stringify(v.requests.at(-1)?.messages.filter((m) => m.role === "tool").map((m) => m.content))).toHaveLength(1);
    expect(pedidos[0]!.paymentMethod).toBe("tarjeta");
  });

  it("sin la bandera: no se crea (el cierre de siempre pide el sí al resumen con el pago)", async () => {
    const v = await nuevoViaje();
    await resumenSinPago(v);
    v.guion([{ texto: "Permítame repetirle su pedido... ¿Es correcto?" }]);
    await v.escribe(RESPUESTA);
    expect(await pedidosDe(v)).toHaveLength(0);
  });
});
