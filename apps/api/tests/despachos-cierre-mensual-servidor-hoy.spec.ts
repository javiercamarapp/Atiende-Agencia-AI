// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): `cierre-mensual.ts::
// todayIso()` usaba el día UTC del proceso -- corrido un día adelante del real en CDMX
// entre las 18:00 y las 23:59 hora local (Vercel corre con TZ=UTC). `recomputeOverdue`/
// `calcularEstadoPeriodo` (GET .../periodos/:id) marcaban una tarea como "vencida" un día
// ANTES de que en realidad venciera para el negocio. Fix: `todayIso()` ahora delega en
// `@atiende/core-tenancy::hoyFechaNegocio()`.
//
// La plantilla real (`DEFAULT_MONTHLY_CLOSE_TEMPLATE`) no usa `dueOffsetDays` -- ninguna
// tarea por defecto tiene `dueDate`, así que este test arma una tarea sintética CON
// `dueDate` vía `replaceTareasCierre` (mismo repo en memoria, sin tocar el motor puro) para
// ejercer el camino real de "vencida por fecha", que sí es alcanzable en producción en
// cuanto cualquier plantilla futura declare `dueOffsetDays`.
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { getTemplate } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";

describe("GET /despachos/:propertyId/cierre-mensual/periodos/:periodoId -- 'vencida' usa el día de NEGOCIO", () => {
  it("una tarea con dueDate = HOY real (2026-01-01) NO cuenta como vencida a las 22:00 CDMX", async () => {
    const { periodo, tareas } = await ctx.despachosRepo.insertPeriodoCierre({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      anio: 2026,
      mes: 1,
      template: getTemplate(),
    });
    const conDueDateHoy = tareas.map((t, idx) => (idx === 0 ? { ...t, dueDate: "2026-01-01" } : t));
    await ctx.despachosRepo.replaceTareasCierre(periodo.id, conDueDateHoy);

    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const res = await app.request(`/despachos/${ctx.propertyId}/cierre-mensual/periodos/${periodo.id}`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: { overdue: { id: string }[] }; periodo: { status: string } };
    // Control del bug: con el día UTC roto (mañana, 2026-01-02), "2026-01-01" < "hoy" ->
    // TRUE, la tarea aparecía vencida un día antes de tiempo (y el período pasaba a
    // status "overdue"). Con el fix, sigue siendo el mismo día de negocio ->
    // "2026-01-01" < "2026-01-01" es FALSE, no vencida todavía.
    expect(body.estado.overdue.map((o) => o.id)).not.toContain(conDueDateHoy[0]!.id);
    expect(body.periodo.status).not.toBe("overdue");
  });
});
