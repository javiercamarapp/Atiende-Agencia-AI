import { describe, expect, it } from "vitest";
import {
  computeChargeAmounts,
  computeNoShowPenaltyAmounts,
  evaluateNoShowPenaltyBase,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
  assertRoomChargeIdentityVerified,
  ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY,
} from "../src/folioEngine.ts";

const TAX_CONFIG = { ivaRate: 0.16, ishRate: 0.03 };

describe("computeChargeAmounts", () => {
  it("hospedaje lleva IVA + ISH", () => {
    const result = computeChargeAmounts({ concept: "hospedaje", netAmount: 1000, taxConfig: TAX_CONFIG });
    expect(result.netAmount).toBe(1000);
    expect(result.taxAmount).toBe(190); // 160 IVA + 30 ISH
    expect(result.totalAmount).toBe(1190);
  });

  it("ab (alimentos y bebidas) lleva IVA pero NUNCA ISH", () => {
    const result = computeChargeAmounts({ concept: "ab", netAmount: 500, taxConfig: TAX_CONFIG });
    expect(result.taxAmount).toBe(80); // solo IVA
  });

  it("propina/descuento/reverso quedan SIN impuesto sin importar taxConfig", () => {
    expect(computeChargeAmounts({ concept: "propina", netAmount: 100, taxConfig: TAX_CONFIG }).taxAmount).toBe(0);
  });

  it("rechaza netAmount negativo para un cargo real", () => {
    expect(() => computeChargeAmounts({ concept: "hospedaje", netAmount: -1, taxConfig: TAX_CONFIG })).toThrow(RangeError);
  });
});

// Diseño Fase 3 §3.4 (resuelto opción 1): la penalización de no-show grava IVA pero
// EXCLUYE ISH SIEMPRE, a diferencia de un cargo real de concept='hospedaje' que
// `computeChargeAmounts` sí grava con ambos — son funciones DISTINTAS a propósito.
describe("computeNoShowPenaltyAmounts", () => {
  it("grava IVA pero NUNCA ISH, sin importar taxConfig.ishRate", () => {
    const result = computeNoShowPenaltyAmounts({ netAmount: 1000, taxConfig: TAX_CONFIG });
    expect(result.netAmount).toBe(1000);
    expect(result.taxAmount).toBe(160); // solo 16% IVA, cero ISH
    expect(result.totalAmount).toBe(1160);
  });

  it("difiere de computeChargeAmounts({concept:'hospedaje'}) exactamente en el ISH", () => {
    const noShow = computeNoShowPenaltyAmounts({ netAmount: 1000, taxConfig: TAX_CONFIG });
    const hospedajeReal = computeChargeAmounts({ concept: "hospedaje", netAmount: 1000, taxConfig: TAX_CONFIG });
    expect(hospedajeReal.taxAmount - noShow.taxAmount).toBe(30); // el 3% de ISH que el no-show nunca cobra
  });

  it("rechaza netAmount negativo", () => {
    expect(() => computeNoShowPenaltyAmounts({ netAmount: -1, taxConfig: TAX_CONFIG })).toThrow(RangeError);
  });
});

