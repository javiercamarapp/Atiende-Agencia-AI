// Rn-36 -- el checklist de onboarding contra una base SIN migrar: cada medicion corre bajo SAVEPOINT. Con AbortAwareFakeSession (que
// reproduce el estado abortado 25P02 de una transaccion de Postgres) un 42P01 en una tabla NO debe tumbar las demas mediciones.
import { describe, expect, it } from "vitest";
import { PostgresRentasOnboardingChecklistRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const falla = (code: string) => Object.assign(new Error(`error de base (${code})`), { code });

describe("PostgresRentasOnboardingChecklistRepository", () => {
  it("una tabla inexistente (42P01) deja ESE punto en null y los demas se miden igual (SAVEPOINT)", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /from rentas\.canal_feed_externo/, respond: () => falla("42P01") },
      { match: /from rentas\.unidad /, respond: () => [{ n: "3" }] },
      { match: /from rentas\.tarifa_base/, respond: () => [{ n: "2" }] },
      { match: /from rentas\.regla_comision_canal/, respond: () => [{ n: "4" }] },
      { match: /from rentas\.acceso_politica/, respond: () => [{ n: "1" }] },
      { match: /from rentas\.owner_organization/, respond: () => [{ n: "2" }] },
      { match: /from rentas\.plantilla_mensaje/, respond: () => [{ n: "0" }] },
    ]);
    const datos = await new PostgresRentasOnboardingChecklistRepository(sesion).cargar(ORG);
    expect(datos).toEqual({ unidades: 3, feeds: null, unidadesConTarifaBase: 2, reglasComision: 4, propiedadesConAccesoActivo: 1, propietarios: 2, plantillasAprobadas: 0 });
    expect(sesion.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("columna inexistente (42703) y permiso negado (42501) degradan a null; cualquier otro error se repropaga", async () => {
    const todos = (code: string) => new AbortAwareFakeSession([{ match: /rentas\./, respond: () => falla(code) }]);
    for (const code of ["42703", "42501"]) {
      const datos = await new PostgresRentasOnboardingChecklistRepository(todos(code)).cargar(ORG);
      expect(Object.values(datos).every((v) => v === null), code).toBe(true);
    }
    await expect(new PostgresRentasOnboardingChecklistRepository(todos("57014")).cargar(ORG)).rejects.toMatchObject({ code: "57014" });
  });

  it("feeds: cuenta activos y sincronizados; sin filas devuelve ceros honestos", async () => {
    const repo = new PostgresRentasOnboardingChecklistRepository(
      new AbortAwareFakeSession([
        { match: /from rentas\.canal_feed_externo/, respond: () => [{ activos: "2", sincronizados: "1" }] },
        { match: /from rentas\./, respond: () => [] },
      ]),
    );
    const datos = await repo.cargar(ORG);
    expect(datos.feeds).toEqual({ activos: 2, sincronizados: 1 });
    expect(datos.unidades).toBe(0);
  });

  it("todas las consultas van acotadas a la organizacion con parametro (nunca interpolado)", async () => {
    const capturadas: { sql: string; params: unknown[] | undefined }[] = [];
    const sesion = {
      async query<T>(sql: string, params?: unknown[]) {
        capturadas.push({ sql, params });
        return { rows: [{ n: "0", activos: "0", sincronizados: "0" }] as T[] };
      },
      async exec() {},
    };
    await new PostgresRentasOnboardingChecklistRepository(sesion).cargar(ORG);
    const consultas = capturadas.filter((c) => /from rentas\./.test(c.sql));
    expect(consultas.length).toBe(7);
    for (const c of consultas) {
      expect(c.sql).toContain("organization_id = $1");
      expect(c.sql).not.toContain(ORG);
      expect(c.params).toEqual([ORG]);
    }
  });
});
