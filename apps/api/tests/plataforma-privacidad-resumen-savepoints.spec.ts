// GET /v1/privacidad/resumen llama a varios metodos del repositorio, cada uno bajo SAVEPOINT en la MISMA sesion del
// request. Lanzados en paralelo, el RELEASE del primer savepoint destruye los demas (3B001) y la ruta daba 500
// aunque la migracion estuviera aplicada. Este test usa una sesion que modela savepoints anidados (pila + cola en orden).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresPlataformaPrivacidadRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { NestedSavepointSession, type NestedSavepointHandler } from "./support/nested-savepoint-session.ts";

const retencionFila = {
  out_data_class: "citas_mensajes",
  out_vertical: "citas",
  out_description: "Mensajes",
  out_executor: "plataforma",
  out_default_days: 365,
  out_min_days: 30,
  out_max_days: 730,
  out_effective_days: 365,
  out_source: "default",
  out_updated_at: null,
};

const migrada: NestedSavepointHandler[] = [
  { match: /org_list_retention_policies/, rows: () => [retencionFila] },
  { match: /org_list_arco_requests/, rows: () => [] },
  { match: /org_list_purge_holds/, rows: () => [] },
  { match: /org_list_purge_runs/, rows: () => [] },
  { match: /org_list_privacy_notices/, rows: () => [] },
];

async function pedirResumen(handlers: NestedSavepointHandler[]) {
  const s = await seguridadSetup();
  const session = new NestedSavepointSession(handlers);
  const deps: AppDeps = { ...s.deps, engine: { withAppSession: (_c, fn) => fn(session) }, privacidadPlataformaRepo: (db) => new PostgresPlataformaPrivacidadRepository(db) };
  const token = await signAccessToken({ sub: randomUUID(), org_id: s.base.organizationId, vertical: "restaurantes", property_ids: null, email: "a@example.com" }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
  const res = await buildApp(deps).request("/v1/privacidad/resumen", { headers: bearer(token) });
  return { res, session };
}

describe("GET /v1/privacidad/resumen con savepoints anidados", () => {
  it("base migrada: 200 disponible y la transaccion queda sana (sin 3B001)", async () => {
    const { res, session } = await pedirResumen(migrada);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: true });
    expect(session.abortada).toBe(false);
    // Cada SAVEPOINT se libera antes de abrir el siguiente (secuencial, nunca entrelazado).
    const sp = session.calls.filter((c) => c.includes("savepoint"));
    for (let i = 0; i < sp.length; i += 2) {
      expect(sp[i]).toMatch(/^savepoint /u);
      expect(sp[i + 1]).toMatch(/^release savepoint /u);
    }
  });

  it("base sin migrar en las listas del resumen: 200 con listas vacias, nunca 500", async () => {
    const faltante = (re: RegExp): NestedSavepointHandler => ({ match: re, rows: () => { throw Object.assign(new Error("function core.org_list_x(uuid) does not exist"), { code: "42883" }); } });
    const { res, session } = await pedirResumen([
      { match: /org_list_retention_policies/, rows: () => [retencionFila] },
      faltante(/org_list_arco_requests/),
      faltante(/org_list_purge_holds/),
      faltante(/org_list_purge_runs/),
      faltante(/org_list_privacy_notices/),
    ]);
    expect(await res.json()).toMatchObject({ disponible: true, arco: { total: 0, solicitudes: [] }, bloqueos: [], purgas: [], avisos: [] });
    expect(res.status).toBe(200);
    expect(session.abortada).toBe(false);
  });

  it("la sesion modelada SI detecta el entrelazado: 4 metodos en paralelo rompen con 3B001", async () => {
    const session = new NestedSavepointSession(migrada);
    const repo = new PostgresPlataformaPrivacidadRepository(session);
    const org = randomUUID();
    await expect(
      Promise.all([repo.orgListArco(org, { onlyOpen: false, limit: 5, offset: 0 }), repo.orgListHolds(org), repo.orgListPurgeRuns(org, 5, null), repo.orgListNotices(org, 5)]),
    ).rejects.toMatchObject({ code: "3B001" });
  });
});
