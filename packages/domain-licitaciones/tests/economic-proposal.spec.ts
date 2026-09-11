// Flujo 2 — REQ-LIC-006/A8: un concepto sin tarifa aprobada/vigente bloquea
// el TOTAL COMPLETO, nunca un total parcial silencioso. Este es el
// equivalente de licitaciones al "guardia anti-alucinación de precio" de
// hoteles/quote.ts.
import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.ts";
import type { ApprovedRate } from "../src/company-data.ts";
import { EconomicProposalBuilder, assertValidIvaRate } from "../src/economic-proposal.ts";

const AS_OF = "2026-06-01T00:00:00-06:00";

function buildService(rates: ApprovedRate[]): CompanyDataService {
  return new CompanyDataService(new InMemoryCompanyDataResolver({ rates }));
}

const APPROVED_RATE: ApprovedRate = {
  id: "r1",
  companyId: "org1",
  concept: "consultoria_hora",
  unit: "hora",
  unitPrice: "500.00",
  currency: "MXN",
  approvalStatus: "aprobado",
  validFrom: "2026-01-01T00:00:00-06:00",
  validUntil: null,
};

describe("EconomicProposalBuilder -- regla dura A8 (bloqueo total, nunca parcial)", () => {
  it("calcula totales correctos cuando todos los conceptos resuelven a tarifa aprobada y vigente", () => {
    const builder = new EconomicProposalBuilder(buildService([APPROVED_RATE]), { ivaRate: 0.16 });
    const result = builder.build("org1", [{ concept: "consultoria_hora", quantity: 10 }], AS_OF);
    expect(result.blockedLineItems).toHaveLength(0);
    expect(result.totals).not.toBeNull();
    expect(result.totals!.subtotal).toBe("5000.00");
    expect(result.totals!.iva).toBe("800.00");
    expect(result.totals!.total).toBe("5800.00");
    expect(result.cartaText).toContain("5800.00");
    expect(result.anexoText).toContain("Total: $5800.00");
  });

  it("un solo concepto sin tarifa registrada bloquea el TOTAL COMPLETO -- nunca un total parcial de los demás conceptos resueltos", () => {
    const builder = new EconomicProposalBuilder(buildService([APPROVED_RATE]), { ivaRate: 0.16 });
    const result = builder.build(
      "org1",
      [
        { concept: "consultoria_hora", quantity: 10 }, // sí tiene tarifa
        { concept: "concepto_inexistente", quantity: 1 }, // no tiene tarifa
      ],
      AS_OF,
    );
    expect(result.totals).toBeNull();
    expect(result.cartaText).toBeNull();
    expect(result.anexoText).toBeNull();
    expect(result.lineItems).toHaveLength(1); // el resuelto sí queda registrado...
    expect(result.blockedLineItems).toEqual([{ concept: "concepto_inexistente", status: "missing", detail: 'No hay tarifa registrada para "concepto_inexistente".' }]);
  });

  it("una tarifa vencida a la fecha del acto bloquea el concepto (nunca 'revive' una tarifa vieja)", () => {
    const expired: ApprovedRate = { ...APPROVED_RATE, validUntil: "2026-01-31T23:59:59-06:00" };
    const builder = new EconomicProposalBuilder(buildService([expired]), { ivaRate: 0.16 });
    const result = builder.build("org1", [{ concept: "consultoria_hora", quantity: 1 }], AS_OF);
    expect(result.totals).toBeNull();
    expect(result.blockedLineItems[0]!.detail).toMatch(/venció/);
  });

  it("una tarifa aún no aprobada bloquea el concepto", () => {
    const pending: ApprovedRate = { ...APPROVED_RATE, approvalStatus: "pendiente_aprobacion" };
    const builder = new EconomicProposalBuilder(buildService([pending]), { ivaRate: 0.16 });
    const result = builder.build("org1", [{ concept: "consultoria_hora", quantity: 1 }], AS_OF);
    expect(result.totals).toBeNull();
    expect(result.blockedLineItems[0]!.detail).toMatch(/no "aprobado"/);
  });

  it("una lista de conceptos vacía nunca produce un total (evita un 'total de $0' engañoso)", () => {
    const builder = new EconomicProposalBuilder(buildService([APPROVED_RATE]), { ivaRate: 0.16 });
    const result = builder.build("org1", [], AS_OF);
    expect(result.totals).toBeNull();
  });
});

describe("assertValidIvaRate -- REQ-LIC-007 (cota anti error de unidades)", () => {
  it("acepta tasas razonables", () => {
    expect(() => assertValidIvaRate(0.16)).not.toThrow();
    expect(() => assertValidIvaRate(0)).not.toThrow();
  });

  it("rechaza un error de unidades clásico (16 en vez de 0.16)", () => {
    expect(() => assertValidIvaRate(16)).toThrow(/fuera de rango válido/);
  });

  it("rechaza una tasa negativa", () => {
    expect(() => assertValidIvaRate(-0.1)).toThrow();
  });

  it("el constructor de EconomicProposalBuilder valida ivaRate de inmediato (fail-fast)", () => {
    expect(() => new EconomicProposalBuilder(buildService([]), { ivaRate: 16 })).toThrow();
  });
});
