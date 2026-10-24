// Configuracion del Resumen (096) contra la base SIN migrar y contra RLS: la lectura degrada a «sin configurar» con SAVEPOINT (nunca 25P02),
// la escritura contesta NoDisponible (42P01) o Rechazada (42501, RLS) y la transaccion sigue usable.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { ResumenConfigNoDisponibleError, ResumenConfigRechazadaError, RESUMEN_CONFIG_VACIA } from "../src/types.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const err = (code: string, msg: string) => Object.assign(new Error(msg), { code });
const VALOR = { minutosPorConversacion: 5, metaPedidosIaPct: 50, metaIngresosIaPct: null };

function repo(handlers: FakeSessionHandler[]) {
  const sesion = new AbortAwareFakeSession([...handlers, { match: /savepoint/i, respond: () => undefined }, { match: /select 1/i, respond: () => [{ ok: 1 }] }]);
  return { repo: new PostgresRestaurantesRepository(sesion), sesion };
}

describe("resumen_settings: base sin migrar y RLS", () => {
  it("lectura con la tabla ausente (42P01): disponible:false y configuracion vacia, sin dejar la transaccion abortada", async () => {
    const { repo: r, sesion } = repo([{ match: /resumen_settings/, respond: () => err("42P01", 'relation "restaurantes.resumen_settings" does not exist') }]);
    const l = await r.leerResumenConfig("org-1");
    expect(l).toEqual({ disponible: false, valor: RESUMEN_CONFIG_VACIA, actualizadoEn: null });
    await expect(sesion.query("select 1")).resolves.toBeTruthy();
  });

  it("lectura sin fila: disponible:true y vacia", async () => {
    const { repo: r } = repo([{ match: /resumen_settings/, respond: () => [] }]);
    expect(await r.leerResumenConfig("org-1")).toEqual({ disponible: true, valor: RESUMEN_CONFIG_VACIA, actualizadoEn: null });
  });

  it("escritura con la tabla ausente: NoDisponible; con RLS (42501): Rechazada; en ambos la transaccion sigue usable", async () => {
    const a = repo([{ match: /insert into restaurantes\.resumen_settings/, respond: () => err("42P01", "no existe") }]);
    await expect(a.repo.guardarResumenConfig("org-1", "u-1", VALOR)).rejects.toBeInstanceOf(ResumenConfigNoDisponibleError);
    await expect(a.sesion.query("select 1")).resolves.toBeTruthy();
    const b = repo([{ match: /insert into restaurantes\.resumen_settings/, respond: () => err("42501", "new row violates row-level security policy") }]);
    await expect(b.repo.guardarResumenConfig("org-1", "u-1", VALOR)).rejects.toBeInstanceOf(ResumenConfigRechazadaError);
    await expect(b.sesion.query("select 1")).resolves.toBeTruthy();
  });

  it("escritura correcta: upsert parametrizado y relee", async () => {
    const { repo: r, sesion } = repo([
      { match: /insert into restaurantes\.resumen_settings/, respond: () => [] },
      { match: /select minutos_por_conversacion/, respond: () => [{ minutos_por_conversacion: 5, meta_pedidos_ia_pct: 50, meta_ingresos_ia_pct: null, updated_at: "2026-10-23T12:00:00Z" }] },
    ]);
    const l = await r.guardarResumenConfig("org-1", "u-1", VALOR);
    expect(l.valor).toEqual(VALOR);
    expect(l.actualizadoEn).toBe("2026-10-23T12:00:00.000Z");
    expect(sesion.calls.some((c) => c.includes("insert into restaurantes.resumen_settings"))).toBe(true);
  });
});