describe("evaluateNoShowPenaltyBase", () => {
  it("calcula el promedio por noche del total de la reserva", () => {
    expect(evaluateNoShowPenaltyBase({ totalAmount: 3000, checkInDate: "2026-12-01", checkOutDate: "2026-12-04" })).toBe(1000);
  });

  it("una reserva de 1 noche penaliza el total completo", () => {
    expect(evaluateNoShowPenaltyBase({ totalAmount: 1500, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" })).toBe(1500);
  });

  it("rechaza un rango de 0 noches", () => {
    expect(() => evaluateNoShowPenaltyBase({ totalAmount: 1000, checkInDate: "2026-12-01", checkOutDate: "2026-12-01" })).toThrow(RangeError);
  });
});

describe("evaluateDiscountAuthorization", () => {
  it("permite cualquier descuento bajo el umbral, sin importar el rol", () => {
    expect(evaluateDiscountAuthorization({ amount: 100, thresholdAmount: 500, actorHasAdminRole: false }).allowed).toBe(true);
  });

  it("un rol no-admin sin autorización NO puede aplicar un descuento sobre el umbral", () => {
    const result = evaluateDiscountAuthorization({ amount: 800, thresholdAmount: 500, actorHasAdminRole: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/umbral/);
  });

  it("un admin (owner/gm) puede aplicar cualquier descuento", () => {
    expect(evaluateDiscountAuthorization({ amount: 800, thresholdAmount: 500, actorHasAdminRole: true }).allowed).toBe(true);
  });

  it("una autorización de un admin verificado permite el descuento sobre el umbral", () => {
    expect(
      evaluateDiscountAuthorization({ amount: 800, thresholdAmount: 500, actorHasAdminRole: false, authorizedByAdminUserId: "admin-1" }).allowed,
    ).toBe(true);
  });
});

describe("assertRoomChargeIdentityVerified (REQ-AB-012, anti-fraude 'cárguelo al 304')", () => {
  it("un concepto fuera del set (hospedaje) nunca requiere verificación", () => {
    expect(ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY.has("hospedaje")).toBe(false);
    expect(assertRoomChargeIdentityVerified({ concept: "hospedaje", claim: null, guestLastName: null, guestPhoneLast4: null, actorHasAdminRole: false }).allowed).toBe(true);
  });

  it("apellido+teléfono coincidentes autorizan el cargo", () => {
    const result = assertRoomChargeIdentityVerified({
      concept: "ab",
      claim: { declaredLastName: "García", declaredPhoneLast4: "1234" },
      guestLastName: "garcia",
      guestPhoneLast4: "1234",
      actorHasAdminRole: false,
    });
    expect(result.allowed).toBe(true);
  });

  it("una discrepancia activa (apellido no coincide) NUNCA es overridable, ni por un admin", () => {
    const result = assertRoomChargeIdentityVerified({
      concept: "ab",
      claim: { declaredLastName: "Pérez", declaredPhoneLast4: "1234" },
      guestLastName: "García",
      guestPhoneLast4: "1234",
      actorHasAdminRole: true,
      authorizedByAdminUserId: "admin-1",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/discrepancia/);
  });

  it("sin reclamo y sin huésped identificado, un admin SÍ puede autorizar la excepción", () => {
    const result = assertRoomChargeIdentityVerified({
      concept: "extras",
      claim: null,
      guestLastName: null,
      guestPhoneLast4: null,
      actorHasAdminRole: true,
    });
    expect(result.allowed).toBe(true);
  });

  it("sin reclamo y sin autorización administrativa, el cargo se rechaza (fail-closed)", () => {
    const result = assertRoomChargeIdentityVerified({
      concept: "otro",
      claim: null,
      guestLastName: "García",
      guestPhoneLast4: "1234",
      actorHasAdminRole: false,
    });
    expect(result.allowed).toBe(false);
  });

  it("el control se aplica por concepto 'otro' (evade-por-omisión) igual que 'ab'/'extras' -- lección de los 2 intentos fallidos", () => {
    for (const concept of ["ab", "extras", "otro"] as const) {
      expect(ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY.has(concept)).toBe(true);
    }
  });
});

describe("evaluateFolioClose", () => {
  it("saldo_cero solo se permite con saldo realmente cero (con tolerancia de 1 centavo)", () => {
    expect(evaluateFolioClose({ balance: 0, reason: "saldo_cero", actorHasAdminRole: false }).allowed).toBe(true);
    expect(evaluateFolioClose({ balance: 0.005, reason: "saldo_cero", actorHasAdminRole: false }).allowed).toBe(true);
    expect(evaluateFolioClose({ balance: 50, reason: "saldo_cero", actorHasAdminRole: false }).allowed).toBe(false);
  });

  it("cuenta_por_cobrar con saldo pendiente exige rol administrativo", () => {
    expect(evaluateFolioClose({ balance: 50, reason: "cuenta_por_cobrar", actorHasAdminRole: false }).allowed).toBe(false);
    expect(evaluateFolioClose({ balance: 50, reason: "cuenta_por_cobrar", actorHasAdminRole: true }).allowed).toBe(true);
  });

  it("cuenta_por_cobrar con saldo ya en cero se rechaza (usa saldo_cero en su lugar)", () => {
    expect(evaluateFolioClose({ balance: 0, reason: "cuenta_por_cobrar", actorHasAdminRole: true }).allowed).toBe(false);
  });
});
