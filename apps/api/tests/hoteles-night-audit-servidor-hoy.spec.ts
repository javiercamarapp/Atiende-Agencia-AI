// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): el default de
// `businessDate` de `POST /hoteles/:propertyId/night-audit` (disparo manual, cuando el
// caller no lo manda) usaba el día UTC del proceso -- corrido un día adelante del real en
// CDMX entre las 18:00 y las 23:59 hora local (Vercel corre con TZ=UTC). Fix: ahora usa
// `@atiende/core-tenancy::hoyFechaNegocio()`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";

describe("POST /hoteles/:propertyId/night-audit -- default de businessDate usa el día de NEGOCIO", () => {
  it("sin businessDate en el body, a las 22:00 CDMX, corre el cierre del día real (2026-01-01), no del día UTC (2026-01-02)", async () => {
    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const res = await app.request(`/hoteles/${ctx.propertyId}/night-audit`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fecha: string };
    expect(body.fecha).toBe("2026-01-01");
    expect(body.fecha).not.toBe("2026-01-02");
  });
});
