// Fase 11 hoteles (REQ-CRM-002/003, P1/F) — tests del índice de reputación agregado
// (construcción nueva de esta fase, ver header de src/reputacion/indice.ts).
import { describe, expect, it } from "vitest";
import { calcularIndiceReputacion, type ResenaClasificadaParaIndice } from "../src/reputacion/indice.ts";

function resena(partial: Partial<ResenaClasificadaParaIndice>): ResenaClasificadaParaIndice {
  return {
    sentimientoEtiqueta: "neutral",
    sentimientoPuntaje: 0,
    temas: [],
    calificacion: null,
    ...partial,
  };
}

describe("calcularIndiceReputacion — caso vacío", () => {
  it("no divide entre cero: promedios/índice null, distribución en cero, sin temas", () => {
    const r = calcularIndiceReputacion([]);
    expect(r.totalResenas).toBe(0);
    expect(r.promedioSentimiento).toBeNull();
    expect(r.promedioCalificacion).toBeNull();
    expect(r.puntajeIndice).toBeNull();
    expect(r.distribucionSentimiento).toEqual({ muy_negativo: 0, negativo: 0, neutral: 0, positivo: 0, muy_positivo: 0 });
    expect(r.temasFrecuentes).toHaveLength(0);
    expect(r.temasCriticos).toHaveLength(0);
  });
});

describe("calcularIndiceReputacion — distribución y promedios", () => {
  it("cuenta totalResenas y la distribución de sentimiento correctamente", () => {
    const r = calcularIndiceReputacion([
      resena({ sentimientoEtiqueta: "muy_positivo", sentimientoPuntaje: 0.9 }),
      resena({ sentimientoEtiqueta: "muy_positivo", sentimientoPuntaje: 0.8 }),
      resena({ sentimientoEtiqueta: "negativo", sentimientoPuntaje: -0.4 }),
    ]);
    expect(r.totalResenas).toBe(3);
    expect(r.distribucionSentimiento.muy_positivo).toBe(2);
    expect(r.distribucionSentimiento.negativo).toBe(1);
    expect(r.distribucionSentimiento.neutral).toBe(0);
  });

  it("distribucionSentimientoPct suma ~100 y refleja la proporción real", () => {
    const r = calcularIndiceReputacion([
      resena({ sentimientoEtiqueta: "positivo" }),
      resena({ sentimientoEtiqueta: "positivo" }),
      resena({ sentimientoEtiqueta: "negativo" }),
      resena({ sentimientoEtiqueta: "negativo" }),
    ]);
    expect(r.distribucionSentimientoPct.positivo).toBe(50);
    expect(r.distribucionSentimientoPct.negativo).toBe(50);
    const suma = Object.values(r.distribucionSentimientoPct).reduce((a, b) => a + b, 0);
    expect(suma).toBeCloseTo(100, 1);
  });

  it("promedioSentimiento es el promedio simple de puntaje", () => {
    const r = calcularIndiceReputacion([
      resena({ sentimientoPuntaje: 1 }),
      resena({ sentimientoPuntaje: -0.5 }),
      resena({ sentimientoPuntaje: 0.5 }),
    ]);
    expect(r.promedioSentimiento).toBeCloseTo((1 - 0.5 + 0.5) / 3, 3);
  });

  it("promedioCalificacion ignora reseñas sin calificación (nunca les asume una)", () => {
    const r = calcularIndiceReputacion([
      resena({ calificacion: 5 }),
      resena({ calificacion: 3 }),
      resena({ calificacion: null }),
    ]);
    expect(r.promedioCalificacion).toBeCloseTo(4, 5);
  });

  it("promedioCalificacion es null cuando NINGUNA reseña trae calificación", () => {
    const r = calcularIndiceReputacion([resena({ calificacion: null }), resena({ calificacion: null })]);
    expect(r.promedioCalificacion).toBeNull();
  });

  it("puntajeIndice reescala promedioSentimiento (-1..1) a 0..100", () => {
    const todoPositivo = calcularIndiceReputacion([resena({ sentimientoPuntaje: 1, sentimientoEtiqueta: "muy_positivo" })]);
    expect(todoPositivo.puntajeIndice).toBe(100);
    const todoNegativo = calcularIndiceReputacion([resena({ sentimientoPuntaje: -1, sentimientoEtiqueta: "muy_negativo" })]);
    expect(todoNegativo.puntajeIndice).toBe(0);
    const neutro = calcularIndiceReputacion([resena({ sentimientoPuntaje: 0, sentimientoEtiqueta: "neutral" })]);
    expect(neutro.puntajeIndice).toBe(50);
  });
});

