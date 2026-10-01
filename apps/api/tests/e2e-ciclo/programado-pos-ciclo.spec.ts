// R-23: pedido PROGRAMADO y POS. Un programado no va a cocina hoy (ni al POS): al promoverse a `pending`
// (cron interno O el panel al consultar) la comanda DEBE llegar al POS falso, una sola vez (idempotente por pedido).
// Tambien cubre el POS caido (captura manual) y el reintento por el dispatcher interno.
import { afterEach, describe, expect, it, vi } from "vitest";
import { authedGet, authedJson } from "../restaurantes-admin-kpis-fixtures.ts";
import { E2E_SECRETS, ORG_SLUG, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("e2e programado + POS", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  async function crearProgramado(): Promise<Json> {
    stack.ctx.restaurantesRepo.setScheduledOrdersSupported(true);
    const raw = JSON.stringify({
      branch_slug: "fco-montejo",
      customer_name: "Paco Programado",
      customer_phone: "9991230060",
      canal: "recoger",
      payment_method: "efectivo",
      programado_para: "2026-10-06T22:00:00.000Z", // 16:00 Merida; "ahora" es 13:00 Merida
      items: [{ product_id: stack.products.coca, requested_quantity: 5 }],
    });
    const res = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/orders`), { method: "POST", headers: { "content-type": "application/json", "content-length": String(raw.length), origin: "http://localhost:5173" }, body: raw });
    expect(res.status).toBe(200);
    return (await res.json()) as Json;
  }

  it("programado: queda fuera de cocina y del POS; al promoverlo por el cron la comanda llega al POS UNA vez", async () => {
    stack = await startCicloStack();
    const { order } = await crearProgramado();
    expect(order.status).toBe("programado");
    expect(stack.pos.comandas).toHaveLength(0);

    // Todavia falta mucho: el cron no lo promueve.
    const cron = () => fetch(stack.url("/internal/restaurantes/promover-programados"), { method: "POST", headers: { "x-atiende-internal-secret": E2E_SECRETS.internalSecret } });
    expect(((await (await cron()).json()) as Json).promoted).toBe(0);

    // Faltan 20 min (anticipacion = 30): se promueve y entra a cocina Y al POS.
    vi.setSystemTime(new Date("2026-10-06T21:40:00.000Z"));
    const promoted = (await (await cron()).json()) as Json;
    expect(promoted.promoted).toBe(1);
    // R-29: el cron ENCOLA la comanda (envio diferido); el dispatcher la manda al POS.
    expect(promoted.comandas).toMatchObject({ intentados: 1, encoladas: 1, errores: 0 });
    await stack.dispatchPos();
    expect(stack.pos.comandas).toHaveLength(1);
    expect(stack.pos.llamadasCrear[0]).toMatchObject({ tipo: "recoger" });
    // El cron otra vez no duplica nada, ni el dispatcher reenvia.
    expect(((await (await cron()).json()) as Json).promoted).toBe(0);
    await stack.dispatchPos();
    expect(stack.pos.comandas).toHaveLength(1);
  });

  it("programado promovido por el PANEL al consultar (sin cron): tambien llega al POS", async () => {
    stack = await startCicloStack();
    await crearProgramado();
    vi.setSystemTime(new Date("2026-10-06T21:40:00.000Z"));
    // El token del gerente (15 min) vence con el salto del reloj: vuelve a iniciar sesion, como lo haria el panel.
    const login = await fetch(stack.url("/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: stack.ctx.staff.owner.email, password: stack.ctx.staff.owner.password }) });
    const { token } = (await login.json()) as { token: string };
    const res = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders?status=pending`), authedGet(token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).orders).toHaveLength(1);
    // La tarea post-commit encola la comanda despues de responder (R-29) y el dispatcher la manda al POS.
    await vi.waitFor(async () => {
      await stack.dispatchPos();
      expect(stack.pos.comandas).toHaveLength(1);
    });
  });

  it("POS caido: el pedido existe, la comanda queda fallida y el gerente la captura a mano; al volver el POS el dispatcher no duplica", async () => {
    stack = await startCicloStack();
    stack.pos.inyectarFalla("crearComanda", { tipo: "timeout" });
    // storefront: cotizar -> confirmar -> crear
    const post = (p: string, body: unknown) => {
      const r = JSON.stringify(body);
      return fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/storefront${p}`), { method: "POST", headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(r).byteLength), origin: "http://localhost:5173" }, body: r });
    };
    const base = { session_id: "sesion-e2e-0123456789abcdef", items: [{ product_id: stack.products.coca, requested_quantity: 5 }], canal: "recoger" };
    const q = (await (await post("/fco-montejo/quote", base)).json()) as Json;
    await post("/fco-montejo/confirm", { session_id: base.session_id, quote_hash: q.quote_hash });
    const created = (await (await post("/fco-montejo/orders", { ...base, customer_name: "Pos Caido", customer_phone: "9991230061", payment_method: "efectivo", quote_hash: q.quote_hash })).json()) as Json;
    expect(created.estado).toBe("pending");
    expect(created.comanda).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
    expect(stack.pos.comandas).toHaveLength(0);

    // El gerente ve la comanda pendiente y la captura a mano en el POS.
    const owner = stack.ctx.staff.owner.token;
    const lista = (await (await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/softrestaurant/comandas`), authedGet(owner))).json()) as Json;
    expect(JSON.stringify(lista)).toMatch(/fallida|pendiente/);
    const id = (lista.comandas ?? lista.items)[0].id as string;
    const cap = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/softrestaurant/comandas/${id}/capturada`), authedJson(owner, { folio: "MANUAL-1" }, "POST"));
    expect(cap.status).toBe(200);
    // El POS vuelve: el dispatcher ya no reenvia la comanda capturada a mano.
    await stack.dispatchPos();
    expect(stack.pos.comandas).toHaveLength(0);
  });
});
