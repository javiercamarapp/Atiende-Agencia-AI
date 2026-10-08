// Regresiones del HISTORIAL DE GIT del original, lote 2: el turno del agente (loop agotado, cascada de modelos),
// pedidos (carrera de cliente nuevo, alcohol, payload invalido, vista previa), config del agente, WhatsApp en lote
// y replay. Una prueba por bug con commit y caso X en el titulo (ver README.md). it.fails = el defecto sigue en main
// y lo corrige el lote nombrado; al entrar ese PR la prueba se vuelve verde y hay que quitarle `.fails`.
import { describe, expect, it, vi } from "vitest";
import { FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { OrderValidationError } from "../../src/errors.ts";
import { createOrder, quoteOrder } from "../../src/orders.ts";
import { invokeAgentTool } from "../../src/agent-tools/registry.ts";
import { normalizePhone } from "../../src/phone.ts";
import { extractMetaTextMessages } from "../../src/whatsapp/channel-config.ts";
import { splitMetaPayloadByChannel } from "../../src/whatsapp/batch-routing.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../../src/whatsapp/turn-handler.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";
import { makeGateway, NEW_CUSTOMER } from "../pm/harness.ts";
import { item, mensajeDe, pedido, pmFixture } from "./fixture.ts";
import type { F } from "./fixture.ts";

const PHONE = "+5219990000000";
const comp = (partial: Partial<LlmCompletionResult>): LlmCompletionResult => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0, ...partial });
const llamada = (id: string, name: string, args: object) => comp({ toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }] });

async function pedidosDe(f: F, phone: string) {
  const cliente = await f.repo.findCustomerByPhone(f.organizationId, normalizePhone(phone));
  return cliente ? await f.repo.listEligibleOrderHistory(cliente.id) : [];
}

const crearPedidoArgs = (f: F, extra: object = {}) => ({
  branch_slug: "t1-montejo",
  customer_name: "Marcela",
  canal: "recoger",
  items: [{ product_id: f.p.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }],
  payment_method: "efectivo",
  ...extra,
});

/** Handler con DOS escaleras (default/escalated) que comparten un guion por indice de llamada y cuentan cuantas recibio cada una. */
function turnoConGuion(f: F, guion: (n: number) => LlmCompletionResult, opts: { maxToolUseTurns?: number } = {}) {
  const gateway = makeGateway();
  let n = 0;
  const llamadas = { default: 0, escalated: 0 };
  for (const rol of ["default", "escalated"] as const) {
    gateway.registerLadder(rol, [new FakeLlmProvider({ id: rol, script: () => { llamadas[rol] += 1; return guion(n++); } })]);
  }
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", ...opts });
  const turno = (contenido: string) => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: contenido }], customer: NEW_CUSTOMER, propertyId: null });
  return { turno, llamadas };
}

describe("c25e70c -- loop agotado despues de crear: nunca 'se me complico' ni pedido duplicado", () => {
  it("X08 / c25e70c: crear en la vuelta 7, agotar en la 8 -> respuesta de exito; '¿ya quedo?' -> 0 pedidos nuevos", async () => {
    const f = pmFixture();
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "t1-montejo", canal: "recoger", items: [{ productId: f.p.cocaCola, productName: "Coca-Cola", requestedQuantity: 1 }] });
    const { turno } = turnoConGuion(
      f,
      (n) => {
        if (n < 6) return llamada(`c${n}`, "consultar_sucursal", { branch_slug: "t1-montejo" });
        if (n === 6) return llamada("crear", "crear_pedido", crearPedidoArgs(f));
        if (n === 7) return llamada("extra", "registrar_contacto", { customer_name: "Marcela", reason: "otro" });
        if (n === 8) return llamada("otra-vez", "crear_pedido", crearPedidoArgs(f));
        return comp({ text: "Su pedido ya quedó registrado, ¿algo más?" });
      },
      { maxToolUseTurns: 8 },
    );
    const primero = await turno("confirmo");
    expect(primero.orderId).not.toBeNull();
    expect(primero.reply).toMatch(/ya quedó registrado/i);
    expect(primero.reply).not.toMatch(/se me complic/i);
    expect(await pedidosDe(f, PHONE)).toHaveLength(1);

    const segundo = await turno("¿ya quedó?");
    expect(await pedidosDe(f, PHONE)).toHaveLength(1);
    expect(segundo.reply).not.toMatch(/se me complic/i);
  });
});

