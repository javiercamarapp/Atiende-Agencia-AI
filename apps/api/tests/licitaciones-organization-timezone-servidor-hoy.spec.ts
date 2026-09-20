// FASE 3 (producto) — zona horaria por negocio, parte 4/4 (licitaciones):
// demuestra el EFECTO real de conectar `resolverZonaHorariaNegocio` (nunca
// solo que "compila" o que "no truena") -- con un reloj falso fijo en un
// instante donde America/Mexico_City (CDMX, UTC-6 fijo) y America/Tijuana
// (UTC-8 en enero, sin horario de verano) están en DÍAS DE CALENDARIO
// distintos, `PATCH .../tenant-config` cambia de verdad qué día se persiste
// como "hoy" para esta organización -- verificado indirectamente vía
// `Intl.DateTimeFormat` (lo que `hoyFechaNegocio`/`resolverZonaHorariaNegocio`
// usan internamente, ver `packages/core-tenancy/src/fecha-negocio.ts`) y
// directamente comprobado aquí contra el mismo instante con las mismas dos
// zonas, para que el test no dependa a ciegas de la implementación.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresLicitacionesRepository } from "@atiende/domain-licitaciones";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

function patchJson(token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) }, body: raw };
}

// 07:00 UTC del 2 de enero: CDMX (UTC-6) ya cruzó a la 01:00 del día 2; Tijuana
// (UTC-8, sin horario de verano en enero) todavía va en las 23:00 del día 1 --
// una ventana real de 2 horas cada día donde ambas zonas DISCREPAN de día de
// calendario (verificado abajo con `Intl.DateTimeFormat`, no solo asumido).
const INSTANTE_DIAS_DISCREPAN = "2026-01-02T07:00:00.000Z";

function diaEnZona(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

describe("PATCH .../tenant-config cambia de verdad el 'hoy' de negocio -- efecto real, con reloj falso", () => {
  it("verificación previa (Intl.DateTimeFormat puro, sin la app): en este instante CDMX ya es 2026-01-02 pero Tijuana sigue en 2026-01-01", () => {
    expect(diaEnZona(INSTANTE_DIAS_DISCREPAN, "America/Mexico_City")).toBe("2026-01-02");
    expect(diaEnZona(INSTANTE_DIAS_DISCREPAN, "America/Tijuana")).toBe("2026-01-01");
  });

  it("sin timezone configurado (default de plataforma, CDMX): el validFrom sin body usa 2026-01-02", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_DIAS_DISCREPAN));

    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "tarifa_default_cdmx", unitPrice: "500.00" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { validFrom: string };
    expect(body.validFrom.slice(0, 10)).toBe("2026-01-02");
  });

  it("EFECTO REAL: tras configurar timezone='America/Tijuana', en el MISMO instante el validFrom sin body cambia a 2026-01-01 -- un día menos, exactamente la discrepancia real de zona horaria demostrada arriba", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const patchRes = await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patchJson(ctx.staff.owner.token, { timezone: "America/Tijuana" }));
    expect(patchRes.status).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_DIAS_DISCREPAN));

    const res = await app.request(`/licitaciones/${ctx.propertyId}/company/rates`, authedJson(ctx.staff.writer.token, { concept: "tarifa_tijuana", unitPrice: "500.00" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { validFrom: string };
    expect(body.validFrom.slice(0, 10)).toBe("2026-01-01");
    expect(body.validFrom.slice(0, 10)).not.toBe("2026-01-02");
  });

  it("PostgresLicitacionesRepository (producción) -- mismo efecto contra el adaptador real de SQL, no solo el repo en memoria", async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    function fakeSession(timezoneRow: { timezone: string | null } | null): TenantDbSession {
      const queue: Array<{ rows: unknown[] }> = [
        { rows: [] }, // select de duplicados: no hay
        { rows: timezoneRow ? [timezoneRow] : [] }, // select timezone de tenant_config
        { rows: [{ id: "rate-x", concept: "c", unit_price: "1.00", approval_status: "pendiente_aprobacion", valid_from: "PLACEHOLDER", valid_until: null }] },
      ];
      return {
        async query<T>(sql: string, params: unknown[] = []) {
          calls.push({ sql, params });
          const next = queue.shift();
          if (!next) throw new Error("cola agotada");
          return next as { rows: T[] };
        },
        async exec() {},
      };
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_DIAS_DISCREPAN));

    calls.length = 0;
    const repoDefault = new PostgresLicitacionesRepository(fakeSession(null));
    await repoDefault.createApprovedRate("org-1", { concept: "c", unitPrice: "1.00" });
    const insertParamsDefault = calls[2]!.params;
    expect(insertParamsDefault[4]).toBe("2026-01-02"); // CDMX, default de plataforma

    calls.length = 0;
    const repoTijuana = new PostgresLicitacionesRepository(fakeSession({ timezone: "America/Tijuana" }));
    await repoTijuana.createApprovedRate("org-1", { concept: "c", unitPrice: "1.00" });
    const insertParamsTijuana = calls[2]!.params;
    expect(insertParamsTijuana[4]).toBe("2026-01-01"); // Tijuana real, un día antes
  });
});
