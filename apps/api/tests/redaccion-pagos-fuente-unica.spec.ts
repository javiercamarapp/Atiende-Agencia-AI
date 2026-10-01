// PL-10: las tres copias de `redactSensitiveInfo` (webhooks de WhatsApp de citas, hoteles y
// restaurantes) habian divergido -- citas y hoteles tenian la version vieja de la regex de tarjeta
// y redactaban "1/2 orden" como si fuera un vencimiento. Ahora las tres delegan en la misma
// funcion de @atiende/core-pii; este test falla si una vuelve a bifurcarse.
import { describe, expect, it } from "vitest";
import { redactarDatosDePago } from "@atiende/core-pii";
import { redactSensitiveInfo as citas } from "@atiende/domain-citas";
import { redactSensitiveInfo as hoteles } from "@atiende/domain-hoteles";
import { redactSensitiveInfo as restaurantes } from "@atiende/domain-restaurantes";

const mensajes = [
  "mi tarjeta es 4242 4242 4242 4242 cvv 123 vence 12/27",
  "4242 4242 4242 4242 CVV: 999",
  "quiero 1/2 orden de tacos y 1/4 de kilo",
  "cita el 5/9 a las 10",
];

describe("redactSensitiveInfo de WhatsApp (citas, hoteles, restaurantes)", () => {
  it.each(mensajes)("las tres verticales redactan igual que la fuente unica: %s", (mensaje) => {
    const esperado = redactarDatosDePago(mensaje);
    expect(citas(mensaje)).toBe(esperado);
    expect(hoteles(mensaje)).toBe(esperado);
    expect(restaurantes(mensaje)).toBe(esperado);
  });

  it("regresion de citas y hoteles: una fraccion de platillo ya no se redacta como vencimiento", () => {
    expect(citas("quiero 1/2 orden")).toBe("quiero 1/2 orden");
    expect(hoteles("quiero 1/2 orden")).toBe("quiero 1/2 orden");
  });
});
