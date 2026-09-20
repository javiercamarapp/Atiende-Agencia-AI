// @vitest-environment jsdom
//
// Mismo patrón exacto que Vencimientos.tsx/Nomina.tsx (hallazgo de auditoría a4,
// dimensión web-contrato, severidad baja, mismo texto de fix): `DiotConsulta`
// (dentro de `DeclaracionesPage`) precargaba `defaultPeriodo` con
// `new Date().getUTCFullYear()`/`getUTCMonth()` -- el día UTC del navegador, no el
// día de calendario del negocio. El último día del mes por la tarde/noche CDMX
// precargaba el MES SIGUIENTE (y el 31-dic el AÑO siguiente). Se afirma el
// EFECTO: el valor del input #diot-periodo con el que arranca la pantalla es el
// del día de calendario CDMX, nunca el día UTC.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeclaracionesPage } from "../src/verticals/despachos/pages/Declaraciones.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
});

// role "admin" -> DECLARACIONES_ROLES.
const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

function periodoValue(container: HTMLElement): string {
  return (container.querySelector("#diot-periodo") as HTMLInputElement).value;
}

describe("DeclaracionesPage (despachos) -- DiotConsulta: default de periodo usa el día de calendario CDMX, no UTC", () => {
  it("un día cualquiera a media tarde, el default es el periodo de hoy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T18:00:00.000Z")); // 12:00 CDMX, sin cruce de día
    rendered = renderComponent(<DeclaracionesPage {...CTX} />);
    expect(periodoValue(rendered.container)).toBe("2026-06");
  });

  it("último día del mes a las 19:30 hora de CDMX (01:30 UTC del día siguiente): el default sigue siendo el mes de CDMX, no el mes UTC (que ya sería el siguiente)", () => {
    // 2026-02-28T19:30:00-06:00 == 2026-03-01T01:30:00Z.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T01:30:00.000Z"));
    rendered = renderComponent(<DeclaracionesPage {...CTX} />);
    expect(periodoValue(rendered.container)).toBe("2026-02");
  });

  it("31 de diciembre a las 19:30 hora de CDMX (01:30 UTC del 1-ene): el default sigue siendo diciembre del año viejo, no enero del año UTC siguiente", () => {
    // 2026-12-31T19:30:00-06:00 == 2027-01-01T01:30:00Z.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T01:30:00.000Z"));
    rendered = renderComponent(<DeclaracionesPage {...CTX} />);
    expect(periodoValue(rendered.container)).toBe("2026-12");
  });
});
