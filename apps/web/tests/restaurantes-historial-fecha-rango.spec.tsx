// @vitest-environment jsdom
//
// REQ (revisión de PR #164, "no bloqueante" #2 -- punto 4 del encargo original, sin
// cubrir en el PR inicial): `HistorialPage` (restaurantes) convertía el valor de los
// `<input type="date">` "Desde"/"Hasta" con `new Date(valor).toISOString()` -- la
// medianoche UTC de ese día, que en CDMX (UTC-6) es las 18:00 del día ANTERIOR local. El
// servidor filtra `created_at >= dateFrom`/`created_at < dateTo` (columnas
// `timestamptz` reales, ver postgres-repository.ts de domain-restaurantes) contra el
// día de calendario del NEGOCIO: "hasta el 15" debía incluir TODO el 15 local, y en
// cambio excluía el día completo. Verificado con TZ=America/Mexico_City.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistorialPage } from "../src/verticals/restaurantes/pages/Historial.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Staff Demo",
  staffEmail: "staff@example.com",
};

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ orders: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}

function ultimaUrlLlamada(): URL {
  const llamada = fetchMock.mock.calls.at(-1);
  return new URL(String(llamada?.[0]));
}

describe("HistorialPage (restaurantes) -- filtro de fecha usa el día de calendario CDMX del negocio, no la medianoche UTC del navegador", () => {
  it("'Desde' manda la medianoche LOCAL de ese día (no la medianoche UTC, que es el día anterior en CDMX)", async () => {
    rendered = renderComponent(<HistorialPage {...CTX} />);
    await esperarCarga();

    const desde = rendered.container.querySelector<HTMLInputElement>("#restaurantes-historial-desde")!;
    changeValue(desde, "2026-08-15");
    await esperarCarga();

    const url = ultimaUrlLlamada();
    expect(url.searchParams.get("dateFrom")).toBe("2026-08-15T06:00:00.000Z");
    // Confirma el bug del patrón viejo: la medianoche UTC de ese día NO es lo que se mandó.
    expect(url.searchParams.get("dateFrom")).not.toBe(new Date("2026-08-15").toISOString());
  });

  it("'Hasta el 15' incluye TODO el día 15 local -- el límite exclusivo mandado al servidor es la medianoche del día 16, no del 15", async () => {
    rendered = renderComponent(<HistorialPage {...CTX} />);
    await esperarCarga();

    const hasta = rendered.container.querySelector<HTMLInputElement>("#restaurantes-historial-hasta")!;
    changeValue(hasta, "2026-08-15");
    await esperarCarga();

    const url = ultimaUrlLlamada();
    // Con el patrón viejo (`new Date("2026-08-15").toISOString()`), un pedido creado a
    // las 23:00 CDMX del día 15 (2026-08-16T05:00:00.000Z) habría quedado FUERA del rango
    // (`created_at < dateTo` con dateTo = 2026-08-15T00:00:00.000Z). Con el fix, el
    // límite exclusivo es la medianoche del día SIGUIENTE en CDMX.
    expect(url.searchParams.get("dateTo")).toBe("2026-08-16T06:00:00.000Z");
    const pedidoTardeDelDia15 = new Date("2026-08-16T05:00:00.000Z").getTime();
    expect(pedidoTardeDelDia15 < new Date(url.searchParams.get("dateTo")!).getTime()).toBe(true);
  });
});
