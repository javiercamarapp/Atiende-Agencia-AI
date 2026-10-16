// Revision de #552: `pending` se traduce a `registrado` (estadoParaCliente). Las guardas de alto riesgo deben leer ESE mapeo real, no el literal "preparando":
// pending es justo el estado cuando la sucursal todavia no marca nada.
import { describe, expect, it } from "vitest";
import { classifyHighRiskIntent, type HighRiskContext } from "../src/whatsapp/guards.ts";
import { estadoParaCliente } from "../src/pedido-reciente.ts";
import type { OrderStatus } from "../src/types.ts";

const ctxDe = (status: OrderStatus, minutos = 120): HighRiskContext => ({
  pedidoReciente: { estado: estadoParaCliente(status)!, canal: "domicilio", sucursal: "T7", confirmadoHoraLocal: "14:00", minutosDesdeConfirmacion: minutos },
});
const intent = (t: string, c: HighRiskContext) => classifyHighRiskIntent(t, c)?.intent ?? null;

describe("guardas de alto riesgo con el estado REAL de un pedido pending (registrado)", () => {
  const PEND = ctxDe("pending");
  it("el mapeo real: pending -> registrado", () => expect(PEND.pedidoReciente?.estado).toBe("registrado"));

  it.each([["llevo 2 horas esperando mi pedido"], ["llevo dos horas esperando"]])("espera larga de un pedido registrado escala: %s", (t) => {
    expect(intent(t, PEND)).toBe("urgencia");
  });
  it.each([["cámbiame el pedido a harina"], ["modifica el pedido, agrega 2 tacos"]])("modificacion de un pedido registrado va a una persona: %s", (t) => {
    expect(intent(t, PEND)).toBe("modificacion_pedido");
  });

  // NEGATIVOS / controles: no deben cambiar
  it("sin pedido o con pedido entregado, el cambio de pedido y la espera larga NO escalan", () => {
    for (const c of [{ pedidoReciente: null }, ctxDe("entregado")] as HighRiskContext[]) {
      expect(intent("cámbiame el pedido a harina", c)).toBeNull();
      expect(intent("llevo 2 horas esperando mi pedido", c)).toBeNull();
    }
  });
  it("una espera corta (20 min) o una pregunta no escalan con pedido registrado", () => {
    expect(intent("llevo 20 minutos esperando mi pedido", ctxDe("pending", 20))).toBeNull();
    expect(intent("¿puedo cambiar el pedido?", PEND)).toBeNull();
  });
  it("cancelacion y queja siguen igual con un pedido registrado", () => {
    expect(intent("quiero cancelar mi pedido", PEND)).toBe("cancelacion_modificacion");
    expect(intent("me faltó la bebida de mi pedido", PEND)).toBe("queja");
  });
  it("contrato de entrada: texto vacio/raro no lanza ni escala", () => {
    for (const t of ["", " ", "0", "false"]) expect(intent(t, PEND)).toBeNull();
    for (const t of [null, undefined, 0, false, [], {}]) expect(() => classifyHighRiskIntent(t as never, PEND)).not.toThrow();
  });
});
