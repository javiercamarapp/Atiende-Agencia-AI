// PM R24 (T7-026 / T7-074 en la nube): el modelo mandaba payment_method sin que el cliente (ni el asistente) hablara jamas de como paga, y el servidor lo adoptaba:
// el resumen decia «Pago: tarjeta» y un «sí» lo dejaba registrado. El servidor ya no adopta una forma de pago que nadie dijo: pregunta.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clienteDijoComoPaga } from "../src/agent-tools/cierre-maquina.ts";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);
beforeEach(() => prepararEntorno(true));

describe("R24: la forma de pago debe salir del cliente", () => {
  it("clienteDijoComoPaga: solo cuenta lo que dice el cliente o una pregunta del asistente (no el resumen)", () => {
    expect(clienteDijoComoPaga([{ role: "user", content: "1 kg de bistec" }])).toBe(false);
    expect(clienteDijoComoPaga([{ role: "user", content: "Va en efectivo" }])).toBe(true);
    expect(clienteDijoComoPaga([{ role: "user", content: "pago con terminal" }])).toBe(true);
    expect(clienteDijoComoPaga([{ role: "assistant", content: "¿Pagará en efectivo o con tarjeta?" }])).toBe(true);
    expect(clienteDijoComoPaga([{ role: "assistant", content: "Resumen\nPago: tarjeta\nTotal a pagar: $200\n¿Está correcto?" }])).toBe(false);
  });

  it("crear_pedido con pago inventado tras un «sí»: NO crea el pedido y pide preguntar el pago", async () => {
    const s = setup();
    s.cliente("Quiero dos cocas para recoger");
    await s.quote({ payment_method: undefined, efectivo_con: undefined });
    await s.muestraResumen();
    s.cliente("Sí");
    await s.confirm();
    const r = await s.create({ payment_method: "tarjeta", efectivo_con: undefined });
    expect(JSON.stringify(r.result)).toMatch(/cómo va a pagar/i);
    expect(r.orderId ?? null).toBeNull();
    const lista: any = await s.f.repo.listOrders(s.f.organizationId, {} as never);
    expect((lista.orders ?? lista.items ?? lista).length).toBe(0);
  });
});
