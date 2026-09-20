// @vitest-environment jsdom
//
// Mismo patrón exacto que Vencimientos.tsx (hallazgo de auditoría a4, dimensión
// web-contrato, severidad baja, mismo texto de fix): `NominaPage` precargaba
// month/year con `new Date().getUTCMonth()`/`getUTCFullYear()` -- el día UTC del
// navegador, no el día de calendario del negocio. El último día del mes por la
// tarde/noche CDMX precargaba el MES SIGUIENTE (y el 31-dic el AÑO siguiente). Se
// afirma el EFECTO: los valores de los inputs #nomina-mes/#nomina-anio con los que
// arranca la pantalla son los del día de calendario CDMX, nunca el día UTC.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NominaPage } from "../src/verticals/despachos/pages/Nomina.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
});

// role "admin" -> NOMINA_ROLES.
const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

function inputValues(container: HTMLElement): { mes: string; anio: string } {
  const mes = (container.querySelector("#nomina-mes") as HTMLInputElement).value;
  const anio = (container.querySelector("#nomina-anio") as HTMLInputElement).value;
  return { mes, anio };
}

describe("NominaPage (despachos) -- default de mes/año usa el día de calendario CDMX, no UTC", () => {
  it("un día cualquiera a media tarde, el default es el mes/año de hoy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T18:00:00.000Z")); // 12:00 CDMX, sin cruce de día
    rendered = renderComponent(<NominaPage {...CTX} />);
    expect(inputValues(rendered.container)).toEqual({ mes: "6", anio: "2026" });
  });

  it("último día del mes a las 19:30 hora de CDMX (01:30 UTC del día siguiente): el default sigue siendo el mes de CDMX, no el mes UTC (que ya sería el siguiente)", () => {
    // 2026-02-28T19:30:00-06:00 == 2026-03-01T01:30:00Z.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T01:30:00.000Z"));
    rendered = renderComponent(<NominaPage {...CTX} />);
    expect(inputValues(rendered.container)).toEqual({ mes: "2", anio: "2026" });
  });

  it("31 de diciembre a las 19:30 hora de CDMX (01:30 UTC del 1-ene): el default sigue siendo diciembre del año viejo, no enero del año UTC siguiente", () => {
    // 2026-12-31T19:30:00-06:00 == 2027-01-01T01:30:00Z.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T01:30:00.000Z"));
    rendered = renderComponent(<NominaPage {...CTX} />);
    expect(inputValues(rendered.container)).toEqual({ mes: "12", anio: "2026" });
  });
});
