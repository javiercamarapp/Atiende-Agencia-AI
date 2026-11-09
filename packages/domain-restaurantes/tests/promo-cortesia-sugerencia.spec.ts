// E2E de voz r3 (8-nov-2026, VZ05 restaurante): el martes, con 6 tacos de pastor (sin nachos), la cotizacion sugeria el combo de cortesia con el texto
// «por cada producto de la promoción van 2 pieza(s) de cortesía ... agregue esas piezas como renglones y vuelva a cotizar». El modelo ofrecio «2 aguas de
// cortesía», agrego 2 horchatas SIN los nachos y el motor (bien) las cobro: 372 en vez de 252. La sugerencia es compartida por WhatsApp y voz.
import { describe, expect, it } from "vitest";
import { mensajePromocionSugerida } from "../src/orders.ts";
import type { Promotion } from "../src/types.ts";

const COMBO = {
  code: "MARTESNACHOS", name: "Martes de nachos", description: null, type: "cortesia", courtesyQuantity: 2,
  productIds: ["nachos"], courtesyProductIds: ["jamaica", "horchata", "te"],
} as unknown as Promotion;
const NOMBRES: Record<string, string> = { nachos: "Nachos de Pastor", jamaica: "Jamaica", horchata: "Horchata", te: "Té" };
const nombre = (id: string) => NOMBRES[id] ?? null;

describe("sugerencia del combo de cortesia (compartida WhatsApp/voz)", () => {
  it("sin el producto disparador en el pedido: nombra el disparador, dice que sin el las bebidas se cobran y NO pide agregar piezas de cortesia", () => {
    const m = mensajePromocionSugerida(COMBO, "faltan_productos", nombre);
    expect(m).toContain("Nachos de Pastor");
    expect(m).toMatch(/solo (si|con)/i);
    expect(m).toMatch(/se cobran/i);
    expect(m).not.toMatch(/agregue esas piezas/i);
  });

  it("con el disparador ya en el pedido: pide elegir las piezas de cortesia y agregarlas (comportamiento previo)", () => {
    const m = mensajePromocionSugerida(COMBO, "falta_elegir_cortesia", nombre);
    expect(m).toContain("Nachos de Pastor");
    expect(m).toMatch(/agregue/i);
    expect(m).toMatch(/2 pieza/);
  });
});
