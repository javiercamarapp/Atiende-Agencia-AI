// POST /billing/webhook — un fallo transitorio a media aplicación NO debe consumir el evento.
//
// Stripe reintenta un webhook que respondió 5xx con el MISMO id de evento. Si la marca de "visto"
// del ledger queda escrita aunque la aplicación haya fallado, el reintento responde 'duplicado' y
// el cambio de suscripción se pierde para siempre. Marca, aplicación y sello tienen que ser
// atómicos: o quedan los tres, o ninguno.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

const WEBHOOK_SECRET = "whsec_test_reintento";

function firmarStripe(secret: string, timestampUnix: number, payload: string): string {
  const hmac = createHmac("sha256", secret).update(`${timestampUnix}.${payload}`, "utf8").digest("hex");
  return `t=${timestampUnix},v1=${hmac}`;
}

function rawRequestInit(body: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength), ...headers },
  };
}

function subscriptionEvent(opts: { id: string; created: number; customer: string; tenantId: string; quantity: number }): string {
  return JSON.stringify({
    id: opts.id,
    object: "event",
    type: "customer.subscription.updated",
    created: opts.created,
    data: {
      object: {
        id: `sub_${opts.customer}`,
        customer: opts.customer,
        status: "active",
        current_period_end: opts.created + 30 * 86_400,
        items: { data: [{ quantity: opts.quantity, price: { id: "price_reintento" } }] },
        metadata: { tenant_id: opts.tenantId, vertical: "restaurantes" },
      },
    },
  });
}

async function contexto() {
  const base = await buildTestDeps();
  const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
  const app = buildApp(deps);
  const now = Math.floor(Date.now() / 1000);
  const enviar = (payload: string) => app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": firmarStripe(WEBHOOK_SECRET, now, payload) }));
  return { base, deps, now, enviar };
}

describe("POST /billing/webhook — fallo transitorio y reintento del mismo evento", () => {
  it("si aplicar el estado falla (5xx), el reintento del MISMO evento se aplica (nunca 'duplicado')", async () => {
    const { base, deps, now, enviar } = await contexto();
    const upsert = vi.spyOn(deps.coreRepo, "upsertOrganizationBilling").mockRejectedValueOnce(new Error("postgres: connection terminated unexpectedly"));
    const payload = subscriptionEvent({ id: "evt_transitorio", created: now, customer: "cus_transitorio", tenantId: base.organizationId, quantity: 7 });

    const primero = await enviar(payload);
    expect(primero.status).toBe(500);

    const reintento = await enviar(payload);
    expect(reintento.status).toBe(200);
    expect(((await reintento.json()) as { estado: string }).estado).toBe("aplicado");
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId)).toMatchObject({ seats: 7, status: "activa" });
    expect(await deps.coreRepo.getBillingEntityOrder("cus_transitorio")).toBe(now);
  });

  it("si el sello de orden falla DESPUÉS de aplicar, nada queda a medias: el reintento se aplica y sella", async () => {
    const { base, deps, now, enviar } = await contexto();
    vi.spyOn(deps.coreRepo, "sealBillingEntityOrder").mockRejectedValueOnce(new Error("statement timeout"));
    const payload = subscriptionEvent({ id: "evt_sello_falla", created: now, customer: "cus_sello", tenantId: base.organizationId, quantity: 3 });

    const primero = await enviar(payload);
    expect(primero.status).toBe(500);

    const reintento = await enviar(payload);
    expect(reintento.status).toBe(200);
    expect(((await reintento.json()) as { estado: string }).estado).toBe("aplicado");
    expect(await deps.coreRepo.getBillingEntityOrder("cus_sello")).toBe(now);
    expect(await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId)).toMatchObject({ seats: 3 });
  });

  it("un evento aplicado con éxito sigue siendo 'duplicado' en su reintento (la atomicidad no rompe el dedupe)", async () => {
    const { base, now, enviar } = await contexto();
    const payload = subscriptionEvent({ id: "evt_ok", created: now, customer: "cus_ok", tenantId: base.organizationId, quantity: 2 });
    expect(((await (await enviar(payload)).json()) as { estado: string }).estado).toBe("aplicado");
    expect(((await (await enviar(payload)).json()) as { estado: string }).estado).toBe("duplicado");
  });
});
