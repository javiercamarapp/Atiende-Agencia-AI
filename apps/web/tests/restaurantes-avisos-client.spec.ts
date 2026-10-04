// R-16: el sonido del sondeo de pedidos respeta la preferencia de avisos de la persona; sin respuesta conserva el comportamiento de siempre.
import { describe, expect, it } from "vitest";
import { sonidoPedidoNuevoPermitido } from "../src/verticals/restaurantes/lib/avisos-client.ts";

const mias = (enabled: boolean, sonido: boolean) => ({ disponible: true, mias: [{ tipo: "restaurantes.pedido.nuevo", enabled, sonido }] });

describe("sonidoPedidoNuevoPermitido", () => {
  it("suena solo con el aviso Y el sonido encendidos", () => {
    expect(sonidoPedidoNuevoPermitido(mias(true, true))).toBe(true);
    expect(sonidoPedidoNuevoPermitido(mias(true, false))).toBe(false);
    expect(sonidoPedidoNuevoPermitido(mias(false, true))).toBe(false);
    expect(sonidoPedidoNuevoPermitido(mias(false, false))).toBe(false);
  });

  it("sin preferencia guardada para el pedido nuevo (default encendido) suena", () => {
    expect(sonidoPedidoNuevoPermitido({ disponible: true, mias: [{ tipo: "restaurantes.handoff.solicitado", enabled: false, sonido: false }] })).toBe(true);
  });

  it("sin respuesta, base sin migrar o forma inesperada: conserva el comportamiento de siempre (suena segun la casilla local)", () => {
    expect(sonidoPedidoNuevoPermitido(null)).toBe(true);
    expect(sonidoPedidoNuevoPermitido(undefined)).toBe(true);
    expect(sonidoPedidoNuevoPermitido({ disponible: false, mias: [] })).toBe(true);
    expect(sonidoPedidoNuevoPermitido({ disponible: true, mias: undefined as never })).toBe(true);
  });
});
