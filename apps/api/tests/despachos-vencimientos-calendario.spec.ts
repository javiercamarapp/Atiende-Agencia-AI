// D-26: calendario fiscal con día hábil por la API real (repo en memoria, auth y roles reales).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});
afterEach(() => vi.useRealTimers());

interface Fila {
  id: string;
  tipo: string;
  periodo: string;
  fechaLimite: string;
  estado: string;
  fundamento: string;
  validarConFiscalista: boolean;
}

const calcular = (body: unknown, token = ctx.staff.contador.token) => buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(token, body));

describe("POST .../vencimientos/calcular — día hábil, plazos y régimen", () => {
  it("el 17 que cae en domingo se corre al lunes y la DIOT vence el último día del mes siguiente (ajustado)", async () => {
    const res = await calcular({ year: 2026, month: 4 });
    expect(res.status).toBe(201);
    const filas = (await res.json()) as Fila[];
    const por = Object.fromEntries(filas.map((f) => [f.tipo, f.fechaLimite]));
    expect(por.ISR).toBe("2026-05-18");
    expect(por.IVA).toBe("2026-05-18");
    expect(por.DIOT).toBe("2026-06-01"); // 31-may es domingo
    expect(por.Balanza).toBe("2026-06-03");
  });

  it("cada fila trae su fundamento y marca 'validar con fiscalista' donde el plazo está por confirmar", async () => {
    const filas = (await (await calcular({ year: 2026, month: 3 })).json()) as Fila[];
    const diot = filas.find((f) => f.tipo === "DIOT")!;
    expect(diot.fundamento).toMatch(/4\.5\.1/);
    expect(diot.validarConFiscalista).toBe(true);
    expect(filas.find((f) => f.tipo === "ISR")!.validarConFiscalista).toBe(false);
  });

  it("régimen 626 no genera balanza; régimen 605 solo la anual en diciembre; régimen inventado -> 422/400", async () => {
    const resico = (await (await calcular({ year: 2026, month: 3, regimenFiscal: "626" })).json()) as Fila[];
    expect(resico.map((f) => f.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina", "Retenciones", "IMSS", "ISN"]);
    const sueldos = (await (await calcular({ year: 2026, month: 12, regimenFiscal: "605" })).json()) as Fila[];
    expect(sueldos.map((f) => `${f.tipo}:${f.fechaLimite}`)).toEqual(["Anual:2027-04-30"]);
    const malo = await calcular({ year: 2026, month: 3, regimenFiscal: "999" });
    expect([400, 422]).toContain(malo.status);
    const noString = await calcular({ year: 2026, month: 3, regimenFiscal: 601 });
    expect([400, 422]).toContain(noString.status);
  });

  it("recalcular CORRIGE una fila pendiente calculada antes con el día 17 fijo y no toca una completada", async () => {
    const vieja = await ctx.despachosRepo.createDeadline({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, tipo: "ISR", periodo: "2026-04", fechaLimite: "2026-05-17", prioridad: "baja" });
    const hecha = await ctx.despachosRepo.createDeadline({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, tipo: "IVA", periodo: "2026-04", fechaLimite: "2026-05-17", prioridad: "baja" });
    await ctx.despachosRepo.markDeadlineCompleted(hecha.id, null, "2026-05-15");

    const filas = (await (await calcular({ year: 2026, month: 4 })).json()) as Fila[];
    const isr = filas.find((f) => f.tipo === "ISR")!;
    expect(isr.id).toBe(vieja.id);
    expect(isr.fechaLimite).toBe("2026-05-18");
    expect(filas.find((f) => f.tipo === "IVA")).toMatchObject({ estado: "completado", fechaLimite: "2026-05-17" });
  });

  it("un rol de solo lectura no puede calcular (403)", async () => {
    expect((await calcular({ year: 2026, month: 4 }, ctx.staff.readonly.token)).status).toBe(403);
  });

  it("GET lista las filas con fundamento y bandera de validación", async () => {
    await calcular({ year: 2026, month: 6 });
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.auditor.token));
    const filas = (await res.json()) as Fila[];
    expect(filas.every((f) => f.fundamento.length > 0)).toBe(true);
  });
});

describe("POST .../vencimientos/barrido — escalamiento automático", () => {
  async function sembrar() {
    const mk = (tipo: "ISR" | "IVA" | "DIOT" | "Nómina", fechaLimite: string) => ctx.despachosRepo.createDeadline({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, tipo, periodo: "2026-05", fechaLimite, prioridad: "alta" });
    return { vencido: await mk("ISR", "2026-06-01"), manana: await mk("IVA", "2026-06-11"), lejano: await mk("DIOT", "2026-06-30"), hecho: await mk("Nómina", "2026-06-01") };
  }
  const barrer = (token = ctx.staff.contador.token) => buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/vencimientos/barrido`, authedJson(token, {}));

  it("escala el vencido (nivel_4) y el de mañana (1 día hábil: nivel_3), ignora el lejano (>7 hábiles) y el completado, y es idempotente", async () => {
    const d = await sembrar();
    await ctx.despachosRepo.markDeadlineCompleted(d.hecho.id, null, "2026-05-30");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T18:00:00.000Z")); // 12:00 en CDMX

    const res = await barrer();
    expect(res.status).toBe(200);
    const r = (await res.json()) as { evaluados: number; escalados: { id: string; nivel: string }[]; aunNoToca: number; yaEscalados: number };
    expect(r.evaluados).toBe(3);
    expect(Object.fromEntries(r.escalados.map((e) => [e.id, e.nivel]))).toEqual({ [d.vencido.id]: "nivel_4", [d.manana.id]: "nivel_3" });
    expect(r.aunNoToca).toBe(1);
    expect((await ctx.despachosRepo.findDeadline(ctx.propertyId, d.vencido.id))!.estado).toBe("escalado");

    const otra = (await (await barrer()).json()) as { escalados: unknown[]; yaEscalados: number };
    expect(otra.escalados).toEqual([]);
    expect(otra.yaEscalados).toBe(2);
    expect(await ctx.despachosRepo.listEscalations(d.vencido.id)).toHaveLength(1);
  });

  it("solo roles de gestión: readonly y auditor reciben 403", async () => {
    expect((await barrer(ctx.staff.readonly.token)).status).toBe(403);
    expect((await barrer(ctx.staff.auditor.token)).status).toBe(403);
  });
});
