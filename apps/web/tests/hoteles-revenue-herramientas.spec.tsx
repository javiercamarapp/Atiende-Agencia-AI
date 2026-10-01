// @vitest-environment jsdom
//
// H-35 -- herramientas de Revenue (POST revenue/explicacion-precio, revenue/verificacion-paridad y revenue/compset/verificacion,
// que existian sin UI): clientes y panel. `fetch` global mockeado por ruta real contra apps/api/.../hoteles/revenue.ts. El
// servidor valida y calcula; el panel muestra su respuesta tal cual (un 422 de compset es un "no", no un error de red).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explicarPrecio, verificarCompset, verificarParidad } from "../src/verticals/hoteles/lib/revenue-client.ts";
import { RevenueHerramientas } from "../src/verticals/hoteles/pages/RevenueHerramientas.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const EXPLICACION = {
  hotelId: "prop-1",
  fecha: "2026-12-24",
  direction: "sube",
  deltaPct: 12.5,
  headline: "Sube 12.5%: de $2,000.00 a $2,250.00 MXN.",
  factors: [{ kind: "pickup", text: "El pick-up va 18% por encima de lo esperado.", magnitude: 18 }],
  fullText: "Sube 12.5% ...",
};
const PARIDAD_ROTA = {
  mode: "bloquea",
  proposedRate: 1500,
  allowed: false,
  violations: [{ channel: "booking.com", referenceRate: 2000, floorRate: 1900, deficitPct: 21.05 }],
  reasons: ["paridad_rota:booking.com: ..."],
};

describe("revenue-client (herramientas)", () => {
  it("explicarPrecio manda hotelId = la property y los factores; verificarParidad arma config + tarifa propuesta", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify(EXPLICACION), { status: 200 });
    }) as unknown as typeof fetch;
    await explicarPrecio(impl, "http://api.local", "tok", "prop-1", { fecha: "2026-12-24", currentPrice: 2000, recommendedPrice: 2250, currency: "MXN", factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 18 }] });
    await verificarParidad(impl, "http://api.local", "tok", "prop-1", { mode: "alerta", channels: [{ channel: "booking.com", referenceRate: 2000, toleranceAllowedPct: 5 }], proposedRate: 1950 });
    expect(calls[0]).toEqual({
      url: "http://api.local/hoteles/prop-1/revenue/explicacion-precio",
      body: { hotelId: "prop-1", fecha: "2026-12-24", currentPrice: 2000, recommendedPrice: 2250, currency: "MXN", factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 18 }] },
    });
    expect(calls[1]).toEqual({
      url: "http://api.local/hoteles/prop-1/revenue/verificacion-paridad",
      body: { config: { hotelId: "prop-1", mode: "alerta", channels: [{ channel: "booking.com", referenceRate: 2000, toleranceAllowedPct: 5 }] }, proposedRate: 1950 },
    });
  });

  it("verificarCompset: 200 permitido, 422 no permitido con motivo, otro fallo lanza", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })) as unknown as typeof fetch;
    expect(await verificarCompset(ok, "http://api.local", "tok", "prop-1", { competitorCount: 12, monthsOfHistory: 14, hasAntitrustOpinion: true })).toEqual({ allowed: true });
    const no = vi.fn(async () => new Response(JSON.stringify({ allowed: false, motivo: "Se requieren al menos 10 hoteles competidores." }), { status: 422 })) as unknown as typeof fetch;
    expect(await verificarCompset(no, "http://api.local", "tok", "prop-1", { competitorCount: 3, monthsOfHistory: 14, hasAntitrustOpinion: true })).toEqual({ allowed: false, motivo: "Se requieren al menos 10 hoteles competidores." });
    const roto = vi.fn(async () => new Response(JSON.stringify({ code: "forbidden", message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(verificarCompset(roto, "http://api.local", "tok", "prop-1", { competitorCount: 3, monthsOfHistory: 14, hasAntitrustOpinion: true })).rejects.toThrow(/permiso/);
  });
});

