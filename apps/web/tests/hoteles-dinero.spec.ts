// PR-6 de diseno-ux (hoteles): las 7 copias locales de formatMoney pasan a lib/dinero.ts, que delega en
// @atiende/ui. Se afirma que la salida es IDENTICA a la de las implementaciones que reemplazan.
import { describe, expect, it } from "vitest";
import { dineroMx, dineroMxConSigno } from "../src/verticals/hoteles/lib/dinero.ts";

const MUESTRAS = [0, 5, 12.5, 999.99, 1000, 12345.678, 1234567.891, -5, -1234.5, -0.4, 0.004];

describe("hoteles/lib/dinero", () => {
  it("dineroMx replica `$${n.toLocaleString('es-MX', {min/max 2})}` (Cfdi, CfdiListado, Folio, Reservas)", () => {
    for (const n of MUESTRAS) {
      expect(dineroMx(n)).toBe(`$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    }
  });

  it("dineroMxConSigno(n, 2) replica la moneda MXN de Pl (signo antes del $, 2 decimales)", () => {
    for (const n of MUESTRAS) {
      expect(dineroMxConSigno(n)).toBe(n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 }));
    }
  });

  it("dineroMxConSigno(n, 0) replica la moneda MXN de Dashboard y Revenue (sin decimales)", () => {
    for (const n of MUESTRAS) {
      expect(dineroMxConSigno(n, 0)).toBe(n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }));
    }
  });
});
