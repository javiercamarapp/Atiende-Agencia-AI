// Autopiloto 2 (reactivacion): el tick /internal/restaurantes/promover-programados arma los borradores de campana en su PROPIA unidad
// (nunca envia: aprobar es un clic del dueño), con el instante absoluto del reloj (Merida, Cancun y CDMX) y avisa en la campana sin PII.
// Una falla del borrador jamas revierte la promocion ni cambia el 200 del tick; contra la base sin migrar queda "no disponible".
// La regla de negocio (consentimiento, 14 dias, control, aprobacion) se prueba contra Postgres real en scripts/verify-restaurantes-marketing-campanas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

const CAMPANA = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c0c";

const RELOJES = [
  { zona: "America/Merida", local: "2026-10-03T23:30:00-06:00" },
  { zona: "America/Cancun", local: "2026-10-04T00:30:00-05:00" },
  { zona: "America/Mexico_City", local: "2026-10-03T23:30:00-06:00" },
] as const;

function conBorradoresSimulados(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], borradores: (organizationId: string) => unknown[], modo: "ok" | "falla" | "sin_migrar" = "ok", organizationId = "") {
  const pNow: unknown[] = [];
  const emisiones: Array<{ evento: string; clave: string; titulo: string; cuerpo: string | null; enlace: string; entidadId: string | null }> = [];
  const vistas = new Set<string>();
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/marketing_generar_borradores/.test(sql)) {
        if (modo === "falla") throw Object.assign(new Error("falla interna"), { code: "XX000" });
        if (modo === "sin_migrar") throw Object.assign(new Error("function restaurantes.marketing_generar_borradores(timestamptz) does not exist"), { code: "42883" });
        pNow.push((params ?? [])[0]);
        return { rows: borradores(organizationId) as T[] };
      }
      if (/core\.emit_notification/.test(sql)) {
        const p = params ?? [];
        emisiones.push({ evento: String(p[2]), clave: String(p[10]), titulo: String(p[5]), cuerpo: (p[6] as string | null) ?? null, enlace: String(p[7]), entidadId: (p[9] as string | null) ?? null });
        const nueva = !vistas.has(String(p[10]));
        vistas.add(String(p[10]));
        return { rows: [{ emit_notification: nueva ? 1 : 0 }] as unknown as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  return { deps: { ...deps, engine }, pNow, emisiones };
}

const tick = (app: ReturnType<typeof buildApp>) => app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

describe("tick de promover-programados: borradores de campana de reactivacion", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  for (const { zona, local } of RELOJES) {
    it(`reloj fijo (${zona}): el instante absoluto viaja a la base y el aviso es uno por campana aunque corran dos ticks, sin PII`, async () => {
      vi.setSystemTime(new Date(local));
      const base = await buildTestDeps();
      const filas = (org: string) => [{ campana_id: CAMPANA, organization_id: org, segmento: "inactivo_30", conteo: 23, costo_estimado_centavos: 1840 }];
      const { deps, pNow, emisiones } = conBorradoresSimulados(base.deps, filas, "ok", base.organizationId);
      const app = buildApp(deps);

      const primero = await tick(app);
      expect(primero.status).toBe(200);
      expect(await primero.json()).toMatchObject({ ok: true, marketing: { disponible: true, borradores: 1, avisos: { emitidas: 1, sinNuevas: 0, errores: 0 } } });
      const segundo = await tick(app);
      expect(await segundo.json()).toMatchObject({ marketing: { disponible: true, borradores: 1, avisos: { emitidas: 0, sinNuevas: 1, errores: 0 } } });

      expect(pNow).toEqual([new Date(local).toISOString(), new Date(local).toISOString()]);
      expect(new Set(emisiones.map((e) => e.clave))).toEqual(new Set([`restaurantes.marketing.borrador_listo:${CAMPANA}`]));
      expect(emisiones[0]).toMatchObject({ evento: "restaurantes.marketing.borrador_listo", titulo: "Hay una campaña de reactivación lista para aprobar", enlace: "/restaurantes/{orgSlug}/campanas", entidadId: CAMPANA });
      expect(emisiones[0]!.cuerpo).toContain("23 clientes con consentimiento llevan 30 días o más sin pedir");
      expect(`${emisiones[0]!.titulo} ${emisiones[0]!.cuerpo}`).not.toMatch(/@|\d{8,}/);
    });
  }

  it("apagado por omision: sin organizaciones con marketing activo la base no devuelve borradores y no hay avisos", async () => {
    const base = await buildTestDeps();
    const { deps, emisiones } = conBorradoresSimulados(base.deps, () => []);
    const res = await tick(buildApp(deps));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ marketing: { disponible: true, borradores: 0, avisos: { emitidas: 0, sinNuevas: 0, errores: 0 } } });
    expect(emisiones).toEqual([]);
  });

  it("una falla de los borradores NO revierte nada: el tick responde 200 y reporta la unidad sin disponibilidad", async () => {
    const base = await buildTestDeps();
    const { deps } = conBorradoresSimulados(base.deps, () => [], "falla");
    const res = await tick(buildApp(deps));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, marketing: { disponible: false, borradores: 0 } });
  });

  it("base sin la migracion 052 (42883): estado 'no disponible' sin romper el tick", async () => {
    const base = await buildTestDeps();
    const { deps } = conBorradoresSimulados(base.deps, () => [], "sin_migrar");
    const res = await tick(buildApp(deps));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ marketing: { disponible: false, borradores: 0, avisos: { emitidas: 0, sinNuevas: 0, errores: 0 } } });
  });
});
