// `hoyFechaNegocio`/`resolverZonaHorariaNegocio` (REQ-r6, ver comentario de
// cabecera de `../src/fecha-negocio.ts`): cierra de raíz el bug real de
// `todayIso()`/`hoyIso()` duplicado en `apps/api`/`apps/worker`/
// `domain-licitaciones` -- `new Date().toISOString().slice(0, 10)` da el día
// UTC, que en Vercel (`TZ=UTC`) va un día ADELANTE del día real en
// America/Mexico_City entre las 18:00 y las 23:59 hora local (00:00-05:59
// UTC).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZONA_HORARIA_NEGOCIO_DEFAULT, hoyFechaNegocio, resolverZonaHorariaNegocio } from "../src/fecha-negocio.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hoyFechaNegocio", () => {
  it("a las 22:00 CDMX (04:00 UTC del día siguiente), 'hoy' sigue siendo el día real en CDMX, NUNCA el día UTC", () => {
    // 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6
    // fijo, sin horario de verano desde 2022) -- 22:00 del día 1, no 04:00 del
    // día 2.
    vi.setSystemTime(new Date("2026-01-02T04:00:00.000Z"));

    // Control: el patrón VIEJO (`new Date().toISOString().slice(0, 10)`) SÍ da
    // el día de mañana en este mismo instante -- así se confirma que el
    // escenario reproduce el bug real antes de comprobar el fix.
    const patronViejoRoto = new Date().toISOString().slice(0, 10);
    expect(patronViejoRoto).toBe("2026-01-02");

    expect(hoyFechaNegocio()).toBe("2026-01-01");
  });

  it("a las 05:59 UTC (23:59 CDMX del día anterior) todavía es el día anterior; a las 06:00 UTC (00:00 CDMX) ya cambió", () => {
    vi.setSystemTime(new Date("2026-03-10T05:59:00.000Z"));
    expect(hoyFechaNegocio()).toBe("2026-03-09");

    vi.setSystemTime(new Date("2026-03-10T06:00:00.000Z"));
    expect(hoyFechaNegocio()).toBe("2026-03-10");
  });

  it("con una zona horaria explícita (Cancún, UTC-5 fijo, sin horario de verano) usa ESA zona, no el default de México", () => {
    // 2026-01-02T04:30:00Z = 23:30 del día 1 en America/Cancun (UTC-5) --
    // todavía el día anterior ahí, aunque en America/Mexico_City (UTC-6) ya
    // serían las 22:30 del mismo día 1 -- ambas dan el mismo día calendario en
    // este instante puntual; se prueba también un instante donde SÍ difieren.
    vi.setSystemTime(new Date("2026-01-02T05:30:00.000Z")); // 00:30 Cancún (día 2), 23:30 CDMX (día 1)
    expect(hoyFechaNegocio("America/Cancun")).toBe("2026-01-02");
    expect(hoyFechaNegocio(ZONA_HORARIA_NEGOCIO_DEFAULT)).toBe("2026-01-01");
  });
});

describe("resolverZonaHorariaNegocio", () => {
  it("usa la zona real de la property cuando se proporciona", () => {
    expect(resolverZonaHorariaNegocio("America/Cancun")).toBe("America/Cancun");
    expect(resolverZonaHorariaNegocio("America/Tijuana")).toBe("America/Tijuana");
  });

  it("cae a America/Mexico_City cuando la vertical no tiene columna de zona horaria (null/undefined/vacío)", () => {
    expect(resolverZonaHorariaNegocio(null)).toBe(ZONA_HORARIA_NEGOCIO_DEFAULT);
    expect(resolverZonaHorariaNegocio(undefined)).toBe(ZONA_HORARIA_NEGOCIO_DEFAULT);
    expect(resolverZonaHorariaNegocio("")).toBe(ZONA_HORARIA_NEGOCIO_DEFAULT);
    expect(resolverZonaHorariaNegocio("   ")).toBe(ZONA_HORARIA_NEGOCIO_DEFAULT);
  });

  // Corrección de revisión r6 de PR #171 (no bloqueante #2): sin validar, un valor
  // corrupto/legado en la columna caía directo a `hoyFechaNegocio(...)`, que lanza
  // `RangeError` sin capturar (`new Intl.DateTimeFormat` con timeZone inválido).
  it("cae a America/Mexico_City (falla cerrado, nunca lanza) cuando el valor NO es un timezone IANA válido", () => {
    expect(resolverZonaHorariaNegocio("zona-mala")).toBe(ZONA_HORARIA_NEGOCIO_DEFAULT);
    expect(resolverZonaHorariaNegocio("America/Ciudad_Inventada")).toBe(ZONA_HORARIA_NEGOCIO_DEFAULT);
    expect(() => resolverZonaHorariaNegocio("zona-mala")).not.toThrow();
    // Control: el resultado sigue siendo utilizable por `hoyFechaNegocio` sin lanzar.
    expect(() => hoyFechaNegocio(resolverZonaHorariaNegocio("zona-mala"))).not.toThrow();
  });
});
