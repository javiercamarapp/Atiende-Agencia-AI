// Tests de comportamiento del motor de checklist de cierre mensual — puerto
// de `b2b_ai/features/monthly_close/service.py::MonthlyCloseService`. No es
// un golden-set numérico (es una máquina de estados, no aritmética), pero
// cada caso reproduce un escenario verificado leyendo el código real del
// origen línea por línea (ver comentarios de cabecera de engine.ts), incluida
// la corrección de fidelidad documentada (`cerrarPeriodo` rechaza cerrar un
// período ya `closed`, a diferencia del Python original).
import { describe, expect, it } from "vitest";
import { DEFAULT_MONTHLY_CLOSE_TEMPLATE } from "../src/cierre-mensual/templates.ts";
import { construirTareasDesdePlantilla, verificarPeriodoNoDuplicado, completarTarea, autoCheckTareas, recomputeOverdue, calcularEstadoPeriodo, evaluarCierre, cerrarPeriodo, generarReporteCierre } from "../src/cierre-mensual/engine.ts";
import { PeriodoYaAbiertoError, CierreValidacionError, TareaCierreEstadoInvalidoError } from "../src/errors.ts";
import type { ClosePeriod, CloseTask } from "../src/cierre-mensual/types.ts";

function periodo(overrides: Partial<ClosePeriod> = {}): ClosePeriod {
  return { id: "p1", organizationId: "org1", propertyId: "prop1", year: 2026, month: 3, status: "open", openedAt: "2026-03-01T00:00:00.000Z", closedAt: null, closedBy: null, ...overrides };
}

/** Simula lo que hace el repositorio: arma tareas con ids reales y resuelve
 * `dependsOnKeys` -> ids concretos, igual que `insertPeriodoCierre`. */
function materializarTareas(periodId: string): readonly CloseTask[] {
  const nuevas = construirTareasDesdePlantilla(2026, 3, DEFAULT_MONTHLY_CLOSE_TEMPLATE);
  const keyToId = new Map<string, string>();
  const conId = nuevas.map((t, i) => {
    const id = `t${i}`;
    if (t.key) keyToId.set(t.key, id);
    return { id, ...t };
  });
  return conId.map((t) => ({
    id: t.id,
    periodId,
    title: t.title,
    description: t.description,
    category: t.category,
    status: t.status,
    dependsOn: t.dependsOnKeys.map((k) => keyToId.get(k)!),
    dueDate: t.dueDate,
    autoCheckQuery: t.autoCheckQuery,
    required: t.required,
    completedAt: null,
    completedBy: null,
  }));
}

describe("construirTareasDesdePlantilla", () => {
  it("genera las 15 tareas de la plantilla por defecto, todas required", () => {
    const tareas = construirTareasDesdePlantilla(2026, 3, DEFAULT_MONTHLY_CLOSE_TEMPLATE);
    expect(tareas).toHaveLength(15);
    expect(tareas.every((t) => t.required)).toBe(true);
  });

  it("una tarea sin dependencias nace pending; una con dependencias nace blocked", () => {
    const tareas = construirTareasDesdePlantilla(2026, 3, DEFAULT_MONTHLY_CLOSE_TEMPLATE);
    const cfdiVerificado = tareas.find((t) => t.key === "cfdi_verificado")!;
    expect(cfdiVerificado.status).toBe("pending");
    const folios = tareas.find((t) => t.title === "Validar folios fiscales y sellos")!;
    expect(folios.status).toBe("blocked");
    expect(folios.dependsOnKeys).toEqual(["cfdi_verificado"]);
  });
});

describe("verificarPeriodoNoDuplicado", () => {
  it("lanza si ya hay un período abierto para el mismo año/mes", () => {
    const existentes = [periodo({ status: "open" })];
    expect(() => verificarPeriodoNoDuplicado(existentes, 2026, 3)).toThrow(PeriodoYaAbiertoError);
  });
  it("no lanza si el período existente ya está cerrado", () => {
    const existentes = [periodo({ status: "closed" })];
    expect(() => verificarPeriodoNoDuplicado(existentes, 2026, 3)).not.toThrow();
  });
  it("no lanza para un año/mes distinto", () => {
    const existentes = [periodo({ status: "open", month: 2 })];
    expect(() => verificarPeriodoNoDuplicado(existentes, 2026, 3)).not.toThrow();
  });
});

