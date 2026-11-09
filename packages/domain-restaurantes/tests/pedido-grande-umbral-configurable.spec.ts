// Umbral de pedido grande «sin historial y en efectivo» (decisión del dueño pendiente, C4 PED-11: $2,500 del servidor vs $4,000 del banco). NO se cambia el
// valor: queda en $2,500 por omisión y se vuelve configurable con PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN (entero 500-20000; otro valor = 2500).
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluarPedidoGrande, umbralSinHistorialEfectivoMxn } from "../src/pedido-grande.ts";

const caso = { total: 3700, pesoKg: 3, pagaEfectivo: true, sinHistorial: true };

describe("umbral configurable de pedido grande sin historial y en efectivo", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("por omisión sigue en $2,500 (sin cambio de comportamiento)", () => {
    expect(umbralSinHistorialEfectivoMxn({})).toBe(2500);
    expect(evaluarPedidoGrande(caso)).toBe("sin_historial_efectivo");
  });
  it("con la variable en 4000, $3,700 en efectivo sin historial ya no es grande", () => {
    vi.stubEnv("PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN", "4000");
    expect(evaluarPedidoGrande(caso)).toBeNull();
  });
  it("valores inválidos o fuera de rango caen a 2500", () => {
    for (const v of ["", "abc", "100", "50000", "3000.5"]) expect(umbralSinHistorialEfectivoMxn({ PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN: v })).toBe(2500);
    expect(umbralSinHistorialEfectivoMxn({ PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN: "3000" })).toBe(3000);
  });
});
