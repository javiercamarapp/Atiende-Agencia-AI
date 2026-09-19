// Motor puro del resumen diario -- ver ../src/resumen-diario/motor.ts. Tres
// garantías DURAS a probar: (1) una sección `null` (lectura fallida) nunca se
// confunde con ceros reales; (2) las deltas comparan contra el resumen de
// AYER ya persistido, y son `null` (nunca inventadas) cuando cualquiera de
// los dos lados no se pudo leer; (3) la ventana de un día calendario en
// America/Mexico_City está bien calculada, incluido el cambio de día.
import { describe, expect, it } from "vitest";
import { combinarDiarioAgregados, fechaAyerMexico, PROSPECTOS_SIN_MOVIMIENTO_DIAS, umbralSinMovimiento, ventanaDiaMexico, type DiarioAgregados, type FuentesDiarias } from "../src/resumen-diario/motor.ts";

function fuentesVacias(overrides: Partial<FuentesDiarias> = {}): FuentesDiarias {
  return {
    fecha: "2026-01-15",
    crons: [],
    colas: [],
    licitacionesFuentes: [],
    llmPlatformBudget: { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 },
    gastoLlmHoy: { costoMicroUsd: 0, tokensIn: 0, tokensOut: 0, llamadas: 0 },
    topOrganizacionesGastoLlm: [],
    organizacionesStaffNuevos: { organizacionesNuevas: 0, nombresOrganizacionesNuevas: [], staffNuevos: 0 },
    prospectos: { altas: 0, cambiosEstado: 0, sinMovimiento: 0 },
    facturacion: { altas: 0, bajas: 0, morososNuevos: 0, activasTotal: 0, pagoPendienteTotal: 0, canceladaTotal: 0, sinSuscripcionTotal: 0 },
    breakGlassAbiertos: 0,
    ...overrides,
  };
}

describe("ventanaDiaMexico", () => {
  it("resuelve el rango UTC [desde, hasta) de un día calendario en America/Mexico_City (UTC-6 fijo)", () => {
    const ventana = ventanaDiaMexico("2026-01-15");
    expect(ventana.desde).toBe("2026-01-15T06:00:00.000Z");
    expect(ventana.hasta).toBe("2026-01-16T06:00:00.000Z");
  });

  it("cruza el fin de mes/año correctamente", () => {
    expect(ventanaDiaMexico("2025-12-31")).toEqual({ desde: "2025-12-31T06:00:00.000Z", hasta: "2026-01-01T06:00:00.000Z" });
  });

  it("rechaza una fecha con formato inválido", () => {
    expect(() => ventanaDiaMexico("15-01-2026")).toThrow();
    expect(() => ventanaDiaMexico("2026-1-5")).toThrow();
  });
});

describe("fechaAyerMexico -- cambio de día en zona horaria", () => {
  it("09:00 local (15:00 UTC, hora real del cron) resume el día calendario ANTERIOR", () => {
    expect(fechaAyerMexico(new Date("2026-01-15T15:00:00.000Z"))).toBe("2026-01-14");
  });

  it("justo ANTES de la medianoche local (05:59 UTC = 23:59 local del día anterior) -- \"ayer\" es un día más atrás todavía", () => {
    expect(fechaAyerMexico(new Date("2026-01-15T05:59:00.000Z"))).toBe("2026-01-13");
  });

  it("justo EN el instante de la medianoche local (06:00 UTC = 00:00 local) -- el día local ya cambió a 15, así que \"ayer\" es 14", () => {
    expect(fechaAyerMexico(new Date("2026-01-15T06:00:00.000Z"))).toBe("2026-01-14");
  });

  it("un segundo antes de la medianoche local siguiente (05:59:59 UTC del día 16) sigue viendo el 14 como ayer", () => {
    expect(fechaAyerMexico(new Date("2026-01-16T05:59:59.000Z"))).toBe("2026-01-14");
  });
});

describe("umbralSinMovimiento", () => {
  it("es `ahora - N días` en ISO, con el default de PROSPECTOS_SIN_MOVIMIENTO_DIAS", () => {
    const ahora = new Date("2026-01-15T12:00:00.000Z");
    const umbral = new Date(umbralSinMovimiento(ahora));
    const diffDias = (ahora.getTime() - umbral.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDias).toBeCloseTo(PROSPECTOS_SIN_MOVIMIENTO_DIAS, 5);
  });

  it("acepta un número de días explícito", () => {
    const ahora = new Date("2026-01-15T12:00:00.000Z");
    expect(umbralSinMovimiento(ahora, 7)).toBe("2026-01-08T12:00:00.000Z");
  });
});