describe("completarTarea — desbloqueo en cascada", () => {
  it("completar la raíz desbloquea su dependiente directo", () => {
    const tareas = materializarTareas("p1");
    const cfdiVerificado = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;
    const actualizadas = completarTarea(tareas, cfdiVerificado.id, "user1", "2026-03-02T00:00:00.000Z");
    const folios = actualizadas.find((t) => t.title === "Validar folios fiscales y sellos")!;
    expect(folios.status).toBe("pending");
    const done = actualizadas.find((t) => t.id === cfdiVerificado.id)!;
    expect(done.status).toBe("done");
    expect(done.completedBy).toBe("user1");
  });

  it("no desbloquea una tarea con múltiples dependencias hasta que TODAS estén done", () => {
    let tareas = materializarTareas("p1");
    const conciliacion = tareas.find((t) => t.title === "Conciliación bancaria completada")!;
    const nomina = tareas.find((t) => t.title === "Nóminas del mes timbradas")!;
    const declaraciones = tareas.find((t) => t.title === "Revisar declaraciones mensuales (ISR/IVA)")!;
    expect([...declaraciones.dependsOn].sort()).toEqual([conciliacion.id, nomina.id].sort());

    // Completa la cadena hasta desbloquear "conciliacion" (depende de cfdi_verificado).
    const cfdiVerificado = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;
    tareas = completarTarea(tareas, cfdiVerificado.id, "u", "2026-03-02T00:00:00.000Z");
    tareas = completarTarea(tareas, conciliacion.id, "u", "2026-03-02T00:00:00.000Z");

    const declaracionesAunBloqueada = tareas.find((t) => t.id === declaraciones.id)!;
    expect(declaracionesAunBloqueada.status).toBe("blocked"); // nomina aún no está done

    tareas = completarTarea(tareas, nomina.id, "u", "2026-03-02T00:00:00.000Z");
    const declaracionesDesbloqueada = tareas.find((t) => t.id === declaraciones.id)!;
    expect(declaracionesDesbloqueada.status).toBe("pending");
  });

  it("lanza si la tarea ya está done/skipped", () => {
    const tareas = materializarTareas("p1");
    const cfdiVerificado = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;
    const actualizadas = completarTarea(tareas, cfdiVerificado.id, "u", "2026-03-02T00:00:00.000Z");
    expect(() => completarTarea(actualizadas, cfdiVerificado.id, "u", "2026-03-03T00:00:00.000Z")).toThrow(TareaCierreEstadoInvalidoError);
  });

  it("lanza si la tarea está bloqueada por una dependencia sin completar", () => {
    const tareas = materializarTareas("p1");
    const folios = tareas.find((t) => t.title === "Validar folios fiscales y sellos")!;
    expect(() => completarTarea(tareas, folios.id, "u", "2026-03-02T00:00:00.000Z")).toThrow(TareaCierreEstadoInvalidoError);
  });
});

describe("autoCheckTareas", () => {
  it("cfdi_pending_count=0 completa la tarea CFDI y desbloquea dependientes", () => {
    const tareas = materializarTareas("p1");
    const { tareas: actualizadas, completadas } = autoCheckTareas(tareas, { cfdi_pending_count: 0 }, "system", "2026-03-02T00:00:00.000Z");
    expect(completadas).toHaveLength(1);
    const folios = actualizadas.find((t) => t.title === "Validar folios fiscales y sellos")!;
    expect(folios.status).toBe("pending");
  });

  it("cfdi_pending_count>0 NO completa la tarea", () => {
    const tareas = materializarTareas("p1");
    const { completadas } = autoCheckTareas(tareas, { cfdi_pending_count: 3 }, "system", "2026-03-02T00:00:00.000Z");
    expect(completadas).toHaveLength(0);
  });

  it("bank_feeds_sync_status acepta ok/synced/completed; conciliacion sigue bloqueada mientras su dependencia no esté done", () => {
    const tareas = materializarTareas("p1");
    const conciliacion = tareas.find((t) => t.title === "Conciliación bancaria completada")!;
    // NOTA DE FIDELIDAD (quirk real del origen, no un bug del port): el
    // predicado `cfdi_pending_count: (v) => Number(v ?? 0) === 0` trata la
    // AUSENCIA de la señal como "0 pendientes" (mismo `int(v or 0) == 0` de
    // Python) -- así que hay que fijar `cfdi_pending_count` a un valor
    // explícito >0 para que "cfdi_verificado" NO se autocomplete en la misma
    // pasada y arrastre a "conciliacion" con él.
    const r1 = autoCheckTareas(tareas, { cfdi_pending_count: 5, bank_feeds_sync_status: "ok" }, "system", "2026-03-02T00:00:00.000Z");
    expect(r1.tareas.find((t) => t.id === conciliacion.id)!.status).toBe("blocked");
  });

  it("ausencia de una señal se trata como 0 (int(v or 0)==0) y SÍ auto-completa -- quirk documentado del origen", () => {
    const tareas = materializarTareas("p1");
    const cfdiVerificado = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;
    const { tareas: actualizadas } = autoCheckTareas(tareas, {}, "system", "2026-03-02T00:00:00.000Z");
    expect(actualizadas.find((t) => t.id === cfdiVerificado.id)!.status).toBe("done");
  });

  it("valor no reconocido para un auto_check_query desconocido nunca completa nada", () => {
    const tareas = materializarTareas("p1");
    const { completadas } = autoCheckTareas(tareas, { cfdi_pending_count: 0, algo_no_mapeado: true }, "system", "2026-03-02T00:00:00.000Z");
    expect(completadas.map((t) => t.autoCheckQuery)).not.toContain("algo_no_mapeado");
  });
});