describe("calcularIndiceReputacion — temas frecuentes/críticos", () => {
  it("cuenta un tema por RESEÑA (no por mención repetida dentro de la misma reseña)", () => {
    const r = calcularIndiceReputacion([
      resena({
        sentimientoEtiqueta: "negativo",
        temas: [{ topic: "wifi", esConocido: true }],
      }),
    ]);
    const wifi = r.temasFrecuentes.find((t) => t.topic === "wifi");
    expect(wifi?.resenas).toBe(1);
  });

  it("agrega el mismo tema mencionado en varias reseñas distintas", () => {
    const r = calcularIndiceReputacion([
      resena({ sentimientoEtiqueta: "negativo", temas: [{ topic: "wifi", esConocido: true }] }),
      resena({ sentimientoEtiqueta: "negativo", temas: [{ topic: "wifi", esConocido: true }] }),
      resena({ sentimientoEtiqueta: "positivo", temas: [{ topic: "wifi", esConocido: true }] }),
    ]);
    const wifi = r.temasFrecuentes.find((t) => t.topic === "wifi");
    expect(wifi?.resenas).toBe(3);
    expect(wifi?.resenasNegativas).toBe(2);
    expect(wifi?.pctNegativo).toBeCloseTo((2 / 3) * 100, 1);
  });

  it("ordena temasFrecuentes por conteo de reseñas descendente", () => {
    const r = calcularIndiceReputacion([
      resena({ temas: [{ topic: "wifi", esConocido: true }] }),
      resena({ temas: [{ topic: "limpieza", esConocido: true }] }),
      resena({ temas: [{ topic: "limpieza", esConocido: true }] }),
      resena({ temas: [{ topic: "limpieza", esConocido: true }] }),
    ]);
    expect(r.temasFrecuentes[0]?.topic).toBe("limpieza");
    expect(r.temasFrecuentes[0]?.resenas).toBe(3);
  });

  it("temasCriticos exige mayoría negativa (>50%) Y el mínimo de reseñas configurado", () => {
    const r = calcularIndiceReputacion(
      [
        resena({ sentimientoEtiqueta: "negativo", temas: [{ topic: "ruido", esConocido: true }] }),
        resena({ sentimientoEtiqueta: "negativo", temas: [{ topic: "ruido", esConocido: true }] }),
        resena({ sentimientoEtiqueta: "positivo", temas: [{ topic: "ruido", esConocido: true }] }),
      ],
      { minResenasCritico: 2 },
    );
    const ruido = r.temasCriticos.find((t) => t.topic === "ruido");
    expect(ruido).toBeDefined();
    expect(ruido?.pctNegativo).toBeGreaterThan(50);
  });

  it("NO marca como crítico un tema con una sola reseña negativa aislada (bajo el mínimo default de 2)", () => {
    const r = calcularIndiceReputacion([
      resena({ sentimientoEtiqueta: "muy_negativo", temas: [{ topic: "seguridad", esConocido: true }] }),
    ]);
    expect(r.temasCriticos.some((t) => t.topic === "seguridad")).toBe(false);
    // Sigue apareciendo en temasFrecuentes -- solo temasCriticos aplica el umbral.
    expect(r.temasFrecuentes.some((t) => t.topic === "seguridad")).toBe(true);
  });

  it("NO marca como crítico un tema con suficientes reseñas pero sentimiento mayoritariamente positivo", () => {
    const r = calcularIndiceReputacion([
      resena({ sentimientoEtiqueta: "positivo", temas: [{ topic: "desayuno", esConocido: true }] }),
      resena({ sentimientoEtiqueta: "positivo", temas: [{ topic: "desayuno", esConocido: true }] }),
      resena({ sentimientoEtiqueta: "negativo", temas: [{ topic: "desayuno", esConocido: true }] }),
    ]);
    expect(r.temasCriticos.some((t) => t.topic === "desayuno")).toBe(false);
  });

  it("respeta limiteTemasFrecuentes (0 = sin límite)", () => {
    const resenas = ["limpieza", "wifi", "ruido", "precio", "personal"].map((topic) =>
      resena({ temas: [{ topic: topic as ResenaClasificadaParaIndice["temas"][number]["topic"], esConocido: true }] }),
    );
    const limitado = calcularIndiceReputacion(resenas, { limiteTemasFrecuentes: 2 });
    expect(limitado.temasFrecuentes).toHaveLength(2);
    const sinLimite = calcularIndiceReputacion(resenas, { limiteTemasFrecuentes: 0 });
    expect(sinLimite.temasFrecuentes).toHaveLength(5);
  });

  it("preserva esConocido: false para un tema local en el agregado", () => {
    const r = calcularIndiceReputacion([
      resena({ sentimientoEtiqueta: "negativo", temas: [{ topic: "local:iguanas", esConocido: false }] }),
    ]);
    const local = r.temasFrecuentes.find((t) => t.topic === "local:iguanas");
    expect(local?.esConocido).toBe(false);
  });

  it("es determinista respecto al orden de entrada (mismo conjunto, distinto orden, mismo resultado)", () => {
    const a = resena({ sentimientoEtiqueta: "negativo", temas: [{ topic: "wifi", esConocido: true }] });
    const b = resena({ sentimientoEtiqueta: "positivo", temas: [{ topic: "limpieza", esConocido: true }] });
    const r1 = calcularIndiceReputacion([a, b]);
    const r2 = calcularIndiceReputacion([b, a]);
    expect(r1.temasFrecuentes.map((t) => t.topic)).toEqual(r2.temasFrecuentes.map((t) => t.topic));
    expect(r1.promedioSentimiento).toBe(r2.promedioSentimiento);
  });
});