describe("combinarDiarioAgregados -- sección null NUNCA se confunde con ceros", () => {
  it("facturacion=null -> agregados.facturacion es null (no un objeto en ceros)", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ facturacion: null }), null);
    expect(agregados.facturacion).toBeNull();
  });

  it("prospectos=null -> agregados.prospectos es null", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ prospectos: null }), null);
    expect(agregados.prospectos).toBeNull();
  });

  it("organizacionesStaffNuevos=null -> agregados.organizacionesStaff es null", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ organizacionesStaffNuevos: null }), null);
    expect(agregados.organizacionesStaff).toBeNull();
  });

  it("colas=null -> mensajeria es null Y la sección de salud también refleja 'no se pudo leer' (reutiliza el motor de salud)", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ colas: null }), null);
    expect(agregados.mensajeria).toBeNull();
    expect(agregados.salud.colas).toBeNull();
    expect(agregados.salud.alertas.some((a) => a.titulo.includes("colas de mensajería"))).toBe(true);
  });

  it("crons=null -> salud.crons es null y aparece la alerta 'no se pudo leer el estado de los crons'", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ crons: null }), null);
    expect(agregados.salud.crons).toBeNull();
    expect(agregados.salud.alertas.some((a) => a.titulo.includes("No se pudo leer el estado de los crons"))).toBe(true);
  });

  it("breakGlassAbiertos=null (distinto de 0, que significa 'sí se leyó y no hubo ninguno')", () => {
    const conNull = combinarDiarioAgregados(fuentesVacias({ breakGlassAbiertos: null }), null);
    const conCero = combinarDiarioAgregados(fuentesVacias({ breakGlassAbiertos: 0 }), null);
    expect(conNull.breakGlassAbiertos).toBeNull();
    expect(conCero.breakGlassAbiertos).toBe(0);
  });

  it("gastoLlmHoy=null -> costoHoyMicroUsd es null (nunca 0 disfrazado)", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ gastoLlmHoy: null }), null);
    expect(agregados.gastoLlm.costoHoyMicroUsd).toBeNull();
  });

  it("todo en null -- ninguna sección revienta, todas quedan explícitamente null", () => {
    const agregados = combinarDiarioAgregados(
      fuentesVacias({
        crons: null,
        colas: null,
        licitacionesFuentes: null,
        llmPlatformBudget: null,
        gastoLlmHoy: null,
        topOrganizacionesGastoLlm: null,
        organizacionesStaffNuevos: null,
        prospectos: null,
        facturacion: null,
        breakGlassAbiertos: null,
      }),
      null,
    );
    expect(agregados.facturacion).toBeNull();
    expect(agregados.prospectos).toBeNull();
    expect(agregados.organizacionesStaff).toBeNull();
    expect(agregados.mensajeria).toBeNull();
    expect(agregados.breakGlassAbiertos).toBeNull();
    expect(agregados.salud.crons).toBeNull();
    expect(agregados.salud.colas).toBeNull();
    expect(agregados.salud.licitacionesFuentesConAlerta).toBeNull();
    expect(agregados.gastoLlm.costoHoyMicroUsd).toBeNull();
    expect(agregados.gastoLlm.pctTopePlataforma).toBeNull();
  });
});

