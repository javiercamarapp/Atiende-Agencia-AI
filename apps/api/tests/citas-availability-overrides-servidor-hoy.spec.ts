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

  // No bloqueante #1 de la revisión de PR #171: este handler ya usaba
  // `hoyFechaNegocio()` SIN zona -- siempre CDMX, aunque `citasRepo.findPropertyTimezone`
  // ya expone la zona REAL configurada (`citas.tenant_config.default_timezone`, editable
  // desde el panel de Configuración). Un negocio de citas en Cancún (UTC-5, sin horario de
  // verano) con SU zona real configurada seguía calculando "hoy" en CDMX (UTC-6) --
  // un negocio distinto al de la organización.
  it("con zona real de Cancún configurada (distinta de CDMX), 'hoy' se calcula en Cancún -- una excepción de AYER en Cancún ya no aparece como vigente", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    ctx.citasRepo.seedTenantConfig({ organizationId: ctx.organizationId, defaultTimezone: "America/Cancun" });
    const app = buildApp(ctx.deps);

    // "Ayer" desde el punto de vista de Cancún en el instante de abajo.
    const AYER_EN_CANCUN = "2026-01-01";
    const put = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/availability-overrides/${AYER_EN_CANCUN}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ is_closed: true, reason: "Cierre de emergencia" }),
    });
    expect(put.status).toBe(200);

    vi.useFakeTimers();
    // 2026-01-02T05:30:00Z -- mismo instante de borde que
    // `fecha-negocio.spec.ts::"con una zona horaria explícita..."`: 00:30 del 2-ene en
    // America/Cancun (UTC-5, día YA cambió) pero 23:30 del 1-ene en America/Mexico_City
    // (UTC-6, día TODAVÍA no cambia) -- las dos zonas dan un día de negocio DISTINTO
    // para el MISMO instante.
    vi.setSystemTime(new Date("2026-01-02T05:30:00.000Z"));

    const list = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/availability-overrides`, {
      headers: { authorization: `Bearer ${ctx.staff.owner.token}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { availability_overrides: readonly { override_date: string }[] };
    // Control del bug: con el default CDMX (ignorando la zona real de Cancún), "hoy"
    // seguiría siendo 2026-01-01 -- el filtro `>= todayIso` habría INCLUIDO esta
    // excepción de "ayer en Cancún" como si todavía fuera vigente. Con el fix (zona
    // real de Cancún), "hoy" ya es 2026-01-02 -- la excepción de ayer queda excluida.
    expect(body.availability_overrides.some((o) => o.override_date === AYER_EN_CANCUN)).toBe(false);
  });
});
