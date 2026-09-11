import { describe, expect, it } from "vitest";
import {
  resolveAllergyDeclared,
  canAssureDishIsSafe,
  assertCanAssureDishIsSafe,
  describeSafetyAssuranceMessage,
  AllergySafetyAssuranceBlockedError,
} from "../src/fnbAllergyGuard.ts";

describe("resolveAllergyDeclared (REQ-AB-004)", () => {
  it("campo estructurado en true siempre gana", () => {
    expect(resolveAllergyDeclared({ structuredFlag: true, freeTextFields: [] })).toEqual({ allergyDeclared: true, declaredVia: "estructurado" });
  });

  it("detecta una alergia declarada en texto libre aunque el campo estructurado sea false", () => {
    const result = resolveAllergyDeclared({ structuredFlag: false, freeTextFields: ["soy alérgico a los mariscos"] });
    expect(result).toEqual({ allergyDeclared: true, declaredVia: "texto_libre" });
  });

  it("reconoce variantes sin acento (alergico/celiaco)", () => {
    expect(resolveAllergyDeclared({ structuredFlag: false, freeTextFields: ["soy alergico"] }).declaredVia).toBe("texto_libre");
    expect(resolveAllergyDeclared({ structuredFlag: false, freeTextFields: ["soy celiaco"] }).declaredVia).toBe("texto_libre");
  });

  it("red de seguridad fail-closed: una nota libre que NO calza con el regex igual se trata como declarada (mitigación de bypass)", () => {
    const result = resolveAllergyDeclared({ structuredFlag: false, freeTextFields: ["no tolero los mariscos, me hace mal comerlos"] });
    expect(result.allergyDeclared).toBe(true);
    expect(result.declaredVia).toBe("texto_libre_no_reconocido");
  });

  it("sin campo estructurado y sin ninguna nota, no se declara alergia", () => {
    expect(resolveAllergyDeclared({ structuredFlag: false, freeTextFields: [null, undefined, ""] })).toEqual({ allergyDeclared: false, declaredVia: null });
  });
});

describe("canAssureDishIsSafe / assertCanAssureDishIsSafe", () => {
  it("sin alergia declarada siempre es seguro afirmar", () => {
    expect(canAssureDishIsSafe({ allergyDeclared: false, kitchenConfirmedBy: null })).toBe(true);
    expect(() => assertCanAssureDishIsSafe({ allergyDeclared: false, kitchenConfirmedBy: null })).not.toThrow();
  });

  it("con alergia declarada y SIN confirmación de cocina, nunca es seguro afirmar", () => {
    expect(canAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: null })).toBe(false);
    expect(() => assertCanAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: null })).toThrow(AllergySafetyAssuranceBlockedError);
  });

  it("con alergia declarada y confirmación de cocina, es seguro afirmar", () => {
    expect(canAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: "cocinero-1" })).toBe(true);
    expect(() => assertCanAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: "cocinero-1" })).not.toThrow();
  });
});

describe("describeSafetyAssuranceMessage", () => {
  it("nunca afirma seguridad mientras esté pendiente de confirmación", () => {
    const message = describeSafetyAssuranceMessage({ allergyDeclared: true, kitchenConfirmedBy: null });
    expect(message).not.toMatch(/es seguro/);
  });

  it("afirma seguridad solo tras confirmación", () => {
    const message = describeSafetyAssuranceMessage({ allergyDeclared: true, kitchenConfirmedBy: "cocinero-1" });
    expect(message).toMatch(/es seguro/);
  });
});