describe("combinarDiarioAgregados -- deltas contra el resumen de ayer", () => {
  it("sin resumen de ayer -> deltas es null", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias(), null);
    expect(agregados.deltas).toBeNull();
  });

  it("con resumen de ayer -> cada delta es hoy menos ayer", () => {
    const ayer = combinarDiarioAgregados(
      fuentesVacias({
        gastoLlmHoy: { costoMicroUsd: 1_000_000, tokensIn: 0, tokensOut: 0, llamadas: 1 },
        organizacionesStaffNuevos: { organizacionesNuevas: 2, nombresOrganizacionesNuevas: ["A", "B"], staffNuevos: 3 },
        prospectos: { altas: 5, cambiosEstado: 1, sinMovimiento: 0 },
        facturacion: { altas: 1, bajas: 0, morososNuevos: 0, activasTotal: 10, pagoPendienteTotal: 0, canceladaTotal: 0, sinSuscripcionTotal: 0 },
      }),
      null,
    );

    const hoy = combinarDiarioAgregados(
      fuentesVacias({
        fecha: "2026-01-16",
        gastoLlmHoy: { costoMicroUsd: 1_500_000, tokensIn: 0, tokensOut: 0, llamadas: 2 },
        organizacionesStaffNuevos: { organizacionesNuevas: 1, nombresOrganizacionesNuevas: ["C"], staffNuevos: 0 },
        prospectos: { altas: 3, cambiosEstado: 2, sinMovimiento: 1 },
        facturacion: { altas: 2, bajas: 1, morososNuevos: 0, activasTotal: 11, pagoPendienteTotal: 0, canceladaTotal: 0, sinSuscripcionTotal: 0 },
      }),
      ayer,
    );

    expect(hoy.deltas).not.toBeNull();
    expect(hoy.deltas!.costoLlmMicroUsd).toBe(500_000);
    expect(hoy.deltas!.organizacionesNuevas).toBe(-1);
    expect(hoy.deltas!.staffNuevos).toBe(-3);
    expect(hoy.deltas!.prospectosAltas).toBe(-2);
    expect(hoy.deltas!.facturacionAltas).toBe(1);
    expect(hoy.deltas!.facturacionBajas).toBe(1);
    expect(hoy.deltas!.alertasSalud).toBe(0);
  });

  it("cuando HOY no se pudo leer una sección pero AYER sí, esa delta es null (nunca se inventa un cero para restar)", () => {
    const ayer = combinarDiarioAgregados(fuentesVacias({ facturacion: { altas: 4, bajas: 0, morososNuevos: 0, activasTotal: 9, pagoPendienteTotal: 0, canceladaTotal: 0, sinSuscripcionTotal: 0 } }), null);
    const hoy = combinarDiarioAgregados(fuentesVacias({ fecha: "2026-01-16", facturacion: null }), ayer);
    expect(hoy.deltas!.facturacionAltas).toBeNull();
  });

  it("cuando AYER no se pudo leer una sección pero HOY sí, esa delta también es null", () => {
    const ayer = combinarDiarioAgregados(fuentesVacias({ organizacionesStaffNuevos: null }), null);
    const hoy = combinarDiarioAgregados(fuentesVacias({ fecha: "2026-01-16", organizacionesStaffNuevos: { organizacionesNuevas: 3, nombresOrganizacionesNuevas: [], staffNuevos: 1 } }), ayer);
    expect(hoy.deltas!.organizacionesNuevas).toBeNull();
  });
});

describe("combinarDiarioAgregados -- pctTopePlataforma", () => {
  it("calcula el porcentaje del tope mensual de plataforma", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ llmPlatformBudget: { monthlyCapMicroUsd: 1_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 250_000 } }), null);
    expect(agregados.gastoLlm.pctTopePlataforma).toBe(25);
  });

  it("tope <= 0 (no debería pasar, pero nunca divide entre cero) -> null", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ llmPlatformBudget: { monthlyCapMicroUsd: 0, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 } }), null);
    expect(agregados.gastoLlm.pctTopePlataforma).toBeNull();
  });

  it("sin tope leído -> null", () => {
    const agregados = combinarDiarioAgregados(fuentesVacias({ llmPlatformBudget: null }), null);
    expect(agregados.gastoLlm.pctTopePlataforma).toBeNull();
  });
});

describe("combinarDiarioAgregados -- prospectos trae el umbral usado", () => {
  it("expone `umbralSinMovimientoDias` junto con el conteo, para que la redacción/pantalla lo cite", () => {
    const agregados: DiarioAgregados = combinarDiarioAgregados(fuentesVacias({ prospectos: { altas: 0, cambiosEstado: 0, sinMovimiento: 2 } }), null);
    expect(agregados.prospectos).toEqual({ altas: 0, cambiosEstado: 0, sinMovimiento: 2, umbralSinMovimientoDias: PROSPECTOS_SIN_MOVIMIENTO_DIAS });
  });
});
