// @vitest-environment jsdom
//
// H-35 -- cotizador (POST /hoteles/:propertyId/quotes sin UI hasta ahora): cliente + panel. `fetch` global mockeado por ruta real
// contra apps/api/.../hoteles/quotes.ts. El body NUNCA lleva un precio; los errores del motor (409 sin tarifa) se muestran tal cual.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cotizar, validarCotizacion } from "../src/verticals/hoteles/lib/cotizador-client.ts";
import { CotizadorPanel } from "../src/verticals/hoteles/pages/CotizadorPanel.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const COTIZACION = {
  roomTypeId: "t1",
  nights: 2,
  currency: "MXN",
  netAmount: 3000,
  ivaAmount: 480,
  ishAmount: 90,
  totalAmount: 3570,
  nightlyBreakdown: [
    { date: "2026-12-01", price: 1500 },
    { date: "2026-12-02", price: 1500 },
  ],
};

function stubFetch(quote: Response | ((init: RequestInit) => Response)) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/hoteles/prop-1/tipos-habitacion")) return json([{ id: "t1", nombre: "Doble", capacidadMaxima: 2 }]);
    if (method === "POST" && url.endsWith("/hoteles/prop-1/quotes")) return typeof quote === "function" ? quote(init!) : quote;
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const montar = () => {
  rendered = renderComponent(<CotizadorPanel apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
};
const llenar = () => {
  const c = rendered!.container;
  changeValue(c.querySelector("#cot-tipo") as HTMLSelectElement, "t1");
  changeValue(c.querySelector("#cot-entrada") as HTMLInputElement, "2026-12-01");
  changeValue(c.querySelector("#cot-salida") as HTMLInputElement, "2026-12-03");
};

describe("cotizador-client", () => {
  it("manda solo tipo y fechas (nunca un precio) y devuelve el desglose del servidor", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify(COTIZACION), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await cotizar(impl, "http://api.local", "tok", "prop-1", { roomTypeId: "t1", checkInDate: "2026-12-01", checkOutDate: "2026-12-03" });
    expect(r.totalAmount).toBe(3570);
    expect(calls).toEqual([{ url: "http://api.local/hoteles/prop-1/quotes", body: { roomTypeId: "t1", checkInDate: "2026-12-01", checkOutDate: "2026-12-03" } }]);
  });

  it("validarCotizacion exige tipo, fechas validas y salida posterior", () => {
    expect(validarCotizacion("", "2026-12-01", "2026-12-03")).toMatch(/tipo/);
    expect(validarCotizacion("t1", "", "2026-12-03")).toMatch(/fechas/);
    expect(validarCotizacion("t1", "2026-12-03", "2026-12-03")).toMatch(/posterior/);
    expect(validarCotizacion("t1", "2026-12-01", "2026-12-03")).toBeNull();
  });
});

describe("CotizadorPanel", () => {
  it("cotiza y muestra noches, neto, IVA, ISH y total", async () => {
    stubFetch(json(COTIZACION));
    montar();
    await esperar();
    llenar();
    await submitForm(rendered!.container.querySelector("form") as HTMLFormElement);
    await esperar();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("2 noches · MXN");
    expect(t).toContain("$3,000.00");
    expect(t).toContain("$480.00");
    expect(t).toContain("$90.00");
    expect(t).toContain("$3,570.00");
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(JSON.parse(post[1].body as string)).toEqual({ roomTypeId: "t1", checkInDate: "2026-12-01", checkOutDate: "2026-12-03" });
  });

  it("un error del motor (409 sin tarifa) se muestra y no queda ningun precio", async () => {
    stubFetch(json({ code: "sin_tarifa", message: "No hay tarifa cargada para 2026-12-02." }, 409));
    montar();
    await esperar();
    llenar();
    await submitForm(rendered!.container.querySelector("form") as HTMLFormElement);
    await esperar();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("No hay tarifa cargada para 2026-12-02.");
    expect(t).not.toContain("Total");
  });

  it("sin datos completos no llama al servidor", async () => {
    stubFetch(json(COTIZACION));
    montar();
    await esperar();
    await submitForm(rendered!.container.querySelector("form") as HTMLFormElement);
    expect(rendered!.container.textContent).toContain("Elige un tipo de habitación.");
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });
});
