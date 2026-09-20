// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): el default de
// `vigenteDesde` de `POST .../tarifa-base` (cuando el caller no lo manda) usaba el día
// UTC del proceso -- corrido un día adelante del real en CDMX entre las 18:00 y las
// 23:59 hora local (Vercel corre con TZ=UTC). Fix: ahora usa
// `@atiende/core-tenancy::hoyFechaNegocio()`.
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
});
