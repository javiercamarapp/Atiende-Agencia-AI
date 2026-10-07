// paridad3 D-P3-15 -- validaciones del cierre derivadas del estado de modulos calculado en el servidor y moduleState del auto-check.
import { describe, expect, it } from "vitest";
import { autoCheckTareas, autoCheckHastaPuntoFijo, evaluarValidacionesCierre, getTemplate, construirTareasDesdePlantilla, moduleStateDesdeEstado, requierePagosProvisionales, validacionesFallidas } from "../src/index.ts";
import type { CloseTask, EstadoModulosCierre } from "../src/index.ts";

const OK: EstadoModulosCierre = {
  debeCentavos: 1_000_000,
  haberCentavos: 1_000_000,
  polizas: 12,
  polizasDescuadradas: 0,
  cfdiTotal: 12,
  cfdiSinPoliza: 0,
  cfdiInvalidos: 0,
  conciliacionSesiones: 1,
  conciliacionAbiertas: 0,
  movimientos: 100,
  movimientosConciliados: 90,
  pagosProvisionales: 2,
  solicitudEstado: "completa",
  solicitudPendientes: 0,
  periodicidad: "mensual",
};
const con = (parcial: Partial<EstadoModulosCierre>): EstadoModulosCierre => ({ ...OK, ...parcial });
const claves = (e: EstadoModulosCierre, mes = 6) => validacionesFallidas(evaluarValidacionesCierre(e, mes)).map((v) => v.clave);

describe("evaluarValidacionesCierre", () => {
  it("un periodo sano no tiene validaciones fallidas", () => {
    expect(claves(OK)).toEqual([]);
    expect(evaluarValidacionesCierre(OK, 6)).toHaveLength(6);
  });

  it("la balanza tolera $1 y bloquea por encima", () => {
    expect(claves(con({ haberCentavos: 1_000_100 }))).toEqual([]);
    expect(claves(con({ haberCentavos: 1_000_101 }))).toEqual(["balanza"]);
    const v = evaluarValidacionesCierre(con({ debeCentavos: 5_000, haberCentavos: 0 }), 6).find((x) => x.clave === "balanza")!;
    expect(v.mensaje).toMatch(/no cuadra/);
    expect(v.detalle).toMatchObject({ diferenciaCentavos: 5000 });
  });

  it("una poliza descuadrada o un CFDI sin poliza bloquean", () => {
    expect(claves(con({ polizasDescuadradas: 1 }))).toEqual(["polizas"]);
    expect(claves(con({ cfdiSinPoliza: 3 }))).toEqual(["cfdi_sin_poliza"]);
  });

  it("conciliacion: >= 80 % y sesiones cerradas; sin movimientos no hay nada que conciliar", () => {
    expect(claves(con({ movimientos: 100, movimientosConciliados: 80 }))).toEqual([]);
    expect(claves(con({ movimientos: 100, movimientosConciliados: 79 }))).toEqual(["conciliacion"]);
    expect(claves(con({ conciliacionAbiertas: 1 }))).toEqual(["conciliacion"]);
    expect(claves(con({ conciliacionSesiones: 0, conciliacionAbiertas: 0 }))).toEqual(["conciliacion"]);
    expect(claves(con({ movimientos: 0, movimientosConciliados: 0, conciliacionSesiones: 0 }))).toEqual([]);
  });

  it("papel de pagos provisionales: obligatorio, salvo meses nones de un cliente bimestral", () => {
    expect(claves(con({ pagosProvisionales: 0 }))).toEqual(["pagos_provisionales"]);
    expect(claves(con({ pagosProvisionales: 0, periodicidad: "bimestral" }), 5)).toEqual([]);
    expect(claves(con({ pagosProvisionales: 0, periodicidad: "bimestral" }), 6)).toEqual(["pagos_provisionales"]);
    expect(requierePagosProvisionales("bimestral", 1)).toBe(false);
    expect(requierePagosProvisionales("mensual", 1)).toBe(true);
    expect(requierePagosProvisionales(null, 1)).toBe(true);
  });

  it("solicitud de documentos: sin solicitud no se evalua; abierta bloquea con el conteo", () => {
    expect(claves(con({ solicitudEstado: null }))).toEqual([]);
    expect(claves(con({ solicitudEstado: "abierta", solicitudPendientes: 2 }))).toEqual(["solicitud_documentos"]);
    expect(evaluarValidacionesCierre(con({ solicitudEstado: "abierta", solicitudPendientes: 2 }), 6).find((v) => v.clave === "solicitud_documentos")!.mensaje).toMatch(/Faltan 2/);
  });

  it("todas las fallas se listan juntas (el staff ve todo lo que falta de una vez)", () => {
    expect(claves(con({ haberCentavos: 0, polizasDescuadradas: 2, cfdiSinPoliza: 1, movimientosConciliados: 0, pagosProvisionales: 0, solicitudEstado: "abierta", solicitudPendientes: 1 }))).toEqual([
      "balanza",
      "polizas",
      "cfdi_sin_poliza",
      "conciliacion",
      "pagos_provisionales",
      "solicitud_documentos",
    ]);
  });

  it("el detalle no lleva datos personales (solo numeros y claves)", () => {
    for (const v of evaluarValidacionesCierre(con({ cfdiSinPoliza: 3 }), 6)) {
      for (const valor of Object.values(v.detalle)) expect(["number", "boolean", "string"].includes(typeof valor) || valor === null).toBe(true);
      expect(JSON.stringify(v)).not.toMatch(/@|[A-Z]{3,4}\d{6}/);
    }
  });
});

