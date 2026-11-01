// Revision independiente de #713 (REVISION-SEGURIDAD-PARIDAD-OPERACION.md, seccion Operacion): p1-2-sin-filtrado-de-resenas.
import { describe, expect, it } from "vitest";
import { textosTrasCalificar } from "../src/ciclo-pedido/reglas.ts";

describe("P1-2: sin filtrado de resenas por calificacion", () => {
  it("ninguna calificacion recibe un enlace de resena ni se menciona Google", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const t = textosTrasCalificar(n, "Centro");
      expect(t.cliente.toLowerCase()).not.toContain("google");
      expect(t.cliente).not.toContain("http");
      expect(t.cliente.toLowerCase()).not.toContain("reseña");
    }
  });
  it("1 a 3 abre seguimiento interno; 4 y 5 no", () => {
    expect([1, 2, 3, 4, 5].map((n) => textosTrasCalificar(n, "Centro").esBaja)).toEqual([true, true, true, false, false]);
  });
});

