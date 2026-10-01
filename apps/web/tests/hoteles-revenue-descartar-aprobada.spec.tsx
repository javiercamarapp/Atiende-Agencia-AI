// @vitest-environment jsdom
//
// Corrector w0 (H-22): <RevenuePage /> no ofrecía "Descartar" para una recomendación
// ya aprobada, aunque la ruta HTTP y el trigger (migrations/029) siempre permitieron
// la transición aprobada -> descartada. Test de comportamiento real: fetch mockeado
// por ruta, se renderiza la página, se hace clic en "Descartar" sobre una
// recomendación 'aprobada' y se verifica el POST .../descartar y el refresco.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevenuePage } from "../src/verticals/hoteles/pages/Revenue.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { RateRecommendation } from "../src/verticals/hoteles/lib/revenue-client.ts";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "GM Demo",
  staffEmail: "gm@example.com",
};

function rec(id: string, estado: RateRecommendation["estado"]): RateRecommendation {
  return {
    id,
    propertyId: "prop-1",
    roomTypeId: "rt-1",
    fecha: "2026-12-25",
    currentBarPrice: 1000,
    recommendedPrice: 1200,
    suggestedMinStay: 2,
    desglose: {},
    estado,
    aprobadaPor: null,
    aprobadaEn: null,
    aplicadaPor: null,
    aplicadaEn: null,
    descartadaPor: null,
    descartadaEn: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
  };
}

/** Deja resolver las cadenas de fetch/setState de la página dentro de act. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(rendered!.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label) as HTMLButtonElement[];
}

describe("RevenuePage -- descartar una recomendación ya aprobada", () => {
  it("muestra Descartar en la recomendación aprobada, hace POST .../descartar y recarga la lista", async () => {
    let estadoAprobada: RateRecommendation["estado"] = "aprobada";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/revenue/gate")) return jsonResponse({ gate: null });
      if (method === "GET" && url.endsWith("/revenue/backtests")) return jsonResponse([]);
      if (method === "GET" && url.endsWith("/tipos-habitacion")) return jsonResponse([]);
      if (method === "GET" && url.includes("/revenue/recomendaciones")) return jsonResponse({ recomendaciones: [rec("rec-1", estadoAprobada)], nextCursor: null });
      if (method === "POST" && url.endsWith("/revenue/recomendaciones/rec-1/descartar")) {
        estadoAprobada = "descartada";
        return jsonResponse(rec("rec-1", "descartada"));
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    rendered = renderComponent(<RevenuePage {...CTX} />);
    await settle();

    expect(rendered.container.textContent).toContain("Aprobada — el sistema la aplicará en su siguiente corrida.");
    const descartar = buttons("Descartar");
    expect(descartar).toHaveLength(1);
    expect(buttons("Aprobar")).toHaveLength(0);

    click(descartar[0]!);
    await settle();

    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts.map(([u]) => u)).toEqual(["https://api.test/hoteles/prop-1/revenue/recomendaciones/rec-1/descartar"]);
    expect(buttons("Descartar")).toHaveLength(0);
    expect(rendered.container.textContent).not.toContain("el sistema la aplicará en su siguiente corrida");
  });
});
