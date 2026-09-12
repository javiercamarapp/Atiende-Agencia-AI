// Fase 5 (H16-014/REQ-REC-014) — pruebas unitarias de los 2 patrones de fraude
// interno portados (descuento fuera de política, folio reabierto post-auditoría).
// Ver domain-hoteles/src/fraude/deteccion.ts para por qué son SOLO 2 de los 4 del
// original (los otros 2 requieren un conector PMS/POS, fuera de alcance).
import { describe, expect, it } from "vitest";
import { detectDiscountOutsidePolicy, detectFolioReopenedAfterAudit, recipientRolesForPattern } from "../src/fraude/deteccion.ts";

describe("detectDiscountOutsidePolicy", () => {
  it("no marca un descuento por debajo del umbral", () => {
    const finding = detectDiscountOutsidePolicy({
      chargeId: "c1",
      folioId: "f1",
      discountAmount: -100,
      thresholdAmount: 500,
      discountAuthorizedByStaffId: null,
      appliedByHasAdminRole: false,
    });
    expect(finding).toBeNull();
  });

  it("no marca un descuento grande aplicado por un rol administrativo directo", () => {
    const finding = detectDiscountOutsidePolicy({
      chargeId: "c1",
      folioId: "f1",
      discountAmount: -1000,
      thresholdAmount: 500,
      discountAuthorizedByStaffId: null,
      appliedByHasAdminRole: true,
    });
    expect(finding).toBeNull();
  });

  it("no marca un descuento grande con discountAuthorizedBy verificado", () => {
    const finding = detectDiscountOutsidePolicy({
      chargeId: "c1",
      folioId: "f1",
      discountAmount: -1000,
      thresholdAmount: 500,
      discountAuthorizedByStaffId: "admin-1",
      appliedByHasAdminRole: false,
    });
    expect(finding).toBeNull();
  });

  it("marca un descuento grande SIN autorización ni rol administrativo (bypass del camino feliz)", () => {
    const finding = detectDiscountOutsidePolicy({
      chargeId: "c1",
      folioId: "f1",
      discountAmount: -1000,
      thresholdAmount: 500,
      discountAuthorizedByStaffId: null,
      appliedByHasAdminRole: false,
    });
    expect(finding).not.toBeNull();
    expect(finding!.pattern).toBe("descuento_fuera_de_politica");
    expect(finding!.dedupeKey).toBe("descuento_fuera_de_politica:c1");
    expect(finding!.evidence).toEqual({ discountAmount: 1000, thresholdAmount: 500 });
  });

  it("evalúa por MAGNITUD, no por signo (un monto positivo de descuento también se marca)", () => {
    const finding = detectDiscountOutsidePolicy({
      chargeId: "c2",
      folioId: "f1",
      discountAmount: 1000,
      thresholdAmount: 500,
      discountAuthorizedByStaffId: null,
      appliedByHasAdminRole: false,
    });
    expect(finding).not.toBeNull();
  });

  it("respeta la tolerancia de redondeo de un centavo en el umbral", () => {
    const dentroDeTolerancia = detectDiscountOutsidePolicy({
      chargeId: "c3",
      folioId: "f1",
      discountAmount: -500.01,
      thresholdAmount: 500,
      discountAuthorizedByStaffId: null,
      appliedByHasAdminRole: false,
    });
    expect(dentroDeTolerancia).toBeNull();

    const fueraDeTolerancia = detectDiscountOutsidePolicy({
      chargeId: "c4",
      folioId: "f1",
      discountAmount: -500.02,
      thresholdAmount: 500,
      discountAuthorizedByStaffId: null,
      appliedByHasAdminRole: false,
    });
    expect(fueraDeTolerancia).not.toBeNull();
  });
});

describe("detectFolioReopenedAfterAudit", () => {
  it("no marca un cargo creado ANTES del cierre del folio", () => {
    const finding = detectFolioReopenedAfterAudit({
      folioId: "f1",
      folioClosedAt: "2026-01-10T10:00:00.000Z",
      chargeId: "c1",
      chargeCreatedAt: "2026-01-10T09:00:00.000Z",
    });
    expect(finding).toBeNull();
  });

  it("marca un cargo creado DESPUÉS del cierre del folio (reapertura fuera de flujo)", () => {
    const finding = detectFolioReopenedAfterAudit({
      folioId: "f1",
      folioClosedAt: "2026-01-10T10:00:00.000Z",
      chargeId: "c1",
      chargeCreatedAt: "2026-01-10T11:00:00.000Z",
    });
    expect(finding).not.toBeNull();
    expect(finding!.pattern).toBe("folio_reabierto_post_auditoria");
    expect(finding!.dedupeKey).toBe("folio_reabierto_post_auditoria:c1");
  });

  it("es determinista/puro: NO depende de un night-audit -- solo de folio.closedAt/charge.createdAt", () => {
    // Un folio cerrado manualmente vía POST .../folios/:folioId/cerrar (Fase 1, sin
    // ningún night-audit) dispara la misma detección que uno cerrado por un futuro
    // job de cierre en lote -- la función no distingue el ORIGEN del cierre.
    const finding = detectFolioReopenedAfterAudit({
      folioId: "f2",
      folioClosedAt: "2026-02-01T00:00:00.000Z",
      chargeId: "c9",
      chargeCreatedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(finding).not.toBeNull();
  });
});

describe("recipientRolesForPattern", () => {
  it("descuento_fuera_de_politica -> owner/gm", () => {
    expect(recipientRolesForPattern("descuento_fuera_de_politica")).toEqual(["owner", "gm"]);
  });

  it("folio_reabierto_post_auditoria -> owner/gm/accountant", () => {
    expect(recipientRolesForPattern("folio_reabierto_post_auditoria")).toEqual(["owner", "gm", "accountant"]);
  });
});
