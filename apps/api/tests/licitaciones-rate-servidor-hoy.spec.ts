// REQ-r6/f2-current-date-fecha-negocio (revisión del 19-sep): el default de
// `validFrom` de `POST .../company/rates` (cuando el caller no lo manda) usaba
// `current_date` (sesión de Postgres, UTC en Vercel) / `isoNow()` (día UTC del
// proceso, en memoria) -- entre las 18:00 y las 23:59 CDMX el día UTC ya es MAÑANA,
// así que una tarifa aprobada se persistía vigente un día antes de tiempo. Fix:
// `PostgresLicitacionesRepository`/`InMemoryLicitacionesRepository::createApprovedRate`
// resuelven el default con `@atiende/core-tenancy::hoyFechaNegocio()`. Mismo patrón de
// fake-clock que `rentas-pricing-servidor-hoy.spec.ts` (leído primero como plantilla).
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T01:30:00Z = 2026-01-01T19:30:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_1930_CDMX_DIA_1 = "2026-01-02T01:30:00.000Z";

describe("POST /licitaciones/:propertyId/company/rates -- default de validFrom usa el día de NEGOCIO", () => {
  it("sin validFrom en el body, a las 19:30 CDMX, se persiste con el día real (2026-01-01), no con el día UTC (2026-01-02)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "consultoria_hora_servidor_hoy", unitPrice: "500.00" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { validFrom: string };
    // `InMemoryLicitacionesRepository` (backing de este test HTTP) agrega
    // "T00:00:00Z" al día de negocio para tener la MISMA forma con offset
    // horario explícito que `dateColumnToExplicitOffsetIso` produce sobre la
    // respuesta real de Postgres (paridad exacta, no solo de día calendario --
    // ver el comentario de cabecera de `createApprovedRate` en
    // in-memory-repository.ts, y `company-data-postgres-date-contract.spec.ts`
    // para el contrato del lado Postgres).
    expect(body.validFrom).toBe("2026-01-01T00:00:00Z");
  });

  it("REGRESIÓN: el validFrom en memoria trae offset horario explícito y no viola `assertExplicitOffset` -- exactamente el 500 que este PR cerraba en `POST proposal/economic/generate` si el default vuelve a ser 'YYYY-MM-DD' pelón", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "consultoria_hora_offset_check", unitPrice: "300.00" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { validFrom: string };
    expect(body.validFrom).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
  });
});
