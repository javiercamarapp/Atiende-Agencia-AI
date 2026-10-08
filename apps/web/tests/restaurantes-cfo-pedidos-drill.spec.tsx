// @vitest-environment jsdom
//
// <PedidosDrill />: una respuesta vieja (otro filtro) nunca pisa la lista del filtro actual ni se mezcla con «Cargar más».
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PedidosDrill } from "../src/verticals/restaurantes/cfo/PedidosDrill.tsx";
import { filtrosPorDefecto } from "../src/verticals/restaurantes/cfo/filtros-url.ts";
import { API, PROPIEDAD } from "./test-utils/cfo-api-simulada.ts";
import { esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const fila = (n: number) => ({ orderId: `o${n}`, orderNumber: String(n), propertyId: "p", diaNegocio: "2026-09-27", horaLocal: 13, canal: "domicilio", source: "voice", status: "entregado", paymentMethod: "efectivo", brutaCentavos: 1000, descCentavos: 0, netaCentavos: 1000, propinaCentavos: 0, entregadoMin: 30, esCompensacion: false, esReposicion: false, clienteAlias: "abcd1234", comandaEstado: null });
const vista = (pedidos: unknown[], cursor: string | null = null) => ({ pedidos, cursor, limite: 25, disponible: true, avisos: [] });
const res = (cuerpo: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => cuerpo }) as unknown as Response;

describe("<PedidosDrill /> · respuestas viejas", () => {
  it("si el filtro cambia mientras la primera petición sigue en vuelo, gana la última y la vieja se descarta", async () => {
    let soltarLenta: (r: Response) => void = () => undefined;
    const lenta = new Promise<Response>((r) => (soltarLenta = r));
    const f = vi.fn(async (url: RequestInfo | URL) => {
      const filtro = new URL(String(url)).searchParams.get("filtro") ?? "";
      return filtro.includes("cancelado") ? lenta : res(vista([fila(2)]));
    });
    const props = { abierto: true, onCerrar: () => undefined, api: { fetchImpl: f as unknown as typeof fetch, apiBaseUrl: API, token: "t", propertyId: PROPIEDAD }, base: "/restaurantes/demo", filtros: filtrosPorDefecto("2026-09-28") };
    rendered = renderComponent(
      <MemoryRouter>
        <PedidosDrill {...props} filtroPedidos={{ status: "cancelado" }} />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    rendered.rerender(
      <MemoryRouter>
        <PedidosDrill {...props} filtroPedidos={{ status: "entregado" }} />
      </MemoryRouter>,
    );
    await esperarHasta(() => document.body.querySelectorAll("[data-pedido=o2]").length === 1, "lista del filtro nuevo");
    await act(async () => {
      soltarLenta(res(vista([fila(1)])));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.querySelectorAll("[data-pedido=o1]")).toHaveLength(0);
    expect(document.body.querySelectorAll("[data-pedido=o2]")).toHaveLength(1);
  });
});
