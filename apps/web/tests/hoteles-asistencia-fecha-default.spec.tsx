// @vitest-environment jsdom
//
// REQ-r5: `todayIso()`/`sevenDaysAgoIso()` (AsistenciaPage, hoteles) usaban
// `new Date().toISOString().slice(0, 10)` -- el día UTC, no el día de
// calendario del negocio (America/Mexico_City). Entre las 18:00 y las 23:59
// hora de CDMX (00:00-05:59 UTC) eso precargaba MAÑANA en vez de HOY, tanto
// en el default del día de trabajo (`workDate`) como en el rango de consulta
// de asistencia (`hasta`). Fijamos el reloj del sistema en ese rango exacto.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsistenciaPage } from "../src/verticals/hoteles/pages/Asistencia.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/asistencia")) return jsonResponse([]);
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
  });
}

describe("AsistenciaPage (hoteles) -- default de fecha usa el día de calendario CDMX, no UTC", () => {
  it("a las 22:00 hora de CDMX (04:00 UTC del día siguiente), 'hoy'/'hasta' siguen siendo HOY en CDMX", async () => {
    // 2026-01-01T22:00:00-06:00 == 2026-01-02T04:00:00Z: el patrón viejo
    // habría precargado "2026-01-02" (mañana en CDMX) en vez de "2026-01-01".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T04:00:00.000Z"));

    rendered = renderComponent(<AsistenciaPage {...CTX} />);
    await esperarCarga();

    const workDate = rendered.container.querySelector<HTMLInputElement>("#asis-fecha");
    const hasta = rendered.container.querySelector<HTMLInputElement>("#asis-hasta");
    const desde = rendered.container.querySelector<HTMLInputElement>("#asis-desde");
    expect(workDate?.value).toBe("2026-01-01");
    expect(hasta?.value).toBe("2026-01-01");
    // sevenDaysAgoIso() ancla sobre el mismo "hoy" CDMX (2026-01-01), no sobre
    // el "hoy" UTC (2026-01-02) -- 7 días antes es 2025-12-25, no 2025-12-26.
    expect(desde?.value).toBe("2025-12-25");
  });
});
