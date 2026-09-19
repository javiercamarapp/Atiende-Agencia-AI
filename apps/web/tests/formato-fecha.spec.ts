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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { esFechaSolo, fechaCortaEsMx, formatFechaSolo, hoyFechaSolo, medianocheLocalUTC, parseFechaSolo, sumarDiasFechaSolo } from "../src/lib/formato-fecha.ts";

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
    expect(formatFechaSolo("2026-08-15T10:00:00Z")).toBe("—"); // hora real, NO medianoche -> no es de solo-día
    expect(formatFechaSolo("no-es-fecha")).toBe("—");
  });

  // REQ (revisión de PR #164, bloqueante): la premisa "la API manda 'YYYY-MM-DD'" es
  // falsa contra Postgres real para despachos -- `managed-postgres-engine.ts` usa `pg`
  // sin `setTypeParser` (verificado: 0 resultados en todo el repo), así que una columna
  // `date` sin castear a `::text` llega aquí como el ISO completo que produce
  // `Date.prototype.toJSON()`/`c.json()` al serializar ("2026-08-15T00:00:00.000Z" con
  // TZ=UTC, que es Vercel), no como "2026-08-15". El arreglo de fondo es castear
  // `fecha_limite`/`fecha_presentacion`/`fecha_vencimiento` en
  // `domain-despachos/postgres-repository.ts` (`FISCAL_DEADLINE_COLUMNS`/
  // `RECEIVABLE_COLUMNS`) -- esto prueba, además, la red de seguridad de la UI: ANTES de
  // este fix, `formatFechaSolo("2026-08-15T00:00:00.000Z")` daba "—" (regresión visible:
  // TODAS las filas de Vencimientos sin fecha), no "un día antes".
  it("tolera el formato real del cable de una columna `date` sin castear (ISO anclado a medianoche UTC)", () => {
    expect(formatFechaSolo("2026-08-15T00:00:00.000Z")).toBe("15 ago 2026");
    expect(formatFechaSolo("2026-08-15T00:00:00Z")).toBe("15 ago 2026");
    expect(formatFechaSolo("2026-08-15T00:00:00.000Z", "larga")).toBe("15 de agosto de 2026");
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
  afterEach(() => {
    vi.useRealTimers();
  });

  // REQ (revisión de PR #164, evidencia del "no bloqueante" #7): antes de este test, el
  // único caso de las 23:30 CDMX probaba `Intl.DateTimeFormat` DIRECTO, nunca llamaba a
  // `hoyFechaSolo()` -- un bug real en el CUERPO de la función (typo en el nombre de la
  // zona, parámetro ignorado, etc.) habría pasado sin que ningún test lo detectara. Este
  // fija el reloj del sistema con `vi.setSystemTime` y llama a la función real.
  it("a las 23:30 hora de CDMX, 'hoy' YA es el día siguiente en UTC -- hoyFechaSolo() debe seguir dando el día LOCAL", () => {
    // 2026-01-01T23:30:00-06:00 == 2026-01-02T05:30:00Z: el patrón viejo
    // (`new Date().toISOString().slice(0, 10)`, sin fijar zona -- ver
    // despachos/pages/Bookkeeping.tsx antes del fix) daría "2026-01-02" un día
    // ADELANTE del día real en CDMX.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T05:30:00.000Z"));

    const patronViejoRoto = new Date().toISOString().slice(0, 10);
    expect(patronViejoRoto).toBe("2026-01-02"); // confirma el bug del patrón viejo

    expect(hoyFechaSolo()).toBe("2026-01-01");
  });

  it("respeta una zona horaria distinta a la default (America/Mexico_City), pasada explícitamente", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T05:30:00.000Z")); // 2026-01-01T23:30 CDMX, 2026-01-01T21:30 Cancún... no, mismo instante
    // America/Cancun es UTC-5 (sin horario de verano): a las 00:30 del 2 de enero en
    // Cancún, en CDMX (UTC-6) todavía son las 23:30 del 1 -- confirma que el parámetro
    // `zonaHoraria` SÍ se usa, no solo el default.
    expect(hoyFechaSolo("America/Cancun")).toBe("2026-01-02");
    expect(hoyFechaSolo("America/Mexico_City")).toBe("2026-01-01");
  });

  it("devuelve exactamente 'YYYY-MM-DD'", () => {
    expect(hoyFechaSolo()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// REQ (revisión de PR #164, "no bloqueante" #2, `restaurantes/pages/Historial.tsx`):
// `new Date(dateFrom).toISOString()` sobre un "YYYY-MM-DD" de un `<input type="date">`
// manda la medianoche UTC de ese día -- en CDMX (UTC-6) eso es las 18:00 del día ANTERIOR
// local, así que un filtro `created_at < dateTo` excluye TODO el día local pedido.
describe("medianocheLocalUTC -- instante UTC de la medianoche LOCAL de un día (para filtros de rango, no para formatear una columna `date`)", () => {
  it("CDMX (UTC-6, sin horario de verano desde 2022): medianoche del 15 de agosto es las 06:00 UTC ese mismo día", () => {
    expect(medianocheLocalUTC("2026-08-15").toISOString()).toBe("2026-08-15T06:00:00.000Z");
  });

  it("confirma el bug del patrón viejo: la medianoche UTC del día pedido es 6 horas ANTES de la medianoche real en CDMX", () => {
    const patronViejoRoto = new Date("2026-08-15").toISOString();
    expect(patronViejoRoto).toBe("2026-08-15T00:00:00.000Z"); // 18:00 del 14 en CDMX, no medianoche del 15
    expect(medianocheLocalUTC("2026-08-15").toISOString()).not.toBe(patronViejoRoto);
  });

  it("otra zona con offset distinto (America/Cancun, UTC-5, sin horario de verano)", () => {
    expect(medianocheLocalUTC("2026-08-15", "America/Cancun").toISOString()).toBe("2026-08-15T05:00:00.000Z");
  });

  it("uso real: 'hasta el 15' incluye TODO el 15 local -- el límite exclusivo es la medianoche del 16, no del 15", () => {
    const desde = medianocheLocalUTC("2026-08-15");
    const hastaExclusivo = medianocheLocalUTC(sumarDiasFechaSolo("2026-08-15", 1));
    // Un pedido creado a las 23:00 CDMX del día 15 (05:00 UTC del 16) cae dentro del
    // rango [desde, hastaExclusivo) -- con el patrón viejo (`new
    // Date("2026-08-15").toISOString()` como `dateTo`) habría quedado FUERA.
    const pedidoTardeDelDia15 = new Date("2026-08-16T05:00:00.000Z").getTime();
    expect(pedidoTardeDelDia15 >= desde.getTime()).toBe(true);
    expect(pedidoTardeDelDia15 < hastaExclusivo.getTime()).toBe(true);
  });
});

describe("sumarDiasFechaSolo -- aritmética de calendario pura, no se mueve con ninguna zona horaria", () => {
  it("suma un día cruzando fin de mes/año", () => {
    expect(sumarDiasFechaSolo("2026-08-15", 1)).toBe("2026-08-16");
    expect(sumarDiasFechaSolo("2026-12-31", 1)).toBe("2027-01-01");
    expect(sumarDiasFechaSolo("2028-02-28", 1)).toBe("2028-02-29"); // bisiesto
  });

  it("resta días con `dias` negativo", () => {
    expect(sumarDiasFechaSolo("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("fechaCortaEsMx -- sigue existiendo, sin cambios de comportamiento", () => {
  it("formatea una fecha real dada", () => {
    expect(fechaCortaEsMx(new Date("2026-08-15T18:00:00Z"))).toContain("2026");
  });
});
