// @vitest-environment jsdom
//
// REQ-r6 (seguimiento de PR #164, punto 2): el fix anterior (citas-agenda-rango-
// label.spec.tsx) solo corrigió la ETIQUETA de <AgendaPage /> -- forzando `timeZone:
// "UTC"` en los formatters. Pero `anchor` (la fecha ancla de la vista mes/semana) seguía
// siendo `new Date()` -- el INSTANTE actual, no un día anclado a UTC -- y
// `startOfWeek`/`computeRange` leen su calendario con getters `UTC*`. Entre las 18:00 y
// las 23:59 de America/Mexico_City (00:00-05:59 UTC), el día/mes UTC de ese instante YA
// es el de MAÑANA, así que la semana/mes que se pedía al servidor (`fromIso`/`toIso`)
// era la SIGUIENTE, no la real -- aunque la etiqueta (ya corregida) mostrara el día
// correcto PARA ESE `anchor` ya corrido. Este test verifica el RANGO pedido al
// servidor, no solo la etiqueta.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaPage } from "../src/verticals/citas/pages/Agenda.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let appointmentsUrls: string[] = [];

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

beforeEach(() => {
  appointmentsUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/providers")) return jsonResponse({ providers: [] });
      if (url.includes("/appointments")) {
        appointmentsUrls.push(url);
        return jsonResponse({ appointments: [] });
      }
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

// 2026-10-01T04:00:00Z = 2026-09-30T22:00:00 en America/Mexico_City (UTC-6 fijo) -- el
// día de NEGOCIO sigue siendo 30 de septiembre; el día UTC ya es 1 de octubre.
const INSTANTE_22H_CDMX_30_SEP = "2026-10-01T04:00:00.000Z";

// 2026-09-28T04:00:00Z = 2026-09-27T22:00:00 en CDMX -- el día de NEGOCIO es domingo
// 27-sep (semana que empieza el lunes 21-sep); el día UTC ya es lunes 28-sep (semana
// SIGUIENTE, la que empieza el lunes 28-sep mismo) -- a diferencia del caso de mes de
// arriba, este instante SÍ cruza también el límite de SEMANA (28-sep es lunes), lo que
// el otro no garantizaba (ambos días caían en la misma semana).
const INSTANTE_22H_CDMX_27_SEP_DOMINGO = "2026-09-28T04:00:00.000Z";

describe("AgendaPage (citas) — el RANGO pedido al servidor usa el día de NEGOCIO, no el día UTC", () => {
  it("vista de mes, a las 22:00 CDMX del 30-sep: pide el rango de SEPTIEMBRE, nunca el de octubre", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_30_SEP));

    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperarCarga();

    expect(appointmentsUrls.length).toBeGreaterThan(0);
    const url = new URL(appointmentsUrls.at(-1)!);
    // Control del bug: con `anchor = new Date()` sin anclar al día de negocio, el mes UTC
    // de ese instante ya sería octubre -> from = 2026-10-01, to = 2026-11-01. Con el fix,
    // el mes de NEGOCIO sigue siendo septiembre.
    expect(url.searchParams.get("from")).toBe("2026-09-01T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("vista de semana, a las 22:00 CDMX del domingo 27-sep: pide la semana que empieza el lunes 21-sep, nunca la del lunes 28-sep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_27_SEP_DOMINGO));

    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperarCarga();

    const semanaTab = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Semana")!;
    act(() => {
      semanaTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      semanaTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await esperarCarga();

    const url = new URL(appointmentsUrls.at(-1)!);
    // 27-sep-2026 (día de NEGOCIO) es domingo -> pertenece a la semana que empieza el
    // lunes 21-sep. Con el bug (anchor = 28-sep UTC, ya lunes), `startOfWeek` habría dado
    // ESE mismo lunes 28-sep -- una semana completa adelantada.
    expect(url.searchParams.get("from")).toBe("2026-09-21T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-09-28T00:00:00.000Z");
  });
});
