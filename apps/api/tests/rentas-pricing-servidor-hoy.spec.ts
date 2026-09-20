// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): el default de
// `vigenteDesde` de `POST .../tarifa-base` (cuando el caller no lo manda) usaba el día
// UTC del proceso -- corrido un día adelante del real en CDMX entre las 18:00 y las
// 23:59 hora local (Vercel corre con TZ=UTC). Fix: ahora usa
// `@atiende/core-tenancy::hoyFechaNegocio()`.
//
// auditoría f3-zona-horaria-citas-rentas -- CONFIRMADO y CONECTADO (ver comentario de
// cabecera de `pricing-config.ts::hoyIso`): el fix de r6 de arriba usaba
// `hoyFechaNegocio()` SIN zona (siempre el default de plataforma, CDMX) aunque la
// ruta YA conoce `propertyId` y `rentas.property_config.zona_horaria` YA existe. El
// segundo test de este archivo demuestra el efecto real con la property de
// `buildRentasTestContext` sembrada en `America/Cancun` (ver rentas-fixtures.ts
// línea ~150, `rentasCalendarSyncRepo.seedZonaHoraria`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";

describe("POST /rentas/:propertyId/unidades/:unidadId/tarifa-base -- default de vigenteDesde usa el día de NEGOCIO", () => {
  it("sin vigenteDesde en el body, a las 22:00 CDMX, se persiste con el día real (2026-01-01), no con el día UTC (2026-01-02)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`,
      authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 200000, moneda: "MXN" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { vigenteDesde: string };
    expect(body.vigenteDesde).toBe("2026-01-01");
    expect(body.vigenteDesde).not.toBe("2026-01-02");
  });

  // Instante elegido (verificado con Intl.DateTimeFormat antes de escribir este test):
  // en 2026-01-15T05:30:00.000Z, America/Cancun (UTC-5, sin horario de verano) YA ve
  // el 15, mientras America/Mexico_City (UTC-6, tampoco tiene DST) TODAVÍA ve el 14 --
  // una diferencia de día de calendario real entre las dos zonas para el MISMO
  // instante real, no un ejemplo de offset inventado.
  const INSTANTE_DIVERGENTE = "2026-01-15T05:30:00.000Z";

  it("la property de esta suite está en America/Cancun (ver rentas-fixtures.ts) -- el default usa 2026-01-15 (Cancún), NUNCA 2026-01-14 (CDMX, el default de plataforma)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_DIVERGENTE));

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`,
      authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 150000, moneda: "MXN" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { vigenteDesde: string };
    expect(body.vigenteDesde).toBe("2026-01-15");
    expect(body.vigenteDesde).not.toBe("2026-01-14");
  });
});
