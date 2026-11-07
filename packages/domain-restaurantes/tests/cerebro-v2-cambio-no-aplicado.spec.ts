// Cerebro v2 (SUELTO-VS-718-V2.md B4 «segundo crear_pedido con cambios en el turno»; suelto whatsapp-agent-core.ts ~7946-7959): dentro del turno el pedido ya existe;
// un segundo crear_pedido devuelve el resultado del primero (nunca crea otro) y, si trae algo distinto, el aviso `cambio_no_aplicado` de cambioNoAplicadoEnTurno.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, pedidosDe } from "./qa-viaje/arnes-viaje.ts";
import { cambioNoAplicadoEnTurno } from "../src/whatsapp/cerebro-v2/pedido-aparte.ts";

describe("cerebro v2: segundo crear_pedido en el mismo turno", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T19:00:00-06:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("con otras notas: no crea otro y el resultado trae cambio_no_aplicado (paridad)", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
    const base = { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items };
    v.guion([{ tools: [{ name: "cotizar_pedido", args: base }] }, { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" }]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
    const segundo = { ...base, notes: "sin hielo" };
    v.guion([{ tools: [{ name: "crear_pedido", args: base }, { name: "crear_pedido", args: segundo }] }, { texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(1);
    const esperado = cambioNoAplicadoEnTurno(base, segundo);
    expect(esperado).not.toBeNull();
    const resultados = v.requests.flatMap((r) => r.messages).filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(resultados.some((c) => c.includes(JSON.stringify(esperado).slice(1, 60)))).toBe(true);
  });
});
