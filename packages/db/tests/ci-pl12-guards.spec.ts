// PL-12 (CI ampliado): logica pura de los guards nuevos de CI. Sin red, sin Postgres, sin procesos externos.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPECS_SENSIBLES_AL_RELOJ } from "../../../vitest.clock-guard.config.ts";
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

describe("clock-guard (seleccion de specs sensibles al reloj)", () => {
  const raiz = new URL("../../../", import.meta.url);

  it("cada spec listada existe (un rename no deja el guard corriendo en vacio)", () => {
    const faltan = SPECS_SENSIBLES_AL_RELOJ.filter((ruta) => !existsSync(new URL(ruta, raiz)));
    expect(faltan).toEqual([]);
  });

  it("no hay duplicados y cubre los casos que motivaron el guard (rentas-pricing, hoteles night-audit, fin de mes)", () => {
    expect(new Set(SPECS_SENSIBLES_AL_RELOJ).size).toBe(SPECS_SENSIBLES_AL_RELOJ.length);
    const texto = SPECS_SENSIBLES_AL_RELOJ.join("\n");
    for (const requerida of ["rentas-pricing-servidor-hoy", "hoteles-night-audit-servidor-hoy", "reloj-simulado-fronteras", "despachos-cierre-mensual-servidor-hoy"]) {
      expect(texto).toContain(requerida);
    }
  });
});