describe("05a9798 / 6091e17 -- cascada barato -> caro", () => {
  it("X34 / 05a9798: un fallo de sistema de crear_pedido hace que el SIGUIENTE vuelta del turno use el rol escalado", async () => {
    const f = pmFixture();
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "t1-montejo", canal: "recoger", items: [{ productId: f.p.cocaCola, productName: "Coca-Cola", requestedQuantity: 1 }] });
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValue(new Error("base caida"));
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? llamada("c", "crear_pedido", crearPedidoArgs(f)) : comp({ text: "Un momento, ¿me confirma su pedido?" })));
    const r = await turno("confirmo");
    expect(llamadas).toEqual({ default: 1, escalated: 1 });
    expect(r.orderId).toBeNull();
  });

  // QA agentes-26 / B04: un rechazo correcto de regla de negocio NO sube de rol; solo un fallo de sistema lo hace (ver X34 / 05a9798).
  it("X34 / 6091e17 [lote B1, agentes-26]: un rechazo de regla de negocio (pedido minimo a domicilio) NO escala de rol", async () => {
    const f = pmFixture();
    f.repo.seedBranchPolicy(f.t1, { pedidoMinimoDomicilio: 200 });
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "t1-montejo", canal: "domicilio", items: [{ productId: f.p.cocaCola, productName: "Coca-Cola", requestedQuantity: 1 }] });
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? llamada("c", "crear_pedido", crearPedidoArgs(f, { canal: "domicilio", customer_address: "Calle 7 #210, Vista Alegre" })) : comp({ text: "Le faltan $155 para el mínimo, ¿desea agregar algo?" })));
    await turno("confirmo");
    expect(await pedidosDe(f, PHONE)).toHaveLength(0);
    expect(llamadas.escalated).toBe(0);
  });
});

describe("5d164ee -- red team: carrera de cliente nuevo, alcohol y tarjeta", () => {
  it("X19 / 5d164ee: 2 pedidos simultaneos de un cliente NUEVO (carrera 23505) terminan en 1 solo cliente con 2 pedidos", async () => {
    const f = pmFixture();
    const [a, b] = await Promise.all([
      createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 1)], { customerPhone: "9995550001" })),
      createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 2)], { customerPhone: "9995550001" })),
    ]);
    expect(a.id).not.toBe(b.id);
    const cliente = await f.repo.findCustomerByPhone(f.organizationId, "9995550001");
    expect(cliente?.orderCount).toBe(2);
    expect(a.customerId).toBe(b.customerId);
  });

  it("X23 / 5d164ee: alcohol a domicilio responde con el mensaje de la REGLA, nunca 'no disponible' (ver T-RD04)", async () => {
    const f = pmFixture();
    f.repo.seedNoDomicilio({ categoryIds: [f.categorias.cervezas] });
    const cotizando = await mensajeDe(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "domicilio", adultConfirmed: true, items: [item(f.p.sol, 6)] }));
    const creando = await mensajeDe(createOrder(f.repo, pedido(f, [item(f.p.sol, 6)], { adultConfirmed: true })));
    for (const msg of [cotizando, creando]) {
      expect(msg).toMatch(/no se vende a domicilio/);
      expect(msg).not.toMatch(/no disponible/i);
    }
  });

  it("X22 / 5d164ee: tarjeta, CVV y vencimiento llegan REDACTADOS al historial y al modelo (en logs: observabilidad-turno.spec.ts)", async () => {
    const f = pmFixture();
    const visto: string[] = [];
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ messages }) {
        visto.push(...messages.map((m) => m.content));
        return { reply: "No necesito esos datos.", orderId: null, propertyId: null };
      },
    };
    await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.tarjeta-x22", phone: PHONE, body: "Mi tarjeta 4152 3135 0000 1234 cvv 123 exp 12/28", phoneNumberId: "pn-1" });
    expect(visto.join(" ")).toBe("Mi tarjeta [tarjeta oculta] [cvv oculto] exp [vencimiento oculto]");
    expect(visto.join(" ")).not.toMatch(/4152|0000 1234|cvv 123|12\/28/);
  });
});