describe("recomputeOverdue", () => {
  it("open -> overdue si hay una tarea required vencida en estado no terminal", () => {
    const tareas = materializarTareas("p1").map((t, i) => (i === 1 ? { ...t, dueDate: "2020-01-01" } : t));
    const actualizado = recomputeOverdue(periodo({ status: "open" }), tareas, "2026-03-15");
    expect(actualizado.status).toBe("overdue");
  });
  it("nunca transiciona un período ya closed", () => {
    const tareas = materializarTareas("p1").map((t, i) => (i === 1 ? { ...t, dueDate: "2020-01-01" } : t));
    const actualizado = recomputeOverdue(periodo({ status: "closed" }), tareas, "2026-03-15");
    expect(actualizado.status).toBe("closed");
  });
  it("sin vencidas, permanece open", () => {
    const tareas = materializarTareas("p1");
    const actualizado = recomputeOverdue(periodo({ status: "open" }), tareas, "2026-03-15");
    expect(actualizado.status).toBe("open");
  });
});

describe("calcularEstadoPeriodo", () => {
  it("progressPercent cuenta done+skipped sobre el total", () => {
    const tareas = materializarTareas("p1");
    const conDone = completarTarea(tareas, tareas[0]!.id, "u", "2026-03-02T00:00:00.000Z");
    const estado = calcularEstadoPeriodo(conDone, "2026-03-15");
    expect(estado.done).toBe(1);
    expect(estado.totalTasks).toBe(15);
    expect(estado.progressPercent).toBeCloseTo((1 / 15) * 100, 1);
  });
});

describe("evaluarCierre / cerrarPeriodo", () => {
  it("no permite cerrar con tareas requeridas pendientes", () => {
    const tareas = materializarTareas("p1");
    const { puedeCerrar, faltantes } = evaluarCierre(tareas);
    expect(puedeCerrar).toBe(false);
    expect(faltantes.length).toBeGreaterThan(0);
    expect(() => cerrarPeriodo(periodo(), tareas, "admin", "2026-03-31T00:00:00.000Z")).toThrow(CierreValidacionError);
  });

  it("cierra cuando todas las tareas requeridas están done", () => {
    const tareas = materializarTareas("p1").map((t) => ({ ...t, status: "done" as const, completedAt: "2026-03-30T00:00:00.000Z", completedBy: "u" }));
    const cerrado = cerrarPeriodo(periodo(), tareas, "admin", "2026-03-31T00:00:00.000Z");
    expect(cerrado.status).toBe("closed");
    expect(cerrado.closedBy).toBe("admin");
    expect(cerrado.closedAt).toBe("2026-03-31T00:00:00.000Z");
  });

  it("CORRECCIÓN DE FIDELIDAD: rechaza volver a cerrar un período ya closed (el Python original NO lo valida)", () => {
    const tareas = materializarTareas("p1").map((t) => ({ ...t, status: "done" as const }));
    expect(() => cerrarPeriodo(periodo({ status: "closed" }), tareas, "admin", "2026-04-01T00:00:00.000Z")).toThrow(CierreValidacionError);
  });
});

describe("generarReporteCierre", () => {
  it("resume done/pending/progress y arma doneByCategory", () => {
    const tareas = materializarTareas("p1");
    const conDone = completarTarea(tareas, tareas[0]!.id, "u", "2026-03-02T00:00:00.000Z");
    const reporte = generarReporteCierre(periodo(), conDone, "2026-03-15");
    expect(reporte.done).toBe(1);
    expect(reporte.totalTasks).toBe(15);
    expect(reporte.doneByCategory.cfdi).toBe(1);
    expect(reporte.closed).toBe(false);
  });
});
