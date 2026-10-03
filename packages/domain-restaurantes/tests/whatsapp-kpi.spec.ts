import { describe, expect, it } from "vitest";
import { costoPorPedidoCentavos, porcentaje, resumirWhatsappKpi, whatsappDiaVacio } from "../src/index.ts";

describe("KPI de WhatsApp: cálculos puros", () => {
  it("porcentaje: un decimal y null sin base (nunca 0% inventado)", () => {
    expect(porcentaje(1, 3)).toBe(33.3);
    expect(porcentaje(2, 3)).toBe(66.7);
    expect(porcentaje(0, 5)).toBe(0);
    expect(porcentaje(0, 0)).toBeNull();
  });

  it("costo por pedido: centavos redondeados; null sin costo o sin pedidos", () => {
    expect(costoPorPedidoCentavos(1000, 4)).toBe(250);
    expect(costoPorPedidoCentavos(1000, 3)).toBe(333);
    expect(costoPorPedidoCentavos(1000, 0)).toBeNull();
    expect(costoPorPedidoCentavos(null, 3)).toBeNull();
    expect(costoPorPedidoCentavos(1000, null)).toBeNull();
  });

  it("resumen: suma el periodo y un día sin tipo de cambio vuelve el costo del periodo null (no subestima)", () => {
    const a = { ...whatsappDiaVacio("2026-03-09"), conversaciones: 2, conversacionesConPedido: 1, pedidosOrg: 1, costoLlmOrgCentavosMxn: 100, costoLlmOrgMicroUsd: 5000 };
    const b = { ...whatsappDiaVacio("2026-03-10"), conversaciones: 2, conversacionesConPedido: 1, pedidosOrg: 1, costoLlmOrgCentavosMxn: 300, costoLlmOrgMicroUsd: 15000 };
    expect(resumirWhatsappKpi([a, b])).toMatchObject({ conversaciones: 4, conversionPct: 50, costoLlmOrgCentavosMxn: 400, costoLlmPorPedidoCentavosMxn: 200 });
    const sinFx = resumirWhatsappKpi([a, { ...b, costoLlmOrgCentavosMxn: null }]);
    expect(sinFx).toMatchObject({ costoLlmOrgCentavosMxn: null, costoLlmPorPedidoCentavosMxn: null, costoLlmOrgMicroUsd: 20000 });
  });

  it("resumen vacío: todo null salvo los conteos", () => {
    expect(resumirWhatsappKpi([])).toMatchObject({ dias: 0, conversaciones: 0, conversionPct: null, pedidosOrg: null, costoLlmOrgMicroUsd: null, costoLlmPorPedidoCentavosMxn: null });
  });
});
