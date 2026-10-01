// Batería PM F3b — E.10 Concurrencia e idempotencia (repositorio en memoria con los mismos
// cerrojos por clave que el SQL real: claim de mensaje, lease de conversación, CAS del flujo).
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../../src/agent-tools/registry.ts";
import { OrderConflictError } from "../../src/errors.ts";
import { createOrder } from "../../src/orders.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../../src/whatsapp/turn-handler.ts";
import { actorHash } from "../../src/rate-limit.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { PHONE } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function countingHandler(delayMs = 0) {
  const seen: Array<{ phone: string; users: number; last: string }> = [];
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage({ phone, messages }) {
      const users = messages.filter((m) => m.role === "user");
      seen.push({ phone, users: users.length, last: users.at(-1)!.content });
      if (delayMs) await sleep(delayMs);
      return { reply: `ok:${users.at(-1)!.content}`, orderId: null, propertyId: null };
    },
  };
  return { handler, seen };
}

describe("E.10 WhatsApp: reintentos y mensajes simultáneos", () => {
  it("T-CI01 Meta reenvía el mismo message.id 3 veces a la vez: un solo turno y una sola respuesta encolada", async () => {
    const f = buildRestaurantFixture();
    const { handler, seen } = countingHandler(20);
    const args = { organizationId: f.organizationId, messageId: "wamid.A", phone: PHONE, body: "hola", phoneNumberId: "pn1" };
    const results = await Promise.all([1, 2, 3].map(() => handleInboundWhatsAppMessage(f.repo, handler, args)));
    expect(seen).toHaveLength(1);
    expect(results.filter((r) => r.reply !== undefined)).toHaveLength(1);
    // Los duplicados se acusan sin reintento (Meta no debe volver a mandarlos).
    expect(results.filter((r) => r.reply === undefined).every((r) => r.ok && !r.retryable)).toBe(true);
    expect(f.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_reply")).toHaveLength(1);
    // Y un cuarto reintento tardío tampoco reprocesa.
    expect(await handleInboundWhatsAppMessage(f.repo, handler, args)).toMatchObject({ ok: true, retryable: false });
    expect(seen).toHaveLength(1);
  });

  it("T-CI02 lote con 5 mensajes de 3 clientes: todos procesados y cada conversación conserva el orden de SUS mensajes", async () => {
    const f = buildRestaurantFixture();
    const { handler, seen } = countingHandler(5);
    const batch = [
      ["A", "m1", "uno"],
      ["B", "m2", "uno"],
      ["A", "m3", "dos"],
      ["C", "m4", "uno"],
      ["B", "m5", "dos"],
    ] as const;
    const phoneOf = (c: string) => `+52199900000${c === "A" ? "01" : c === "B" ? "02" : "03"}`;
    // Meta procesa el lote en orden: el mismo cliente nunca va en paralelo consigo mismo; clientes distintos sí.
    const porCliente = new Map<string, typeof batch[number][]>();
    for (const m of batch) porCliente.set(m[0], [...(porCliente.get(m[0]) ?? []), m]);
    const outcomes = await Promise.all(
      [...porCliente.values()].map(async (msgs) => {
        const res = [];
        for (const [c, id, body] of msgs) res.push(await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: id, phone: phoneOf(c), body, phoneNumberId: "pn1" }));
        return res;
      }),
    );
    expect(outcomes.flat().every((o) => o.ok)).toBe(true);
    expect(seen).toHaveLength(5);
    const a = seen.filter((s) => s.phone === phoneOf("A"));
    expect(a.map((s) => [s.users, s.last])).toEqual([
      [1, "uno"],
      [2, "dos"],
    ]);
  });

  it("T-CI03 / T-CI08 tres mensajes del mismo cliente en el mismo instante: los que chocan con el lease son REINTENTABLES, y al reintentar no se pierde ninguno", async () => {
    const f = buildRestaurantFixture();
    const { handler, seen } = countingHandler(30);
    const msg = (id: string, body: string) => ({ organizationId: f.organizationId, messageId: id, phone: PHONE, body, phoneNumberId: "pn1" });
    const primera = await Promise.all([handleInboundWhatsAppMessage(f.repo, handler, msg("w1", "uno")), handleInboundWhatsAppMessage(f.repo, handler, msg("w2", "dos")), handleInboundWhatsAppMessage(f.repo, handler, msg("w3", "tres"))]);
    const ocupados = primera.filter((r) => !r.ok);
    expect(primera.filter((r) => r.ok)).toHaveLength(1);
    expect(ocupados).toHaveLength(2);
    expect(ocupados.every((r) => r.retryable)).toBe(true);
    // Meta reintenta los dos fallidos (en serie, como un lote reenviado).
    for (const id of ["w2", "w3"]) {
      const body = id === "w2" ? "dos" : "tres";
      const r = await handleInboundWhatsAppMessage(f.repo, handler, msg(id, body));
      // Puede quedar el que ya ganó la primera vuelta: el que no se procesó ahora sí.
      expect(r.ok || r.retryable === false).toBe(true);
    }
    const bodies = new Set(seen.map((s) => s.last));
    expect(bodies).toEqual(new Set(["uno", "dos", "tres"]));
    // Cada turno vio el historial acumulado completo (sin pérdidas ni pisadas).
    const finales = seen.map((s) => s.users).sort();
    expect(finales).toEqual([1, 2, 3]);
  });

  it("T-CI08 el lease ocupado marca el evento como fallido para que el reclamo posterior del mismo message_id SÍ procese", async () => {
    const f = buildRestaurantFixture();
    const { handler, seen } = countingHandler();
    // Otro mensaje del mismo cliente sostiene el lease.
    expect(await f.repo.claimWhatsAppConversation(f.organizationId, actorHash(PHONE), "otro", 120)).toBe(true);
    const r1 = await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: "w9", phone: PHONE, body: "hola", phoneNumberId: "pn1" });
    expect(r1).toMatchObject({ ok: false, retryable: true });
    expect(seen).toHaveLength(0);
    await f.repo.finishWhatsAppMessage(f.organizationId, "otro", actorHash(PHONE), "processed", null);
    const r2 = await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: "w9", phone: PHONE, body: "hola", phoneNumberId: "pn1" });
    expect(r2).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
  });

  it("un turn handler que lanza deja el mensaje reintentable, libera el lease y el reintento posterior procesa sin duplicar el mensaje del cliente", async () => {
    const f = buildRestaurantFixture();
    let falla = true;
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ messages }) {
        if (falla) throw new Error("boom");
        return { reply: `vi ${messages.filter((m) => m.role === "user").length}`, orderId: null, propertyId: null };
      },
    };
    const args = { organizationId: f.organizationId, messageId: "wf1", phone: PHONE, body: "hola", phoneNumberId: "pn1" };
    expect(await handleInboundWhatsAppMessage(f.repo, handler, args)).toMatchObject({ ok: false, retryable: true });
    falla = false;
    const r = await handleInboundWhatsAppMessage(f.repo, handler, args);
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("vi 2"); // el mensaje del usuario quedó guardado en el primer intento; el reintento no lo pierde
  });
});

