// Adaptador real del Billing Portal de Stripe (PL-16) con `fetch` inyectado (nunca red real): forma exacta de la peticion y
// manejo de errores sin filtrar la llave.
import { describe, expect, it } from "vitest";
import { StripeSaasBillingCheckoutPort } from "../src/production/saas-billing-stripe-port.ts";

function puerto(respuesta: Response) {
  const llamadas: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    return respuesta;
  }) as unknown as typeof fetch;
  return { port: new StripeSaasBillingCheckoutPort(fetchImpl, { secretKey: "sk_test_secreta" }), llamadas };
}

describe("StripeSaasBillingCheckoutPort.crearSesionPortal", () => {
  it("POST /v1/billing_portal/sessions con customer y return_url (form-urlencoded) y devuelve la URL", async () => {
    const { port, llamadas } = puerto(new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session/xyz" }), { status: 200 }));
    const r = await port.crearSesionPortal({ customerId: "cus_ABC123xyz", returnUrl: "https://app.atiende.ai/hoteles/hotel-a/plan" });
    expect(r.url).toBe("https://billing.stripe.com/p/session/xyz");
    expect(llamadas[0]!.url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    const headers = llamadas[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.Authorization).toBe("Bearer sk_test_secreta");
    const body = llamadas[0]!.init.body as URLSearchParams;
    expect(body.get("customer")).toBe("cus_ABC123xyz");
    expect(body.get("return_url")).toBe("https://app.atiende.ai/hoteles/hotel-a/plan");
  });

  it("un error de Stripe lanza con el estado y el mensaje de Stripe, sin incluir la llave", async () => {
    const { port } = puerto(new Response(JSON.stringify({ error: { message: "No configuration provided" } }), { status: 400 }));
    const err = await port.crearSesionPortal({ customerId: "cus_ABC123xyz", returnUrl: "https://app.atiende.ai/x" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("400");
    expect((err as Error).message).toContain("No configuration provided");
    expect((err as Error).message).not.toContain("sk_test_secreta");
  });

  it("200 sin url lanza (no inventa una)", async () => {
    const { port } = puerto(new Response("{}", { status: 200 }));
    await expect(port.crearSesionPortal({ customerId: "cus_ABC123xyz", returnUrl: "https://app.atiende.ai/x" })).rejects.toThrow(/sin `url`/);
  });
});