describe("e1ccae0 -- checkout endurecido: payload invalido y vista previa sin efectos", () => {
  const invalidos: ReadonlyArray<readonly [string, (f: F) => Parameters<typeof pedido>[1]]> = [
    ["sin renglones", () => []],
    ["cantidad 0", (f) => [item(f.p.cocaCola, 0)]],
    ["cantidad 501", (f) => [item(f.p.cocaCola, 501)]],
    ["cantidad con decimales", (f) => [item(f.p.cocaCola, 1.5)]],
  ];
  for (const [nombre, items] of invalidos) {
    it(`X46 / e1ccae0: payload invalido (${nombre}) se rechaza ANTES de tocar la base (ni cliente ni pedido)`, async () => {
      const f = pmFixture();
      const upsert = vi.spyOn(f.repo, "upsertCustomer");
      const crear = vi.spyOn(f.repo, "createOrderIdempotent");
      await expect(createOrder(f.repo, pedido(f, items(f)))).rejects.toBeInstanceOf(OrderValidationError);
      expect(upsert).not.toHaveBeenCalled();
      expect(crear).not.toHaveBeenCalled();
      expect(await f.repo.findCustomerByPhone(f.organizationId, "9991234567")).toBeNull();
    });
  }

  it("X48 / e1ccae0: cotizar (la vista previa del pedido) no crea pedido ni cliente", async () => {
    const f = pmFixture();
    const crear = vi.spyOn(f.repo, "createOrderIdempotent");
    const upsert = vi.spyOn(f.repo, "upsertCustomer");
    await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "t1-montejo", canal: "recoger", items: [item(f.p.cocaCola, 2)] });
    await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: PHONE }, "cotizar_pedido", { branch_slug: "t1-montejo", canal: "recoger", items: [{ product_id: f.p.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
    expect(crear).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(await pedidosDe(f, PHONE)).toHaveLength(0);
  });
});

describe("609c3d6 -- guardar la config del agente y releerla (un cambio no se revierte en silencio)", () => {
  it("X53 / 609c3d6: tras guardar, la version aumenta y el texto releido es EXACTAMENTE el enviado, con su entrada de historial", async () => {
    const f = pmFixture();
    const base = { perfil: "taqueria_pm" as const, agentName: "Arturo", businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null };
    const v1 = await f.repo.guardarWhatsAppAgentConfig(f.organizationId, null, { ...base, greetingText: "Hola, bienvenido" }, { accion: "actualizado", actorUserId: "u-1", versionEsperada: 0 });
    const v2 = await f.repo.guardarWhatsAppAgentConfig(f.organizationId, null, { ...base, greetingText: "Buenas, ¿qué se le antoja?" }, { accion: "actualizado", actorUserId: "u-1", versionEsperada: v1.version ?? 0 });
    expect((v2.version ?? 0)).toBeGreaterThan(v1.version ?? 0);
    const releida = await f.repo.findWhatsAppAgentConfigExacta(f.organizationId, null);
    expect(releida?.version).toBe(v2.version);
    expect(releida?.greetingText).toBe("Buenas, ¿qué se le antoja?");
    const historial = await f.repo.listWhatsAppAgentConfigHistorial(f.organizationId, null, 10);
    expect(historial.map((h) => h.version)).toEqual([v2.version, v1.version]);
    expect((historial[0]!.nuevo as { greetingText?: string }).greetingText).toBe("Buenas, ¿qué se le antoja?");
  });

  it("X53 / 609c3d6: guardar con una version vieja es un conflicto, nunca una escritura silenciosa que pise un cambio ajeno", async () => {
    const f = pmFixture();
    const base = { perfil: "taqueria_pm" as const, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null };
    await f.repo.guardarWhatsAppAgentConfig(f.organizationId, null, { ...base, greetingText: "uno" }, { accion: "actualizado", actorUserId: "u-1", versionEsperada: 0 });
    await expect(f.repo.guardarWhatsAppAgentConfig(f.organizationId, null, { ...base, greetingText: "dos" }, { accion: "actualizado", actorUserId: "u-2", versionEsperada: 0 })).rejects.toThrow();
    expect((await f.repo.findWhatsAppAgentConfigExacta(f.organizationId, null))?.greetingText).toBe("uno");
  });
});

