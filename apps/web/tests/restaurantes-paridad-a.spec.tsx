// @vitest-environment jsdom
//
// Paridad con el repo suelto (grupo A): Historial con las columnas del original (cliente + telefono, N° de pedido, sucursal, monto, estado,
// fecha), conteo honesto y clic de fila que abre el detalle a pagina completa con «Volver»; y la grafica de Tendencias del Resumen con ejes.
import { act } from "react";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { HistorialPage } from "../src/verticals/restaurantes/pages/Historial.tsx";
import { GraficaTendencia, techoRedondo } from "../src/verticals/restaurantes/components/GraficaTendencia.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Sam", staffEmail: "s@example.com" } as RestaurantesShellContext;

function orden(id: string, nombre: string, numero: number) {
  return { id, orderNumber: numero, propertyId: "prop-1", branch: "Centro", customerId: null, customerName: nombre, customerPhone: "+529990000000", customerAddress: null, total: 286, status: "entregado", items: [], source: "web", notes: null, paymentMethod: "efectivo", createdAt: "2026-10-23T16:44:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null };
}
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const texto = () => (rendered!.container.textContent ?? "") + (document.body.textContent ?? "");

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("Historial: paridad con el original", () => {
  it("columnas del original, conteo y clic de fila abre el detalle con Volver", async () => {
    const peticiones: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        peticiones.push(url);
        if (/\/admin\/orders\/ord-1(\?|$)/.test(url)) return json({ order: orden("ord-1", "Marisol Pech", 1001) });
        return json({ orders: [orden("ord-1", "Marisol Pech", 1001)], nextCursor: null });
      }),
    );
    rendered = renderComponent(<HistorialPage {...CTX} />);
    await esperar();
    const cabeceras = [...rendered.container.querySelectorAll("th")].map((th) => th.textContent?.trim());
    expect(cabeceras.slice(0, 6)).toEqual(["Cliente", "N° de pedido", "Sucursal", "Monto", "Estado", "Fecha"]);
    expect(texto()).toContain("+529990000000");
    expect(texto()).toContain("Mostrando 1");
    expect(texto()).toContain("$286");

    const fila = [...rendered.container.querySelectorAll("tbody tr")][0] as HTMLElement;
    click(fila);
    await esperar();
    expect(peticiones.some((u) => /\/admin\/orders\/ord-1(\?|$)/.test(u))).toBe(true);
    const volver = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Volver"));
    expect(volver).toBeTruthy();
    click(volver!);
    await esperar();
    expect(rendered.container.querySelectorAll("th").length).toBeGreaterThan(0);
  });
});

describe("GraficaTendencia", () => {
  it("techoRedondo cae en 1, 2, 5 x 10^n y nunca es cero", () => {
    expect(techoRedondo(0)).toBe(4);
    expect(techoRedondo(3)).toBe(5);
    expect(techoRedondo(18450)).toBe(20000);
    expect(techoRedondo(96)).toBe(100);
  });

  it("pinta eje Y, etiquetas X y un punto por cubeta con su cifra exacta", () => {
    rendered = renderComponent(
      <GraficaTendencia
        puntos={[
          { etiqueta: "Lun", valor: 2100 },
          { etiqueta: "Mar", valor: 2410 },
          { etiqueta: "Mié", valor: 0 },
        ]}
        etiquetaSerie="Ventas ($)"
        formatoValor={(v) => `$${v}`}
      />,
    );
    const svg = rendered.container.querySelector("[data-testid=grafica-tendencia]")!;
    expect(svg.querySelectorAll("circle").length).toBe(3);
    const textos = [...svg.querySelectorAll("text")].map((t) => t.textContent);
    expect(textos).toContain("$0");
    expect(textos).toContain("$5000");
    expect(textos).toEqual(expect.arrayContaining(["Lun", "Mar", "Mié"]));
    expect(svg.querySelector("circle title")?.textContent).toBe("Lun: $2100");
  });

  it("sin cubetas avisa en vez de dibujar una linea plana", () => {
    rendered = renderComponent(<GraficaTendencia puntos={[]} etiquetaSerie="Ventas ($)" formatoValor={String} />);
    expect(rendered.container.querySelector("[data-testid=tendencia-sin-datos]")?.textContent).toBe("Sin datos en este periodo");
    expect(rendered.container.querySelector("svg")).toBeNull();
  });
});
