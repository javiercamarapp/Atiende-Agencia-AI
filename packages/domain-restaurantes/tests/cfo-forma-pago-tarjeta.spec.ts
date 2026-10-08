// CFO-08 · «tarjeta» para la comisión de terminal: American Express sí; crédito a cliente (cuenta por cobrar) no.
import { describe, expect, it } from "vitest";
import { esFormaPagoTarjeta } from "../src/cfo/estado-resultados.ts";

describe("esFormaPagoTarjeta", () => {
  it("cuenta tarjeta, crédito, débito y amex", () => {
    for (const v of ["tarjeta", "Tarjeta de crédito", "tarjeta_credito", "tarjeta_debito", "débito", "amex", "American Express"]) expect(esFormaPagoTarjeta(v), v).toBe(true);
  });
  it("no cuenta efectivo, cortesía, plataformas ni crédito a cliente", () => {
    for (const v of ["efectivo", "cortesia", "plataforma", "mercado_pago", "transferencia", "credito_cliente", "Crédito a cliente", "cuenta por cobrar", null, ""]) expect(esFormaPagoTarjeta(v), String(v)).toBe(false);
  });
});
