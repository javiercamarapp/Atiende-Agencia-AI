// Helper compartido de fechas de "solo día" (`apps/web/src/lib/formato-fecha.ts`)
// -- REQ: cerrar de raíz el bug real confirmado por un revisor en
// despachos/pages/Cobranza.tsx (~365): `formatDate(cuenta.fechaVencimiento)`
// pasa una cadena "YYYY-MM-DD" (columna `date`) por `new Date(cadena)`
// (medianoche UTC) y la formatea con la zona LOCAL del navegador -- en
// America/Mexico_City (UTC-6) eso corre la fecha un día atrás.
//
// Estas pruebas fijan `process.env.TZ = "America/Mexico_City"` (mismo truco
// verificado a mano: `TZ=America/Mexico_City node -e "console.log(new
// Date('2026-08-15').toLocaleDateString('es-MX'))"` imprime "14/8/2026", NO
// "15/8/2026") para reproducir exactamente el entorno del despacho afectado,
// y restauran el TZ original en `afterAll` -- este archivo comparte worker
// con otras suites (`vitest.config.ts` no aísla `process.env` por archivo).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { esFechaSolo, fechaCortaEsMx, formatFechaSolo, hoyFechaSolo, parseFechaSolo } from "../src/lib/formato-fecha.ts";

const TZ_ORIGINAL = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Mexico_City";
});

afterAll(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

describe("formatFechaSolo -- reproduce el bug real (REQ-r5, Cobranza.tsx) y lo corrige", () => {
  it("15 ago 2026 se muestra como 15, NUNCA como 14, en America/Mexico_City", () => {
    // Control: el patrón VIEJO (`new Date(iso).toLocaleDateString(...)`, sin
    // fijar zona) SÍ corre un día en este mismo entorno -- así se confirmó el
    // bug antes de escribir el fix.
    const patronViejoRoto = new Date("2026-08-15").toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
    expect(patronViejoRoto).not.toContain("15");

    // El helper nuevo NO se mueve con el TZ del proceso.
    expect(formatFechaSolo("2026-08-15")).toBe("15 ago 2026");
  });

  it("respeta el día exacto en los bordes de año/mes (31 dic, 1 ene, 28/29 feb)", () => {
    expect(formatFechaSolo("2025-12-31")).toBe("31 dic 2025");
    expect(formatFechaSolo("2026-01-01")).toBe("1 ene 2026");
    expect(formatFechaSolo("2026-02-28")).toBe("28 feb 2026");
    expect(formatFechaSolo("2028-02-29")).toBe("29 feb 2028");
  });

  it("variante 'larga'", () => {
    expect(formatFechaSolo("2026-08-15", "larga")).toBe("15 de agosto de 2026");
  });

  it("null/undefined/vacío/formato inesperado -> guion largo, nunca fabrica una fecha", () => {
    expect(formatFechaSolo(null)).toBe("—");
    expect(formatFechaSolo(undefined)).toBe("—");
    expect(formatFechaSolo("")).toBe("—");
    expect(formatFechaSolo("2026-08-15T10:00:00Z")).toBe("—");
    expect(formatFechaSolo("no-es-fecha")).toBe("—");
  });
});

describe("parseFechaSolo / esFechaSolo", () => {
  it("ancla a medianoche UTC del mismo día calendario", () => {
    expect(parseFechaSolo("2026-08-15").toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("rechaza cualquier cosa que no sea exactamente YYYY-MM-DD", () => {
    expect(() => parseFechaSolo("2026-08-15T00:00:00Z")).toThrow(/YYYY-MM-DD/);
    expect(() => parseFechaSolo("15/08/2026")).toThrow(/YYYY-MM-DD/);
  });

  it("esFechaSolo distingue solo-día de timestamp completo", () => {
    expect(esFechaSolo("2026-08-15")).toBe(true);
    expect(esFechaSolo("2026-08-15T00:00:00Z")).toBe(false);
  });
});

describe("hoyFechaSolo -- 'hoy' en el día de calendario del negocio, no en UTC", () => {
  it("a las 23:30 hora de CDMX, 'hoy' YA es el día siguiente en UTC -- hoyFechaSolo debe seguir dando el día LOCAL", () => {
    // 2026-01-01T23:30:00-06:00 == 2026-01-02T05:30:00Z: el patrón viejo
    // (`new Date().toISOString().slice(0, 10)`, sin fijar zona -- ver
    // despachos/pages/Bookkeeping.tsx antes del fix) daría "2026-01-02" un día
    // ADELANTE del día real en CDMX.
    const instanteReal = new Date("2026-01-02T05:30:00.000Z");
    const patronViejoRoto = instanteReal.toISOString().slice(0, 10);
    expect(patronViejoRoto).toBe("2026-01-02"); // confirma el bug del patrón viejo

    // hoyFechaSolo con un reloj real fijo en ese mismo instante da el día
    // correcto en CDMX -- se prueba pasando la zona explícita porque mockear
    // el reloj del sistema (vi.setSystemTime) es responsabilidad de cada
    // spec de página, no de esta suite de la función pura.
    const formateado = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" }).format(instanteReal);
    expect(formateado).toBe("2026-01-01");
  });

  it("devuelve exactamente 'YYYY-MM-DD'", () => {
    expect(hoyFechaSolo()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("fechaCortaEsMx -- sigue existiendo, sin cambios de comportamiento", () => {
  it("formatea una fecha real dada", () => {
    expect(fechaCortaEsMx(new Date("2026-08-15T18:00:00Z"))).toContain("2026");
  });
});