function stubFetch(over: { explicacion?: Response; paridad?: Response; compset?: Response } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") throw new Error(`fetch inesperado en el test: ${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/revenue/explicacion-precio")) return over.explicacion ?? json(EXPLICACION);
    if (url.endsWith("/revenue/verificacion-paridad")) return over.paridad ?? json({ ...PARIDAD_ROTA, allowed: true, violations: [], reasons: [] });
    if (url.endsWith("/revenue/compset/verificacion")) return over.compset ?? json({ allowed: true });
    throw new Error(`fetch inesperado en el test: POST ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const montar = () => {
  rendered = renderComponent(<RevenueHerramientas apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
};
const form = (nombre: string) => rendered!.container.querySelector(`form[aria-label="${nombre}"]`) as HTMLFormElement;
const campo = (id: string) => rendered!.container.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
const texto = () => rendered!.container.textContent ?? "";
const bodyDe = (sufijo: string) => JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).endsWith(sufijo))![1].body as string);

describe("RevenueHerramientas", () => {
  it("explica un precio con los factores capturados y muestra el titular y cada factor", async () => {
    stubFetch();
    montar();
    changeValue(campo("exp-fecha"), "2026-12-24");
    changeValue(campo("exp-actual"), "2000");
    changeValue(campo("exp-reco"), "2250");
    changeValue(campo("exp-pickup"), "18");
    changeValue(campo("exp-ev-nombre"), "Fiesta de fin de año");
    changeValue(campo("exp-ev-mag"), "25");
    await submitForm(form("Explicar un precio"));
    await esperar();
    expect(bodyDe("/explicacion-precio")).toEqual({
      hotelId: "prop-1",
      fecha: "2026-12-24",
      currentPrice: 2000,
      recommendedPrice: 2250,
      currency: "MXN",
      factors: [
        { kind: "pickup", onTheBooksVsExpectedPct: 18 },
        { kind: "evento", nombre: "Fiesta de fin de año", impacto: "alza_demanda", magnitudPct: 25 },
      ],
    });
    expect(texto()).toContain("Sube 12.5%: de $2,000.00 a $2,250.00 MXN.");
    expect(texto()).toContain("El pick-up va 18% por encima de lo esperado.");
  });

  it("sin factores o sin precios no llama al servidor; un rechazo del servidor se muestra", async () => {
    stubFetch({ explicacion: json({ code: "validation_error", message: "factors: como mucho un factor de cada tipo." }, 400) });
    montar();
    await submitForm(form("Explicar un precio"));
    expect(texto()).toContain("Fecha y precios");
    changeValue(campo("exp-fecha"), "2026-12-24");
    changeValue(campo("exp-actual"), "2000");
    changeValue(campo("exp-reco"), "2250");
    await submitForm(form("Explicar un precio"));
    expect(texto()).toContain("Captura al menos un factor");
    expect(fetchMock).not.toHaveBeenCalled();
    changeValue(campo("exp-pickup"), "5");
    await submitForm(form("Explicar un precio"));
    await esperar();
    expect(texto()).toContain("como mucho un factor de cada tipo");
  });

  it("paridad: manda la configuracion real y muestra la violacion con su piso", async () => {
    stubFetch({ paridad: json(PARIDAD_ROTA) });
    montar();
    changeValue(campo("par-propuesta"), "1500");
    changeValue(campo("par-canal-0"), "booking.com");
    changeValue(campo("par-ref-0"), "2000");
    changeValue(campo("par-tol-0"), "5");
    await submitForm(form("Verificar paridad"));
    await esperar();
    expect(bodyDe("/verificacion-paridad")).toEqual({ config: { hotelId: "prop-1", mode: "bloquea", channels: [{ channel: "booking.com", referenceRate: 2000, toleranceAllowedPct: 5 }] }, proposedRate: 1500 });
    expect(texto()).toContain("Rompe la paridad: bloqueada");
    expect(texto()).toContain("booking.com: piso $1,900.00");
    expect(texto()).toContain("21.05% por debajo");
  });

  it("paridad: agrega y quita canales, y valida la tarifa y los campos de cada canal", async () => {
    stubFetch();
    montar();
    await submitForm(form("Verificar paridad"));
    expect(texto()).toContain("La tarifa propuesta debe ser un número mayor a 0.");
    changeValue(campo("par-propuesta"), "1500");
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Agregar canal")!);
    expect(rendered!.container.querySelectorAll('input[id^="par-canal-"]')).toHaveLength(2);
    changeValue(campo("par-canal-0"), "expedia");
    await submitForm(form("Verificar paridad"));
    expect(texto()).toContain("Cada canal necesita nombre");
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Quitar")!);
    expect(rendered!.container.querySelectorAll('input[id^="par-canal-"]')).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("compset: un 422 se ve como 'No se puede usar el benchmark' con el motivo, un 200 como permitido", async () => {
    stubFetch({ compset: json({ allowed: false, motivo: "Se requieren al menos 10 hoteles competidores (recibidos: 3)." }, 422) });
    montar();
    changeValue(campo("cs-n"), "3");
    changeValue(campo("cs-m"), "14");
    await submitForm(form("Verificar compset"));
    await esperar();
    expect(bodyDe("/compset/verificacion")).toEqual({ competitorCount: 3, monthsOfHistory: 14, hasAntitrustOpinion: false });
    expect(texto()).toContain("No se puede usar el benchmark");
    expect(texto()).toContain("recibidos: 3");
    rendered!.unmount();
    stubFetch();
    montar();
    changeValue(campo("cs-n"), "12");
    changeValue(campo("cs-m"), "14");
    click(rendered!.container.querySelector('input[type="checkbox"]')!);
    await submitForm(form("Verificar compset"));
    await esperar();
    expect(bodyDe("/compset/verificacion")).toEqual({ competitorCount: 12, monthsOfHistory: 14, hasAntitrustOpinion: true });
    expect(texto()).toContain("Se puede usar el benchmark");
  });
});

describe("RevenuePage -- herramientas (H-35) por rol", () => {
  async function montarPagina(role: string) {
    const { RevenuePage } = await import("../src/verticals/hoteles/pages/Revenue.tsx");
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/revenue/gate")) return ok({ gate: null });
        if (url.endsWith("/revenue/backtests")) return ok([]);
        if (url.endsWith("/tipos-habitacion")) return ok([]);
        if (url.includes("/revenue/recomendaciones")) return ok({ recomendaciones: [], nextCursor: null });
        throw new Error(`fetch inesperado en el test: ${url}`);
      }),
    );
    rendered = renderComponent(<RevenuePage apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role={role} staffFullName="Ana" staffEmail="ana@example.com" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("owner y gm ven las herramientas; contabilidad (que solo captura backtests) no", async () => {
    await montarPagina("owner");
    expect(texto()).toContain("Explicar un precio recomendado");
    rendered!.unmount();
    await montarPagina("gm");
    expect(texto()).toContain("Verificar paridad con canales");
    rendered!.unmount();
    await montarPagina("accountant");
    expect(texto()).not.toContain("Explicar un precio recomendado");
    expect(texto()).not.toContain("Verificar el benchmark de compset");
  });
});
