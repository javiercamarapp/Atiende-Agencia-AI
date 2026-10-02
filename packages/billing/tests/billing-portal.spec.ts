// Portal de cliente de Stripe (PL-16): validacion de entradas y delegacion en el cliente (doble de Stripe; nunca red real).
import { describe, expect, it } from "vitest";
import { PortalFacturacionInvalido, crearSesionPortalFacturacion } from "../src/billing-portal.ts";
import type { StripeBillingPortalClient } from "../src/billing-portal.ts";

function cliente(url = "https://billing.stripe.com/p/session/abc") {
  const llamadas: Array<{ customerId: string; returnUrl: string }> = [];
  const c: StripeBillingPortalClient = {
    async crearSesionPortal(opts) {
      llamadas.push(opts);
      return { url };
    },
  };
  return { c, llamadas };
}

describe("crearSesionPortalFacturacion", () => {
  it("crea la sesion con el customer y la URL de retorno y devuelve la URL de Stripe", async () => {
    const { c, llamadas } = cliente();
    const r = await crearSesionPortalFacturacion(c, { customerId: "cus_ABC123xyz", returnUrl: "https://app.atiende.ai/hoteles/hotel-a/plan" });
    expect(r.url).toBe("https://billing.stripe.com/p/session/abc");
    expect(llamadas).toEqual([{ customerId: "cus_ABC123xyz", returnUrl: "https://app.atiende.ai/hoteles/hotel-a/plan" }]);
  });

  it("rechaza un customer que no es de Stripe (nunca llega a la red)", async () => {
    const { c, llamadas } = cliente();
    for (const customerId of ["", "sub_123456", "cus_", "cus_ab", "cus_ok123456; drop"]) {
      await expect(crearSesionPortalFacturacion(c, { customerId, returnUrl: "https://app.atiende.ai/x" })).rejects.toBeInstanceOf(PortalFacturacionInvalido);
    }
    expect(llamadas).toHaveLength(0);
  });

  it("rechaza una URL de retorno invalida o que no es http(s)", async () => {
    const { c, llamadas } = cliente();
    for (const returnUrl of ["", "/relativa", "javascript:alert(1)", "ftp://x.mx/a"]) {
      await expect(crearSesionPortalFacturacion(c, { customerId: "cus_ABC123xyz", returnUrl })).rejects.toBeInstanceOf(PortalFacturacionInvalido);
    }
    expect(llamadas).toHaveLength(0);
  });

  it("si Stripe responde sin URL lanza (no inventa una)", async () => {
    const { c } = cliente("");
    await expect(crearSesionPortalFacturacion(c, { customerId: "cus_ABC123xyz", returnUrl: "https://app.atiende.ai/x" })).rejects.toThrow(/URL del portal/);
  });
});
