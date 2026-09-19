// @vitest-environment jsdom
//
// REQ (revisión de PR #164, "no bloqueante" #3): la etiqueta de rango de <AgendaPage />
// ("Semana del ..."/el mes) se arma sobre un valor de solo-FECHA anclado a medianoche
// UTC (mismo patrón que `parseFechaSolo`) -- formatearlo sin fijar `timeZone: "UTC"`
// usaba la zona del entorno (`process.env.TZ`), y en CDMX (offset negativo) mostraba el
// día/mes ANTERIOR al real: "domingo, 13 de septiembre" para la semana del LUNES 14, y
// "agosto de 2026" viendo septiembre. Se fija `process.env.TZ = "America/Mexico_City"`
// para reproducir el entorno exacto reportado (mismo truco que formato-fecha.spec.ts).
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaPage } from "../src/verticals/citas/pages/Agenda.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const TZ_ORIGINAL = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Mexico_City";
});

afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

let rendered: RenderedComponent | undefined;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const CTX: CitasShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  orgId: "org-1",
  role: "owner",
  staffFullName: "Staff Demo",
  staffEmail: "staff@example.com",
};

function clickTab(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/providers")) return jsonResponse({ providers: [] });
      if (url.includes("/appointments")) return jsonResponse({ appointments: [] });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("AgendaPage (citas) — la etiqueta de rango muestra el día/mes real, no el anterior por la zona del entorno", () => {
  it("vista de mes: viendo septiembre de 2026, la etiqueta dice 'septiembre de 2026', nunca 'agosto'", async () => {
    // Cualquier instante real de septiembre alcanza -- el mes de `anchor` se lee con
    // getUTCMonth(), que no depende de TZ.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00.000Z"));

    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperarCarga();

    expect(rendered.container.textContent).toContain("septiembre de 2026");
    expect(rendered.container.textContent).not.toContain("agosto de 2026");
  });

  it("vista de semana: la semana del lunes 14 de septiembre de 2026 dice 'lunes, 14', nunca 'domingo, 13'", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00.000Z")); // miércoles de esa semana

    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperarCarga();

    const semanaTab = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Semana")!;
    clickTab(semanaTab);
    await esperarCarga();

    const texto = rendered.container.textContent!;
    expect(texto).toContain("lunes, 14 de septiembre");
    expect(texto).not.toContain("domingo, 13 de septiembre");
  });
});
