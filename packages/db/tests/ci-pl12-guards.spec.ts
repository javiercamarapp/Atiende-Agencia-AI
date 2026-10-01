// PL-12 (CI ampliado): logica pura de los guards nuevos de CI. Sin red, sin Postgres, sin procesos externos.
import { describe, expect, it } from "vitest";
import { contarResultadosEslint, evaluarRatchet } from "../../../scripts/lint-ratchet/ratchet.ts";

describe("lint-ratchet", () => {
  it("cuenta errores, advertencias y reglas del JSON de ESLint", () => {
    const conteo = contarResultadosEslint([
      { errorCount: 0, warningCount: 2, messages: [{ ruleId: "a" }, { ruleId: "a" }] },
      { errorCount: 1, warningCount: 1, messages: [{ ruleId: null }, { ruleId: "b" }] },
    ]);
    expect(conteo.errores).toBe(1);
    expect(conteo.advertencias).toBe(3);
    expect(conteo.porRegla).toEqual({ a: 2, "(sin regla)": 1, b: 1 });
  });

  it("falla si las advertencias SUBEN por encima del baseline", () => {
    const v = evaluarRatchet({ errores: 0, advertencias: 3 }, 2);
    expect(v.ok).toBe(false);
    expect(v.mensaje).toContain("+1");
  });

  it("pasa en igualdad y pasa pidiendo bajar el baseline cuando hay menos", () => {
    expect(evaluarRatchet({ errores: 0, advertencias: 2 }, 2)).toMatchObject({ ok: true, puedeBajarBaseline: false });
    expect(evaluarRatchet({ errores: 0, advertencias: 1 }, 2)).toMatchObject({ ok: true, puedeBajarBaseline: true });
  });

  it("falla con cualquier error de ESLint aunque las advertencias esten bajo el baseline", () => {
    expect(evaluarRatchet({ errores: 1, advertencias: 0 }, 5).ok).toBe(false);
  });

  it("rechaza un baseline invalido (negativo o no entero) en vez de aceptar todo", () => {
    expect(evaluarRatchet({ errores: 0, advertencias: 0 }, -1).ok).toBe(false);
    expect(evaluarRatchet({ errores: 0, advertencias: 0 }, 1.5).ok).toBe(false);
    expect(evaluarRatchet({ errores: 0, advertencias: 0 }, Number.NaN).ok).toBe(false);
  });
});