describe("c2154a5 / 1cd7226 -- replay de mensajes y lote de Meta", () => {
  const contador = () => {
    const vistos: string[] = [];
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ messages }) {
        vistos.push(messages.filter((m) => m.role === "user").at(-1)!.content);
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    return { handler, vistos };
  };

  it("X31 / c2154a5: el MISMO message.id 3 veces -> 1 turno y 1 respuesta encolada (Postgres real: scripts/verify-restaurantes-whatsapp-concurrencia)", async () => {
    const f = pmFixture();
    const { handler, vistos } = contador();
    const args = { organizationId: f.organizationId, messageId: "wamid.REPLAY", phone: PHONE, body: "hola", phoneNumberId: "pn1" };
    for (let i = 0; i < 3; i += 1) await handleInboundWhatsAppMessage(f.repo, handler, args);
    expect(vistos).toEqual(["hola"]);
    expect(f.repo.getOutbox().filter((o) => o.eventType === "whatsapp.inbound_reply")).toHaveLength(1);
  });

  it("X32 / 1cd7226: un lote con 5 mensajes de 3 clientes se extrae completo y en orden (ver T-CI02 para el procesamiento)", () => {
    const m = (id: string, from: string, body: string) => ({ id, from, type: "text", text: { body } });
    const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn1" }, messages: [m("1", "5219990000001", "uno"), m("2", "5219990000002", "uno"), m("3", "5219990000001", "dos"), m("4", "5219990000003", "uno"), m("5", "5219990000002", "dos")] } }] }] };
    expect(extractMetaTextMessages(payload).map((x) => x.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(splitMetaPayloadByChannel(payload)).toHaveLength(1);
  });

  it("X32 / 1cd7226: prueba de carga del extractor, 25,000 mensajes en 500 lotes de 50 sin perder ninguno (meta-batch.test.ts:25 del original)", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ id: `m-${i}`, from: "529999999999", type: "text", text: { body: `pedido ${i}` } }));
    const payload = { entry: [{ changes: [{ value: { messages } }] }] };
    let total = 0;
    for (let run = 0; run < 500; run += 1) total += extractMetaTextMessages(payload).length;
    expect(total).toBe(25_000);
  });

  it("X32 / 1cd7226: el lote descarta lo que no es texto valido (imagen, remitente invalido) sin tirar los demas (meta-batch.test.ts:7 del original)", () => {
    const payload = { entry: [{ changes: [{ value: { messages: [{ id: "m1", from: "529999999999", type: "text", text: { body: "uno" } }, { id: "img", from: "529999999999", type: "image" }] } }] }, { changes: [{ value: { statuses: [{ id: "s" }] } }, { value: { messages: [{ id: "m2", from: "529999999999", type: "text", text: { body: "dos" } }, { id: "m3", from: "bad", type: "text", text: { body: "tres" } }] } }] }] };
    expect(extractMetaTextMessages(payload).map((x) => x.id)).toEqual(["m1", "m2"]);
  });
});
