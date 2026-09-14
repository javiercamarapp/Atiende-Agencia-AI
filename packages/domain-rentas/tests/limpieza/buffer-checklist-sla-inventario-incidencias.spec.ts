// Tests puros (sin DB) de los 5 módulos de dominio de src/limpieza/* — mismo
// criterio que tests/fechas.spec.ts/tests/estados.spec.ts: solo entradas/salidas,
// sin fixture transaccional.
import { describe, expect, it } from "vitest";
import { calcularRangoBuffer } from "../../src/limpieza/buffer.ts";
import { checklistCompleto, plantillaChecklistPorTipo, puedeCompletarTarea, PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO, PLANTILLA_CHECKLIST_MANTENIMIENTO_DEFECTO } from "../../src/limpieza/checklist.ts";
import { calcularVencimientoSla, tareaVencida } from "../../src/limpieza/sla.ts";
import { aplicarConsumo, stockBajo } from "../../src/limpieza/inventario.ts";
import { requiereConfirmacionHumanaParaBloqueo } from "../../src/limpieza/incidencias.ts";

describe("calcularRangoBuffer", () => {
  it("retorna null cuando bufferNoches es 0 (sin buffer)", () => {
    expect(calcularRangoBuffer("2026-06-05", 0)).toBeNull();
  });

  it("retorna null cuando bufferNoches es negativo (defensa, nunca debería pasar validado)", () => {
    expect(calcularRangoBuffer("2026-06-05", -1)).toBeNull();
  });

  it("[checkout, checkout + n noches) para n=1", () => {
    expect(calcularRangoBuffer("2026-06-05", 1)).toEqual({ inicio: "2026-06-05", fin: "2026-06-06" });
  });

  it("[checkout, checkout + n noches) para n=2, cruzando fin de mes", () => {
    expect(calcularRangoBuffer("2026-06-30", 2)).toEqual({ inicio: "2026-06-30", fin: "2026-07-02" });
  });
});

describe("checklistCompleto / puedeCompletarTarea", () => {
  it("una tarea sin ningún ítem de checklist siempre puede completarse (mantenimiento/inspección sin checklist)", () => {
    expect(checklistCompleto([])).toBe(true);
    expect(puedeCompletarTarea([])).toBe(true);
  });

  it("false si algún ítem sigue pendiente", () => {
    expect(checklistCompleto([{ completado: true }, { completado: false }])).toBe(false);
  });

  it("true solo cuando TODOS los ítems están completos", () => {
    expect(checklistCompleto([{ completado: true }, { completado: true }])).toBe(true);
  });
});

describe("plantillaChecklistPorTipo", () => {
  it("limpieza usa la plantilla de limpieza por defecto", () => {
    expect(plantillaChecklistPorTipo("limpieza")).toBe(PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO);
  });

  it("mantenimiento usa la plantilla de mantenimiento por defecto", () => {
    expect(plantillaChecklistPorTipo("mantenimiento")).toBe(PLANTILLA_CHECKLIST_MANTENIMIENTO_DEFECTO);
  });

  it("inspeccion no tiene plantilla por defecto (checklist vacío)", () => {
    expect(plantillaChecklistPorTipo("inspeccion")).toEqual([]);
  });
});

describe("SLA", () => {
  it("SLA urgente = mitad del tiempo base configurado", () => {
    const venceEn = calcularVencimientoSla("2026-06-05T10:00:00.000Z", "limpieza", "urgente", { slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });
    expect(venceEn).toBe("2026-06-05T12:00:00.000Z");
  });

  it("SLA baja = el doble del tiempo base configurado", () => {
    const venceEn = calcularVencimientoSla("2026-06-05T10:00:00.000Z", "limpieza", "baja", { slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });
    expect(venceEn).toBe("2026-06-05T18:00:00.000Z");
  });

  it("mantenimiento usa slaMantenimientoHoras, no slaLimpiezaHoras", () => {
    const venceEn = calcularVencimientoSla("2026-06-05T10:00:00.000Z", "mantenimiento", "media", { slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });
    expect(venceEn).toBe("2026-06-06T10:00:00.000Z");
  });

  it("nunca redondea a menos de 1 hora efectiva (piso duro)", () => {
    const venceEn = calcularVencimientoSla("2026-06-05T10:00:00.000Z", "limpieza", "urgente", { slaLimpiezaHoras: 1, slaMantenimientoHoras: 24 });
    expect(venceEn).toBe("2026-06-05T11:00:00.000Z");
  });

  it("tareaVencida: false si ya se completó, incluso pasado el vencimiento", () => {
    expect(tareaVencida("2026-06-05T12:00:00.000Z", "2026-06-05T13:00:00.000Z", "2026-06-06T00:00:00.000Z")).toBe(false);
  });

  it("tareaVencida: false si no tiene sla_vence_en (tarea sin SLA aplicable)", () => {
    expect(tareaVencida(null, null, "2026-06-06T00:00:00.000Z")).toBe(false);
  });

  it("tareaVencida: true si el vencimiento ya pasó y sigue sin completarse", () => {
    expect(tareaVencida("2026-06-05T12:00:00.000Z", null, "2026-06-05T13:00:00.000Z")).toBe(true);
  });

  it("tareaVencida: false si el vencimiento todavía no llega", () => {
    expect(tareaVencida("2026-06-05T12:00:00.000Z", null, "2026-06-05T11:00:00.000Z")).toBe(false);
  });
});

describe("Inventario", () => {
  it("aplicarConsumo resta cantidad y nunca baja de 0", () => {
    expect(aplicarConsumo({ cantidadActual: 3, umbralMinimo: 5 }, 10)).toEqual({ cantidadNueva: 0, cruzaUmbralMinimo: false });
  });

  it("aplicarConsumo detecta cuando el consumo cruza el umbral mínimo (estaba encima, queda debajo)", () => {
    expect(aplicarConsumo({ cantidadActual: 10, umbralMinimo: 5 }, 6)).toEqual({ cantidadNueva: 4, cruzaUmbralMinimo: true });
  });

  it("aplicarConsumo NO marca cruce si ya estaba por debajo del umbral (evita repetir la alerta en cada consumo)", () => {
    expect(aplicarConsumo({ cantidadActual: 4, umbralMinimo: 5 }, 1)).toEqual({ cantidadNueva: 3, cruzaUmbralMinimo: false });
  });

  it("aplicarConsumo lanza si cantidadConsumida es negativa", () => {
    expect(() => aplicarConsumo({ cantidadActual: 3, umbralMinimo: 5 }, -1)).toThrow();
  });

  it("stockBajo compara estrictamente contra el umbral", () => {
    expect(stockBajo({ cantidadActual: 5, umbralMinimo: 5 })).toBe(false);
    expect(stockBajo({ cantidadActual: 4, umbralMinimo: 5 })).toBe(true);
  });
});

describe("requiereConfirmacionHumanaParaBloqueo", () => {
  it("solo severidad 'grave' es candidata a proponer un bloqueo de mantenimiento", () => {
    expect(requiereConfirmacionHumanaParaBloqueo("grave")).toBe(true);
    expect(requiereConfirmacionHumanaParaBloqueo("moderada")).toBe(false);
    expect(requiereConfirmacionHumanaParaBloqueo("leve")).toBe(false);
  });
});
