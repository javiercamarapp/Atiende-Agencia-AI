// La regla confirmar -> crear que el worker pasa a la cascada v2 de PM: incluye la escalacion (no escala con el pedido confirmado sin crear) y el clasificador de
// frases de registro de restaurantes (no se dice «quedó registrado» antes de que crear_pedido tenga exito). E2E LiveKit del 6/7-nov-2026.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIRMACION_VOZ_PM, OMITIR_ACUSE_VOZ_PM } from "../src/llamada.ts";

describe("CONFIRMACION_VOZ_PM", () => {
  it("nombra las herramientas de restaurantes, la escalacion y el clasificador de registro", () => {
    expect(CONFIRMACION_VOZ_PM).toMatchObject({ confirmar: "confirmar_resumen", crear: "crear_pedido", cotizar: "cotizar_pedido", escalar: "escalar_a_humano" });
    expect(CONFIRMACION_VOZ_PM.afirmaRegistro("Listo, su pedido quedó registrado.")).toBe(true);
    expect(CONFIRMACION_VOZ_PM.afirmaRegistro("¿Le registro su pedido?")).toBe(false);
  });

  it("main.ts usa esa regla (no una copia sin escalacion ni clasificador)", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("confirmacionAntesDeCrear: CONFIRMACION_VOZ_PM");
  });
});

describe("OMITIR_ACUSE_VOZ_PM (revision #752 P1-2)", () => {
  it("sin acuse cuando la guardia de voz de PM ve riesgo o que piden una persona; con acuse en un pedido normal", () => {
    expect(OMITIR_ACUSE_VOZ_PM("soy alérgico al cacahuate")).toBe(true);
    expect(OMITIR_ACUSE_VOZ_PM("quiero hablar con una persona")).toBe(true);
    expect(OMITIR_ACUSE_VOZ_PM("quiero tres tacos de pastor")).toBe(false);
  });

  it("main.ts lo conecta a la escalera", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("omitirAcuse: OMITIR_ACUSE_VOZ_PM");
  });
});
