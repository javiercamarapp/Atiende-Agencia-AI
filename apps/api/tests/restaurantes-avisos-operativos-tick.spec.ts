// R-16 -- el tick /internal/restaurantes/promover-programados barre las alertas operativas (entrega tardia /
// programado por vencer) como unidad independiente: una alerta por pedido (dos ticks = una), reloj fijo en las zonas
// de Merida, Cancun y CDMX (el instante que viaja a la base es absoluto, nunca depende de TZ del proceso) y una falla
// del barrido nunca revierte la promocion. Los candidatos los decide la base (scripts/verify-restaurantes-avisos-staff).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";
import { makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

const ORDER_A = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c0a";
const ORDER_B = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c0b";

// Mismo instante absoluto visto en cada zona del negocio: 23:30 Merida (UTC-6), 00:30 Cancun (UTC-5) y 23:30 CDMX (UTC-6).
const RELOJES = [
  { zona: "America/Merida", local: "2026-10-03T23:30:00-06:00" },
  { zona: "America/Cancun", local: "2026-10-04T00:30:00-05:00" },
  { zona: "America/Mexico_City", local: "2026-10-03T23:30:00-06:00" },
] as const;

interface Espia {
  readonly pNow: unknown[];
  readonly emisiones: Array<{ evento: string; clave: string; titulo: string; cuerpo: string | null; entidadId: string | null; enlace: string; roles: unknown }>;
}

function conBarridoSimulado(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], candidatos: unknown[], opciones: { fallaCandidatos?: boolean } = {}) {
  const espia: Espia = { pNow: [], emisiones: [] };
  const vistas = new Set<string>();
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/avisos_operativos_candidatos/.test(sql)) {
        if (opciones.fallaCandidatos) throw Object.assign(new Error("falla interna"), { code: "XX000" });
        espia.pNow.push((params ?? [])[0]);
        return { rows: candidatos as T[] };
      }
      if (/core\.emit_notification/.test(sql)) {
        const p = params ?? [];
        espia.emisiones.push({ evento: String(p[2]), clave: String(p[10]), titulo: String(p[5]), cuerpo: (p[6] as string | null) ?? null, entidadId: (p[9] as string | null) ?? null, enlace: String(p[7]), roles: p[11] });
        const nueva = !vistas.has(String(p[10]));
        vistas.add(String(p[10]));
        return { rows: [{ emit_notification: nueva ? 2 : 0 }] as unknown as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  return { deps: { ...deps, engine }, espia };
}

const tick = (app: ReturnType<typeof buildApp>) => app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

describe("tick de promover-programados: alertas operativas", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  for (const { zona, local } of RELOJES) {
    it(`reloj fijo (${zona}): el instante absoluto viaja a la base y una alerta por pedido aunque corran dos ticks`, async () => {
      vi.setSystemTime(new Date(local));
      const { deps, organizationId, propertyId } = await buildTestDeps();
      const candidatos = [
        { tipo: "restaurantes.pedido.entrega_tardia", order_id: ORDER_A, organization_id: organizationId, property_id: propertyId, order_number: "7" },
        { tipo: "restaurantes.pedido.programado_por_vencer", order_id: ORDER_B, organization_id: organizationId, property_id: propertyId, order_number: 8 },
      ];
      const { deps: conEspia, espia } = conBarridoSimulado(deps, candidatos);
      const app = buildApp(conEspia);

      const primero = await tick(app);
      expect(primero.status).toBe(200);
      expect(await primero.json()).toMatchObject({ ok: true, avisos: { disponible: true, candidatos: 2, emitidas: 2, sinNuevas: 0, errores: 0 } });
      const segundo = await tick(app);
      expect(await segundo.json()).toMatchObject({ avisos: { disponible: true, candidatos: 2, emitidas: 0, sinNuevas: 2, errores: 0 } });

      expect(espia.pNow).toEqual([new Date(local).toISOString(), new Date(local).toISOString()]);
      // 4 emisiones (2 ticks x 2 pedidos) pero solo 2 claves distintas: UNA alerta por pedido.
      expect(new Set(espia.emisiones.map((e) => e.clave))).toEqual(new Set([`restaurantes.pedido.entrega_tardia:${ORDER_A}`, `restaurantes.pedido.programado_por_vencer:${ORDER_B}`]));
      const tardia = espia.emisiones.find((e) => e.evento === "restaurantes.pedido.entrega_tardia")!;
      expect(tardia).toMatchObject({ titulo: "Un pedido va con retraso", cuerpo: "El pedido #7 pasó de su hora prometida y sigue sin entregarse.", enlace: "/restaurantes/{orgSlug}/pedidos", entidadId: ORDER_A, roles: ["staff"] });
      expect(`${tardia.titulo} ${tardia.cuerpo}`).not.toMatch(/@|\d{8,}/);
    });
  }

  it("el barrido falla (error de Postgres): la promocion ya confirmada se conserva y el tick responde 200 con errores=1", async () => {
    vi.setSystemTime(new Date("2026-10-03T23:30:00-06:00"));
    const { deps, restaurantesRepo, organizationId, propertyId } = await buildTestDeps();
    const o = makeOrder({ organizationId, propertyId, status: "programado", programadoPara: new Date(Date.now() + 10 * 60_000).toISOString(), promovidoAt: null });
    restaurantesRepo.seedOrder(o);
    const { deps: conFalla } = conBarridoSimulado(deps, [], { fallaCandidatos: true });
    const res = await tick(buildApp(conFalla));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, promoted: 1, orderIds: [o.id], avisos: { errores: 1 } });
    expect((await restaurantesRepo.findOrderById(organizationId, o.id))?.status).toBe("pending");
  });

  it("base sin migrar: el candidato lanza 42883 dentro de su SAVEPOINT y el tick responde ok con avisos.disponible=false", async () => {
    vi.setSystemTime(new Date("2026-10-03T23:30:00-06:00"));
    const { deps } = await buildTestDeps();
    const envolver = (session: TenantDbSession): TenantDbSession => ({
      exec: (sql) => session.exec(sql),
      query: async <T>(sql: string, params?: unknown[]) => {
        if (/avisos_operativos_candidatos/.test(sql)) throw Object.assign(new Error("function restaurantes.avisos_operativos_candidatos(timestamp with time zone) does not exist"), { code: "42883" });
        return session.query<T>(sql, params);
      },
    });
    const engine: TenancyEngine = { withAppSession: (claims, fn) => deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
    const res = await tick(buildApp({ ...deps, engine }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, avisos: { disponible: false, candidatos: 0, emitidas: 0, errores: 0 } });
  });
});
