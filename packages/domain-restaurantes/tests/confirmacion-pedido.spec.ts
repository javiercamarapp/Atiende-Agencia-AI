// Texto de confirmacion de un pedido creado: solo datos del servidor, sin inventar. Contrato de entradas invalidas y reloj fijo (zona explicita, sin tocar la zona del proceso).
import { describe, expect, it } from "vitest";
import { confirmacionDePedido } from "../src/whatsapp/confirmacion-pedido.ts";

const zona = { timezone: "America/Merida" };
const real = { id: "6f1c1c8a-0000-4000-8000-000000000001", orderNumber: 4521, branch: "Francisco de Montejo", total: 126, status: "pending", paymentMethod: "efectivo", items: [{ id: "p1", name: "Taco Al Pastor", price: 42, quantity: 3 }] };
const simulado = { id: "PRUEBA-0ADC", branch: "Demo Centro", total: 126, status: "simulado", payment_method: "efectivo", items: [{ id: "p1", name: "Taco Al Pastor", price: 42, quantity: 3 }], simulado: true };

describe("confirmacionDePedido", () => {
  it("pedido real: folio, renglones, total, pago y sucursal; sin hora inventada", () => {
    const t = confirmacionDePedido(real, zona)!;
    expect(t).toContain("*Folio:* #4521");
    expect(t).toContain("3 × Taco Al Pastor");
    expect(t).toContain("*Total:* $126");
    expect(t).toContain("*Pago:* efectivo");
    expect(t).toContain("*Sucursal:* Francisco de Montejo");
    expect(t).toContain("se mandó a cocina");
    expect(t).not.toMatch(/Recoger a las|Programado/);
    expect(t).not.toMatch(/\*\*/);
  });

  it("pedido real sin orderNumber: no muestra el uuid como folio", () => {
    const { orderNumber: _o, ...sinFolio } = real;
    const t = confirmacionDePedido(sinFolio, zona)!;
    expect(t).not.toContain("Folio");
    expect(t).not.toContain(real.id);
  });

  it("pedido simulado: folio PRUEBA y leyenda de simulacion (no afirma cocina)", () => {
    const t = confirmacionDePedido(simulado, zona)!;
    expect(t).toContain("*Folio:* PRUEBA-0ADC");
    expect(t).toContain("*Total:* $126");
    expect(t).toMatch(/simulaci[óo]n/);
    expect(t).not.toMatch(/registrado y se mandó a cocina/);
  });

  it("hora de recogida del servidor en la zona de la sucursal (13:30 en Merida = 19:30Z)", () => {
    const t = confirmacionDePedido({ ...real, horaRecogida: "2026-10-06T19:30:00.000Z" }, zona)!;
    expect(t).toMatch(/\*Recoger a las:\* .*13:30/);
  });

  it("pedido programado: usa la fecha programada y no la de recogida", () => {
    const t = confirmacionDePedido({ ...real, status: "programado", programadoPara: "2026-10-07T01:00:00.000Z", horaRecogida: "2026-10-06T19:30:00.000Z" }, zona)!;
    expect(t).toMatch(/\*Programado para:\* .*19:00/);
    expect(t).not.toContain("Recoger a las");
    expect(t).not.toContain("se mandó a cocina");
  });

  it("total con centavos y total en cero", () => {
    expect(confirmacionDePedido({ ...real, total: 126.5 }, zona)).toContain("*Total:* $126.50");
    expect(confirmacionDePedido({ ...real, total: 0 }, zona)).toContain("*Total:* $0");
  });

  it("hora invalida o zona invalida: se omite la linea, no truena", () => {
    expect(confirmacionDePedido({ ...real, horaRecogida: "no-es-fecha" }, zona)).not.toContain("Recoger");
    expect(confirmacionDePedido({ ...real, horaRecogida: "2026-10-06T19:30:00.000Z" }, { timezone: "Marte/Olimpo" })).not.toContain("Recoger");
  });

  it.each([0, "", null, undefined, false, true, [], {}, "pedido", 42, [real]])("entrada invalida %j -> null", (entrada) => {
    expect(confirmacionDePedido(entrada, zona)).toBeNull();
  });

  it.each([
    ["sin id", { ...real, id: "" }],
    ["id no textual", { ...real, id: 0 }],
    ["sin total", { ...real, total: undefined }],
    ["total NaN", { ...real, total: Number.NaN }],
    ["total negativo", { ...real, total: -1 }],
    ["total textual", { ...real, total: "126" }],
    ["sin renglones", { ...real, items: [] }],
    ["renglones no arreglo", { ...real, items: {} }],
    ["renglones invalidos", { ...real, items: [null, 0, "", { name: "", quantity: 1 }, { name: "X", quantity: 0 }] }],
  ])("pedido incompleto (%s) -> null: el llamador conserva su respaldo", (_n, entrada) => {
    expect(confirmacionDePedido(entrada, zona)).toBeNull();
  });

  it("renglon de cortesia (2x1 / D12): se marca como cortesia y no se confunde con uno pagado", () => {
    const t = confirmacionDePedido({ ...real, total: 42, items: [{ id: "p1", name: "Taco Al Pastor", price: 42, quantity: 1 }, { id: "p1", name: "Taco Al Pastor", price: 0, listPrice: 42, quantity: 1, courtesy: true }] }, zona)!;
    expect(t).toContain("1 × Taco Al Pastor\n1 × Taco Al Pastor (cortesía)");
    expect(t).toContain("*Total:* $42");
  });

  it("propina: se muestra aparte del total (Order.total no la incluye); sin propina o en cero no hay linea", () => {
    expect(confirmacionDePedido({ ...real, paymentMethod: "tarjeta", propina: 12.6 }, zona)).toContain("*Propina:* $12.60 (aparte del total)");
    expect(confirmacionDePedido({ ...real, propina: 0 }, zona)).not.toContain("Propina");
    expect(confirmacionDePedido({ ...real, propina: null }, zona)).not.toContain("Propina");
    expect(confirmacionDePedido({ ...real, propina: "10" }, zona)).not.toContain("Propina");
  });

  it.each([
    ["status por_aprobar", { status: "por_aprobar" }],
    ["estado por_confirmar_por_la_sucursal", { estado: "por_confirmar_por_la_sucursal" }],
    ["pedido_grande", { pedido_grande: true }],
    ["por_aprobar", { por_aprobar: true }],
    ["pedido_retenido", { pedido_retenido: true }],
  ])("pedido retenido (%s) -> null: jamas se confirma como registrado", (_n, extra) => {
    expect(confirmacionDePedido({ ...real, ...extra }, zona)).toBeNull();
  });
});
