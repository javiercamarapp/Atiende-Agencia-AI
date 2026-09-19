// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): `GET .../availability-
// overrides` filtra "solo las de hoy en adelante" (`todayIso` como cota inferior);
// usaba el día UTC del proceso -- corrido un día adelante del real en CDMX entre las
// 18:00 y las 23:59 hora local (Vercel corre con TZ=UTC), así que la excepción de HOY
// mismo desaparecía del panel un rato antes de que en realidad pasara. Fix: ahora usa
// `@atiende/core-tenancy::hoyFechaNegocio()`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";
const HOY_REAL_CDMX = "2026-01-01";

describe("GET /v1/citas/properties/:propertyId/providers/:providerId/availability-overrides -- usa el día de NEGOCIO", () => {
  it("a las 22:00 CDMX, una excepción de HOY (2026-01-01) sigue apareciendo en la lista", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const put = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/availability-overrides/${HOY_REAL_CDMX}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ is_closed: true, reason: "Cierre de emergencia" }),
    });
    expect(put.status).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const list = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/availability-overrides`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { availability_overrides: readonly { override_date: string }[] };
    // Control del bug: con el día UTC roto (mañana, 2026-01-02), el filtro `>= todayIso`
    // habría excluido esta fila (HOY_REAL_CDMX < todayIso roto). Con el fix, sigue
    // apareciendo.
    expect(body.availability_overrides.some((o) => o.override_date === HOY_REAL_CDMX)).toBe(true);
  });
});
