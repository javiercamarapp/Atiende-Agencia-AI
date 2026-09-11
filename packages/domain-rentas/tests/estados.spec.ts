import { describe, expect, it } from "vitest";
import { puedeTransicionar, transicionar } from "../src/estados.ts";

describe("puedeTransicionar", () => {
  it("provisional -> confirmado permitido", () => {
    expect(puedeTransicionar("provisional", "confirmado")).toBe(true);
  });
  it("provisional -> cancelado permitido", () => {
    expect(puedeTransicionar("provisional", "cancelado")).toBe(true);
  });
  it("confirmado -> conflicto_pendiente permitido", () => {
    expect(puedeTransicionar("confirmado", "conflicto_pendiente")).toBe(true);
  });
  it("cancelado es terminal: no admite ninguna transición saliente", () => {
    expect(puedeTransicionar("cancelado", "confirmado")).toBe(false);
    expect(puedeTransicionar("cancelado", "provisional")).toBe(false);
    expect(puedeTransicionar("cancelado", "conflicto_pendiente")).toBe(false);
  });
  it("una transición a sí mismo nunca se permite", () => {
    expect(puedeTransicionar("confirmado", "confirmado")).toBe(false);
  });
  it("confirmado -> provisional (retroceder) no está permitido", () => {
    expect(puedeTransicionar("confirmado", "provisional")).toBe(false);
  });
});

describe("transicionar", () => {
  it("devuelve el nuevo estado cuando la transición es válida", () => {
    expect(transicionar("provisional", "confirmado")).toBe("confirmado");
  });
  it("lanza cuando la transición no está permitida", () => {
    expect(() => transicionar("cancelado", "confirmado")).toThrow(/no permitida/);
  });
});
