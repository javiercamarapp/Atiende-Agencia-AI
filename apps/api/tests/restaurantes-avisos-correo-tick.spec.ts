// Cerebro v2 (suelto B7 fuera del panel): el tick EXISTENTE /internal/restaurantes/promover-programados barre los avisos sin atender por correo
// (barrerAvisosPorCorreo, migracion 194) como unidad independiente: encola en el outbox de correo y un fallo no tumba el tick.
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

const tick = (app: ReturnType<typeof buildApp>) => app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

function conCorreoSimulado(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], organizationId: string, propertyId: string, opciones: { falla?: boolean } = {}) {
  const encolados: Array<{ canal: string; llave: string }> = [];
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/avisos_para_correo/.test(sql)) {
        if (opciones.falla) throw Object.assign(new Error("falla interna"), { code: "XX000" });
        return { rows: [{ id: "00000000-0000-4000-8000-0000000000e1", organization_id: organizationId, property_id: propertyId, created_at: new Date(Date.now() - 31 * 60_000).toISOString(), urgente: false, solo_primer_aviso: false }] as unknown as T[] };
      }
      if (/equipo_para_avisos_correo/.test(sql)) return { rows: [{ email: "duena@ejemplo.mx", vertical_role: "owner", platform_role: "owner", property_ids: null }] as unknown as T[] };
      if (/enqueue_messaging_outbox/.test(sql) && (params ?? [])[2] === "alerta.aviso_sin_atender") {
        encolados.push({ canal: String((params ?? [])[1]), llave: String((params ?? [])[3]) });
        return { rows: [] as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  return { deps: { ...deps, engine }, encolados };
}

describe("tick de promover-programados: avisos sin atender por correo (cerebro v2)", () => {
  it("encola el correo del nivel que toca en el outbox de correo", async () => {
    const { deps, organizationId, propertyId } = await buildTestDeps();
    const { deps: conEspia, encolados } = conCorreoSimulado(deps, organizationId, propertyId);
    const r = await tick(buildApp(conEspia));
    expect(r.status).toBe(200);
    expect(encolados).toHaveLength(1);
    expect(encolados[0]!.canal).toBe("email");
    expect(encolados[0]!.llave).toMatch(/^aviso-correo:00000000-0000-4000-8000-0000000000e1:n3:[0-9a-f]{16}$/);
  });

  it("el barrido de correo falla: el tick responde 200 igual", async () => {
    const { deps, organizationId, propertyId } = await buildTestDeps();
    const { deps: conEspia, encolados } = conCorreoSimulado(deps, organizationId, propertyId, { falla: true });
    const r = await tick(buildApp(conEspia));
    expect(r.status).toBe(200);
    expect(encolados).toHaveLength(0);
  });
});