function tareasDeLaPlantilla(): readonly CloseTask[] {
  const nuevas = construirTareasDesdePlantilla(2026, 6, getTemplate());
  const ids = nuevas.map((_, i) => `t${i}`);
  const porKey = new Map(nuevas.map((n, i) => [n.key, ids[i]!] as const));
  return nuevas.map((n, i) => ({
    id: ids[i]!,
    periodId: "p1",
    templateKey: n.key,
    title: n.title,
    description: n.description,
    category: n.category,
    status: n.status,
    dependsOn: n.dependsOnKeys.map((k) => porKey.get(k)!),
    dueDate: n.dueDate,
    autoCheckQuery: n.autoCheckQuery,
    required: n.required,
    completedAt: null,
    completedBy: null,
  })) as unknown as readonly CloseTask[];
}

describe("moduleStateDesdeEstado + auto-check", () => {
  it("solo trae claves con senal persistida (nomina, DIOT, contabilidad electronica, auxiliares y reportes siguen manuales)", () => {
    expect(Object.keys(moduleStateDesdeEstado(OK, 6)).sort()).toEqual(["bank_feeds_sync_status", "cfdi_pending_count", "cfdi_validacion", "declaraciones_revisadas"]);
  });

  it("un periodo sano completa en cascada las tareas con senal; las manuales y las que dependen de una manual quedan pendientes", () => {
    const { completadas } = autoCheckHastaPuntoFijo(tareasDeLaPlantilla(), (t) => autoCheckTareas(t, moduleStateDesdeEstado(OK, 6), "sistema", "2026-07-01T00:00:00Z"));
    const keys = completadas.map((t) => (t as unknown as { autoCheckQuery: string }).autoCheckQuery).sort();
    // «Revisar declaraciones» depende de las nominas timbradas (manual): no se completa sola aunque el papel este generado.
    expect(keys).toEqual(["bank_feeds_sync_status", "cfdi_pending_count", "cfdi_validacion"]);
  });

  it("el estado vacio del cliente (moduleState {}) ya no es la fuente: sin senal de CFDI el servidor manda el conteo real y la tarea NO se completa", () => {
    const { completadas } = autoCheckHastaPuntoFijo(tareasDeLaPlantilla(), (t) => autoCheckTareas(t, moduleStateDesdeEstado(con({ cfdiSinPoliza: 1 }), 6), "sistema", "2026-07-01T00:00:00Z"));
    expect(completadas.map((t) => (t as unknown as { autoCheckQuery: string }).autoCheckQuery)).not.toContain("cfdi_pending_count");
  });

  it("con CFDI sin poliza no se completa ni la primera tarea ni nada que dependa de ella", () => {
    const { completadas } = autoCheckHastaPuntoFijo(tareasDeLaPlantilla(), (t) => autoCheckTareas(t, moduleStateDesdeEstado(con({ cfdiSinPoliza: 2 }), 6), "sistema", "2026-07-01T00:00:00Z"));
    expect(completadas).toEqual([]);
  });

  it("conciliacion insuficiente deja bank_feeds_sync_status en pendiente", () => {
    expect(moduleStateDesdeEstado(con({ movimientosConciliados: 10 }), 6).bank_feeds_sync_status).toBe("pendiente");
  });

  it("el punto fijo se detiene (no itera sin fin) cuando no hay nada nuevo", () => {
    let vueltas = 0;
    const r = autoCheckHastaPuntoFijo(tareasDeLaPlantilla(), (t) => {
      vueltas += 1;
      return autoCheckTareas(t, { cfdi_pending_count: 5 }, "sistema", "x");
    });
    expect(r.completadas).toEqual([]);
    expect(vueltas).toBe(1);
  });
});
