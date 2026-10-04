// D-13: aislamiento por archivo dentro de la transaccion UNICA del request. Cada archivo corre en su SAVEPOINT
// (runWithSavepointFallback): el duplicado del medio hace ROLLBACK TO SAVEPOINT y el siguiente se ingiere con la sesion utilizable;
// un error inesperado de base recupera la sesion y se propaga (500), nunca se traga. La sesion espia delega en la del motor en
// memoria y modela el estado abortado de Postgres (25P02) hasta el ROLLBACK TO SAVEPOINT.
import { beforeEach, describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { cfdiXml } from "./fixtures/cfdi-xml.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function motorEspia(base: TenancyEngine, bitacora: string[], abortarEn: () => boolean): TenancyEngine {
  return {
    async withAppSession(claims, fn) {
      return base.withAppSession(claims, async (real) => {
        let abortada = false;
        const espia: TenantDbSession = {
          query: async (sql, params) => {
            if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
            return real.query(sql, params);
          },
          exec: async (sql) => {
            const s = sql.trim().toLowerCase();
            bitacora.push(s.split(" ").slice(0, 3).join(" "));
            if (s.startsWith("rollback to savepoint")) {
              abortada = false;
              return real.exec(sql);
            }
            if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
            if (abortarEn()) abortada = true; // el error de la consulta anterior dejo la transaccion abortada
            return real.exec(sql);
          },
        };
        return fn(espia);
      });
    },
  };
}

function enviar(deps: typeof ctx.deps, archivos: readonly { nombre: string; datos: string }[]) {
  const fd = new FormData();
  for (const a of archivos) fd.append("archivos", new File([a.datos], a.nombre, { type: "application/xml" }));
  return buildApp(deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-lote`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` }, body: fd });
}

describe("importar-lote — SAVEPOINT por archivo", () => {
  it("el duplicado del medio revierte SOLO lo suyo (ROLLBACK TO SAVEPOINT) y el archivo siguiente se ingiere", async () => {
    const bitacora: string[] = [];
    const deps = { ...ctx.deps, engine: motorEspia(ctx.deps.engine, bitacora, () => false) };
    const res = await enviar(deps, [
      { nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) },
      { nombre: "a-copia.xml", datos: cfdiXml({ uuid: U(1) }) },
      { nombre: "b.xml", datos: cfdiXml({ uuid: U(2) }) },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resultados: { archivo: string; estado: string }[] };
    expect(body.resultados.map((r) => [r.archivo, r.estado === "rechazado" ? "rechazado" : r.estado === "duplicado" ? "duplicado" : "nuevo"])).toEqual([
      ["a.xml", "nuevo"],
      ["a-copia.xml", "duplicado"],
      ["b.xml", "nuevo"],
    ]);
    expect(bitacora.filter((s) => s.startsWith("savepoint")).length).toBeGreaterThanOrEqual(3);
    // Uno es el del duplicado; otro, el del aviso final (el motor en memoria no soporta core.emit_notification y emitirNotificacion lo contiene).
    expect(bitacora.filter((s) => s.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(1);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(2);
  });

  it("un error inesperado de base (no ApiError) recupera la sesion con ROLLBACK TO SAVEPOINT y se propaga como 500: nunca se reporta como rechazo", async () => {
    const bitacora: string[] = [];
    const original = ctx.despachosRepo.insertInvoice.bind(ctx.despachosRepo);
    let llamadas = 0;
    ctx.despachosRepo.insertInvoice = async (input) => {
      llamadas += 1;
      if (llamadas === 2) throw Object.assign(new Error("fallo inesperado"), { code: "XX000" });
      return original(input);
    };
    const deps = { ...ctx.deps, engine: motorEspia(ctx.deps.engine, bitacora, () => false) };
    const res = await enviar(deps, [
      { nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) },
      { nombre: "b.xml", datos: cfdiXml({ uuid: U(2) }) },
    ]);
    expect(res.status).toBe(500);
    expect(bitacora.filter((s) => s.startsWith("rollback to savepoint"))).toHaveLength(1);
  });
});
