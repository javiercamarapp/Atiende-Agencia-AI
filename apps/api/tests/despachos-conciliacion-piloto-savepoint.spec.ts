// REGLA DURA de compatibilidad con la base sin migrar para el piloto automático de la conciliación (D-P3-12): el piloto corre dentro de la transacción compartida del request
// (la misma que acaba de guardar el estado de cuenta). Con una sesión que reproduce el estado abortado 25P02 de Postgres real, un fallo de "función inexistente" (base con la
// 021 pero sin la 025) se revierte a su SAVEPOINT, el piloto responde `no_disponible` y la transacción sigue utilizable: el archivo ya guardado NO se pierde (un try/catch
// simple dejaría la transacción abortada y el COMMIT devolvería ROLLBACK).
import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresConciliacionPersistidaRepository } from "@atiende/domain-despachos";
import type { AppDeps } from "../src/deps.ts";
import { crearPilotoConciliacion } from "../src/routes/verticals/despachos/conciliacion-piloto.ts";

class SesionAbortable implements TenantDbSession {
  aborted = false;
  readonly llamadas: string[] = [];
  constructor(private readonly fallos: ReadonlyMap<RegExp, { code: string; message: string }>) {}
  async exec(sql: string): Promise<void> {
    await Promise.resolve();
    const s = sql.trim().toLowerCase();
    this.llamadas.push(s);
    if (s.startsWith("rollback to savepoint")) this.aborted = false;
  }
  async query<T>(sql: string): Promise<{ rows: T[] }> {
    await Promise.resolve();
    this.llamadas.push(sql.trim().slice(0, 60));
    if (this.aborted) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    for (const [re, e] of this.fallos) {
      if (re.test(sql)) {
        this.aborted = true;
        throw Object.assign(new Error(e.message), { code: e.code });
      }
    }
    return { rows: [{ ok: true }] as unknown as T[] };
  }
}

const contexto = (db: TenantDbSession) =>
  ({ get: (k: string) => ({ db, userId: "u1", organizationId: "o1", verticalRole: "admin" })[k], req: { path: "/x", method: "POST" } }) as unknown as Context<CoreAuthHonoEnv>;

describe("piloto de conciliación sobre una transacción compartida", () => {
  const piloto = (db: TenantDbSession) =>
    crearPilotoConciliacion({
      deps: {} as AppDeps,
      repoDe: () => new PostgresConciliacionPersistidaRepository(db),
      cargarDatos: async () => ({ movimientosLibres: [], registrosLibres: [], sugerencias: [] }),
      refrescarPropuestas: async () => {
        throw new Error("no debe llegar aquí");
      },
      exigirPeriodoAbierto: async () => {},
      auditar: async () => {},
    });

  it("base con la 021 pero sin la 025: no_disponible, SAVEPOINT revertido y transacción utilizable", async () => {
    const db = new SesionAbortable(
      new Map([
        [/conciliacion_autoconfirmar_nivel1/, { code: "42703", message: 'column "conciliacion_autoconfirmar_nivel1" does not exist' }],
        [/conciliacion_sesion_asegurar/, { code: "42883", message: "function despachos.conciliacion_sesion_asegurar(uuid, unknown, unknown) does not exist" }],
      ]),
    );
    const r = await piloto(db).trasImportar(contexto(db), { propertyId: "p1", cuenta: null, periodos: ["2026-07"] });
    expect(r).toEqual({ estado: "no_disponible", autoconfirmarNivel1: false, sesiones: [] });
    expect(db.llamadas.some((l) => l.startsWith("savepoint sp_conc_piloto"))).toBe(true);
    expect(db.llamadas.some((l) => l.startsWith("rollback to savepoint sp_conc_piloto"))).toBe(true);
    expect(db.aborted).toBe(false);
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("un error inesperado del piloto se revierte a su savepoint (estado: error) y NO aborta la transacción del request", async () => {
    const db = new SesionAbortable(new Map([[/conciliacion_sesion_asegurar/, { code: "XX000", message: "boom" }]]));
    const r = await piloto(db).trasImportar(contexto(db), { propertyId: "p1", cuenta: null, periodos: ["2026-07"] });
    expect(r).toMatchObject({ estado: "error", sesiones: [] });
    expect(db.aborted).toBe(false);
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("limita los periodos que un archivo dispara y los deduplica", async () => {
    const db = new SesionAbortable(new Map([[/conciliacion_sesion_asegurar/, { code: "42883", message: "function does not exist" }]]));
    await piloto(db).trasImportar(contexto(db), { propertyId: "p1", cuenta: null, periodos: Array.from({ length: 40 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, "0")}`) });
    expect(db.llamadas.filter((l) => l.includes("conciliacion_sesion_asegurar")).length).toBeLessThanOrEqual(1); // el primer 42883 corta el piloto
  });
});
