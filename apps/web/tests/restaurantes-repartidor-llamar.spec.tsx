// @vitest-environment jsdom
//
// Privacidad: la vista (legada) del repartidor pinta el telefono ENMASCARADO que manda la API y el boton «Llamar» pide el numero real a
// `POST .../repartidor/orders/:id/llamar` (auditado en el servidor); nunca arma un `tel:` con lo que vino en el listado.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepartidorPedidosView } from "../src/verticals/restaurantes/pages/Repartidor.tsx";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const API = "https://api.test";
const LISTA = `${API}/v1/restaurantes/prop-1/repartidor/orders`;
const LLAMAR = `${API}/v1/restaurantes/prop-1/repartidor/orders/ord-1/llamar`;

const pedido = {
  id: "ord-1", propertyId: "prop-1", branch: "T7", customerName: "Cliente de prueba", customerPhone: "******4567", customerAddress: "Calle 1", total: 164,
  status: "en_camino", items: [{ id: "i1", name: "Tacos", price: 164, quantity: 1 }], notes: null, paymentMethod: null, estimatedDeliveryAt: null, incidentNote: null,
  createdAt: "2026-10-24T12:00:00.000Z",
};

const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

describe("RepartidorPedidosView: Llamar", () => {
  it("pinta el telefono enmascarado y Llamar pide el numero real al servidor (sin enlace tel: en la lista)", async () => {
    const llamadas: string[] = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push(`${init?.method ?? "GET"} ${url}`);
      if (url === LISTA) return res(200, { orders: [pedido] });
      if (url === LLAMAR) return res(200, { telefono: "+529991234567" });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    rendered = renderComponent(<RepartidorPedidosView apiBaseUrl={API} token="t" propertyId="prop-1" />);
    await settle();

    expect(document.body.textContent).toContain("4567");
    expect(document.body.textContent).not.toContain("9991234567");
    expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
    expect(llamadas).not.toContain(`POST ${LLAMAR}`);

    const boton = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Llamar"));
    expect(boton).toBeTruthy();
    click(boton!);
    await settle();
    expect(llamadas).toContain(`POST ${LLAMAR}`);
  });

  it("un pedido entregado ya no ofrece Llamar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { orders: [{ ...pedido, status: "entregado" }] })));
    rendered = renderComponent(<RepartidorPedidosView apiBaseUrl={API} token="t" propertyId="prop-1" />);
    await settle();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Llamar"))).toBe(false);
  });
});
