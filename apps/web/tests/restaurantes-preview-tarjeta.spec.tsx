// @vitest-environment jsdom
//
// Tarjeta del pedido SIMULADO de la prueba del agente: solo se pinta un pedido que el servidor marco `simulado`, con folio PRUEBA,
// el total del servidor y la etiqueta fija de que no se crea nada. Un pedido real o un resultado cualquiera no la activan.
import { afterEach, describe, expect, it } from "vitest";
import { TarjetaPedidoSimulado } from "../src/verticals/restaurantes/preview/TarjetaPedidoSimulado.tsx";
import { pedidoSimuladoDe } from "../src/verticals/restaurantes/lib/voz-client.ts";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const SIMULADO = { order: { id: "PRUEBA-1A2B", branch: "Francisco de Montejo", total: 164, status: "simulado", payment_method: "efectivo", simulado: true, items: [{ name: "Tacos de pastor (orden de 3)", quantity: 1, price: 164 }] } };

describe("pedidoSimuladoDe", () => {
  it("lee el pedido simulado del resultado de crear_pedido", () => {
    expect(pedidoSimuladoDe(SIMULADO)).toEqual({ folio: "PRUEBA-1A2B", sucursal: "Francisco de Montejo", total: 164, metodoPago: "efectivo", renglones: [{ nombre: "Tacos de pastor (orden de 3)", cantidad: 1, precio: 164 }] });
  });
  it("ignora un pedido real (sin marca simulado), un error y valores raros", () => {
    expect(pedidoSimuladoDe({ order: { ...SIMULADO.order, simulado: undefined } })).toBeNull();
    expect(pedidoSimuladoDe({ error: "Sucursal cerrada" })).toBeNull();
    expect(pedidoSimuladoDe(null)).toBeNull();
    expect(pedidoSimuladoDe("x")).toBeNull();
  });
});

describe("<TarjetaPedidoSimulado />", () => {
  it("muestra folio PRUEBA, renglones, total del servidor y la etiqueta fija", () => {
    rendered = renderComponent(<TarjetaPedidoSimulado pedido={pedidoSimuladoDe(SIMULADO)!} />);
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("PRUEBA-1A2B");
    expect(texto).toContain("1 × Tacos de pastor (orden de 3)");
    expect(texto).toContain("$164.00");
    expect(texto).toContain("Prueba: no se crean pedidos ni se avisa a nadie.");
  });
});
