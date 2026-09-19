// @vitest-environment jsdom
//
// REQ (revisión de PR #164, "no bloqueante" #4): `OperationalSummary` (DashboardPage,
// hoteles) calculaba `today` con `isoDate(new Date())` -- el día UTC -- y lo comparaba
// contra `checkInDate`/`checkOutDate` (columnas `date`) para las tarjetas "Llegadas"/
// "Salidas". Entre las 18:00 y las 23:59 hora de CDMX (00:00-05:59 UTC) el día UTC ya es
// MAÑANA, así que esas tarjetas contaban las llegadas/salidas de MAÑANA, no de hoy. Mismo
// bug exacto que el que este PR ya corrigió en `Asistencia.tsx` (ver
// hoteles-asistencia-fecha-default.spec.tsx) -- aquí en el punto donde el encargo
// original nombraba explícitamente check-in/check-out. Fijamos el reloj del sistema en
// ese mismo rango horario para reproducirlo.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "../src/verticals/hoteles/pages/Dashboard.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { ReservationSummary } from "../src/verticals/hoteles/lib/reservas-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// role "frontdesk" -> OperationalSummary (no es de EXECUTIVE_ROLES), y sí está en
// TICKETS_VISIBLE_ROLES -- mockeamos también `mantenimiento/tickets` para que no truene.
const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "frontdesk",
  staffFullName: "Recepción Demo",
  staffEmail: "recepcion@example.com",
};

const RESERVA_BASE: Omit<ReservationSummary, "id" | "checkInDate" | "checkOutDate" | "estado"> = {
  propertyId: "prop-1",
  roomTypeId: "rt-1",
  guestId: null,
  montoTotal: 1200,
  penalizacionCancelacion: null,
  canceladaEn: null,
  creadaEn: "2026-09-18T10:00:00.000Z",
  roomId: null,
};

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

function statCardValue(container: HTMLElement, label: string): string | null | undefined {
  const labelSpan = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === label);
  const card = labelSpan?.closest(".bg-card");
  return card?.querySelector("p.font-display")?.textContent;
}

describe("DashboardPage (hoteles) — Llegadas/Salidas de hoy usan el día de calendario CDMX, no UTC", () => {
  it("a las 22:00 hora de CDMX (04:00 UTC del día siguiente), 'hoy' sigue siendo el día real en CDMX", async () => {
    // 2026-01-01T22:00:00-06:00 == 2026-01-02T04:00:00Z: el patrón viejo (`isoDate(new
    // Date())`) habría dado "2026-01-02" (mañana en CDMX) y no habría contado esta
    // reserva como llegada/salida de hoy.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T04:00:00.000Z"));

    const reservas: ReservationSummary[] = [
      { ...RESERVA_BASE, id: "res-llega-hoy", checkInDate: "2026-01-01", checkOutDate: "2026-01-03", estado: "confirmada" },
      { ...RESERVA_BASE, id: "res-sale-hoy", checkInDate: "2025-12-30", checkOutDate: "2026-01-01", estado: "en_estancia" },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/reservas")) return jsonResponse(reservas);
        if (url.includes("/mantenimiento/tickets")) return jsonResponse([]);
        throw new Error(`fetch inesperado en el test: ${url}`);
      }),
    );

    rendered = renderComponent(
      <MemoryRouter>
        <DashboardPage {...CTX} />
      </MemoryRouter>,
    );
    await esperarCarga();

    expect(statCardValue(rendered.container, "Llegadas")).toBe("1");
    expect(statCardValue(rendered.container, "Salidas")).toBe("1");
  });
});