describe("E.10 pedido: doble confirmación, duplicados y carreras", () => {
  const items = (f: ReturnType<typeof buildRestaurantFixture>, qty = 2) => [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: qty }];
  function flow(f: ReturnType<typeof buildRestaurantFixture>) {
    let turn = 1;
    const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", flow: { key: "wa:9991234567", turn: String(turn) } });
    const call = (name: string, input: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), name, input);
    const create = (qty = 2) => call("crear_pedido", { branch_slug: "fco-montejo", customer_name: "Ana", payment_method: "efectivo", canal: "recoger", items: items(f, qty) });
    const quote = (qty = 2) => call("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: items(f, qty) });
    const ordenes = async () => (await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 50 })).orders.length;
    return { call, create, quote, nextTurn: () => void (turn += 1), ordenes };
  }

  it("T-CI04 el cliente dice 'sí' dos veces / '¿ya quedó?' tras crear: el segundo crear_pedido se rechaza y queda UNA sola comanda", async () => {
    const f = buildRestaurantFixture();
    const s = flow(f);
    await s.quote();
    s.nextTurn();
    await s.call("confirmar_resumen");
    const primero = await s.create();
    expect(primero.orderId).not.toBeNull();
    s.nextTurn();
    await expect(s.create()).rejects.toMatchObject({ code: "pedido_ya_creado" });
    await expect(s.call("confirmar_resumen")).rejects.toMatchObject({ code: "pedido_ya_creado" });
    await expect(s.create()).rejects.toMatchObject({ code: "pedido_ya_creado" });
    expect(await s.ordenes()).toBe(1);
  });

  it("dos crear_pedido SIMULTÁNEOS tras la misma confirmación crean una sola comanda", async () => {
    const f = buildRestaurantFixture();
    const s = flow(f);
    await s.quote();
    s.nextTurn();
    await s.call("confirmar_resumen");
    const res = await Promise.allSettled([s.create(), s.create(), s.create()]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await s.ordenes()).toBe(1);
  });

  it("carrera cotizar/confirmar: si cambia el pedido DESPUÉS de confirmar y se recotiza, crear con lo viejo se rechaza y exige nueva confirmación", async () => {
    const f = buildRestaurantFixture();
    const s = flow(f);
    await s.quote(2);
    s.nextTurn();
    await s.call("confirmar_resumen");
    s.nextTurn();
    await s.quote(5); // el cliente cambió la cantidad
    await expect(s.create(2)).rejects.toMatchObject({ code: expect.stringMatching(/sin_confirmacion|pedido_distinto_al_cotizado/) });
    await expect(s.create(5)).rejects.toMatchObject({ code: "sin_confirmacion" });
    expect(await s.ordenes()).toBe(0);
    s.nextTurn();
    await s.call("confirmar_resumen");
    const ok = await s.create(5);
    expect(ok.orderId).not.toBeNull();
  });

  it("confirmar con el quote_hash de una cotización vieja se rechaza", async () => {
    const f = buildRestaurantFixture();
    const s = flow(f);
    const q1 = await s.quote(2);
    s.nextTurn();
    await s.quote(3);
    s.nextTurn();
    await expect(s.call("confirmar_resumen", { quote_hash: q1.quoteHash })).rejects.toBeDefined();
  });

  const base = (f: ReturnType<typeof buildRestaurantFixture>, extra: Record<string, unknown> = {}) => ({
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Ana",
    customerPhone: "9991234567",
    paymentMethod: "efectivo" as const,
    source: "voice" as const,
    canal: "recoger" as const,
    items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }],
    ...extra,
  });

  it("T-CI07 20 createOrder concurrentes con la misma idempotencyKey: 1 fila y 1 incremento de order_count", async () => {
    const f = buildRestaurantFixture();
    const orders = await Promise.all(Array.from({ length: 20 }, () => createOrder(f.repo, base(f, { idempotencyKey: "k-1" }))));
    expect(new Set(orders.map((o) => o.id)).size).toBe(1);
    expect((await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 50 })).orders).toHaveLength(1);
    const customer = await f.repo.findCustomerByPhone(f.organizationId, "9991234567");
    expect(customer!.orderCount).toBe(1);
  });

  it("20 createOrder idénticos SIN clave se colapsan por huella de 5 min: una sola comanda", async () => {
    const f = buildRestaurantFixture();
    const orders = await Promise.all(Array.from({ length: 20 }, () => createOrder(f.repo, base(f))));
    expect(new Set(orders.map((o) => o.id)).size).toBe(1);
  });

  it("T-CI05 misma clave con items distintos: conflicto tipado (nunca devuelve el pedido viejo en silencio)", async () => {
    const f = buildRestaurantFixture();
    await createOrder(f.repo, base(f, { idempotencyKey: "k-2" }));
    await expect(createOrder(f.repo, base(f, { idempotencyKey: "k-2", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 7 }] }))).rejects.toBeInstanceOf(OrderConflictError);
    expect((await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 50 })).orders).toHaveLength(1);
  });

  it("la misma clave en OTRA organización no choca ni devuelve el pedido ajeno", async () => {
    const f = buildRestaurantFixture();
    const mio = await createOrder(f.repo, base(f, { idempotencyKey: "k-3" }));
    const otro = buildRestaurantFixture();
    const suyo = await createOrder(otro.repo, base(otro, { idempotencyKey: "k-3" }));
    expect(suyo.id).not.toBe(mio.id);
    expect(suyo.organizationId).toBe(otro.organizationId);
  });
});
