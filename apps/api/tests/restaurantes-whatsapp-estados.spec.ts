// Estados de entrega de WhatsApp (statuses de Meta) de punta a punta con el simulador de Meta (`MetaCloudSimulator`, nunca la red real):
// envio por el despachador real -> wamid guardado en el outbox -> status delivered/failed firmado por el simulador y POSTeado al webhook REAL
// -> estado de entrega, notificacion in-app (sin PII) y respaldo por correo. Un webhook de SOLO statuses no toca el turno del agente.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrder, notifyCustomerOnOrderStatusChangeCore } from "@atiende/domain-restaurantes";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { MetaCloudSimulator, serveFetchHandler } from "@atiende/whatsapp-gateway/testing";
import type { RunningServer } from "@atiende/whatsapp-gateway/testing";
import { buildApp } from "../src/app.ts";
import { dispatchWhatsAppVertical } from "../src/routes/internal/whatsapp-dispatch.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const PNID = "1234567890"; // el numero que buildTestDeps conecta a la organizacion
const TOKEN = "tok-sim";
const TELEFONO = "9990001111";
const WEBHOOK = "/v1/restaurantes/whatsapp/webhook";

let sim: MetaCloudSimulator;
let puente: RunningServer;
let turnos: number;

function postFirmado(body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

async function montar() {
  const base = await buildTestDeps();
  const { deps: conEmision, emisiones } = conEmisiones(base.deps);
  const contador: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      turnos++;
      return { reply: "ok", orderId: null, propertyId: null };
    },
  };
  const deps = {
    ...conEmision,
    turnHandler: contador,
    whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient: new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl }) }),
  };
  const app = buildApp(deps);
  // El simulador POSTea sus webhooks (firmados con el secreto de la app) a ESTE servidor, que los pasa a la app REAL.
  puente = await serveFetchHandler((req) => app.fetch(req));
  sim.setWebhookUrl(`${puente.baseUrl}${WEBHOOK}`);
  return { ...base, deps, app, emisiones };
}

/** Pedido con correo en `en_camino`, su aviso encolado y ENVIADO por el despachador real al simulador (ventana de 24 h abierta). */
async function avisoDePedidoEnviado(ctx: Awaited<ReturnType<typeof montar>>) {
  const order = await createOrder(ctx.restaurantesRepo, {
    organizationId: ctx.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente de Prueba",
    customerPhone: TELEFONO,
    customerAddress: "Calle 80 #30",
    customerEmail: "cliente@example.com",
    items: [{ productId: ctx.products.cocaCola!, requestedQuantity: 1 }],
    source: "web",
  });
  const enCamino = await ctx.restaurantesRepo.updateOrderStatus(ctx.organizationId, order.id, "pending", "en_camino");
  await notifyCustomerOnOrderStatusChangeCore(ctx.restaurantesRepo, enCamino!);
  await sim.deliverText(`52${TELEFONO}`, "abre la ventana de 24 h"); // un mensaje del cliente: Meta solo entrega texto libre dentro de la ventana
  turnos = 0;
  const resultado = await dispatchWhatsAppVertical(ctx.deps, "restaurantes", 10);
  if ("ok" in resultado) throw new Error(`el despacho fallo: ${resultado.error}`);
  const fila = ctx.restaurantesRepo.getOutbox().find((o) => o.eventType === "order.status.en_camino");
  if (!fila) throw new Error("no se encolo el aviso en_camino");
  return { order, fila };
}

beforeEach(async () => {
  turnos = 0;
  sim = new MetaCloudSimulator({ appSecret: TEST_ENV.whatsappAppSecret, accessToken: TOKEN, phoneNumberId: PNID });
  await sim.start();
});
afterEach(async () => {
  await sim.stop();
  await puente?.close();
});

describe("estados de entrega de WhatsApp (restaurantes) con el simulador de Meta", () => {
  it("envio -> wamid guardado -> delivered -> read: el estado avanza y no retrocede, sin notificaciones", async () => {
    const ctx = await montar();
    const { fila } = await avisoDePedidoEnviado(ctx);
    expect(fila).toMatchObject({ status: "sent", deliveryStatus: "sent", enviadoComo: "texto" });
    expect(fila.providerMessageId).toBeTruthy();
    const wamid = fila.providerMessageId!;

    expect((await sim.deliverStatus(wamid, "read")).status).toBe(200);
    expect((await sim.deliverStatus(wamid, "delivered")).status).toBe(200); // llega tarde: no baja de read
    expect(ctx.restaurantesRepo.getOutbox().find((o) => o.id === fila.id)?.deliveryStatus).toBe("read");
    expect(ctx.emisiones.filter((e) => e.evento.startsWith("restaurantes.whatsapp.entrega"))).toHaveLength(0);
  });

  it("status failed (131047): marca el codigo, emite UNA notificacion in-app sin PII y encola el respaldo por correo; el reintento de Meta no duplica nada", async () => {
    const ctx = await montar();
    const { fila, order } = await avisoDePedidoEnviado(ctx);
    const wamid = fila.providerMessageId!;

    const entrega = await sim.deliverStatus(wamid, "failed", { code: 131047, title: "Re-engagement message" });
    expect(entrega.status).toBe(200);
    await sim.replay(entrega); // Meta reintenta el mismo POST firmado

    const actual = ctx.restaurantesRepo.getOutbox().find((o) => o.id === fila.id)!;
    expect(actual).toMatchObject({ status: "sent", deliveryStatus: "failed", deliveryErrorCode: 131047, deliveryErrorTitle: "Re-engagement message" });

    const avisos = ctx.emisiones.filter((e) => e.evento.startsWith("restaurantes.whatsapp.entrega"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      evento: "restaurantes.whatsapp.entrega_fallida_pedido",
      organizationId: ctx.organizationId,
      categoria: "salud",
      severidad: "atencion",
      enlace: "/restaurantes/{orgSlug}/pedidos",
      dedupeKey: `restaurantes.whatsapp.entrega_fallida_pedido:${fila.id}`,
    });
    expect(JSON.stringify(avisos)).not.toMatch(new RegExp(`${TELEFONO}|Cliente de Prueba|cliente@example|Calle 80`));

    const correos = ctx.restaurantesRepo.getOutbox().filter((o) => o.eventType === "order.status.whatsapp_fallido.email");
    expect(correos).toHaveLength(1);
    expect(correos[0]).toMatchObject({ channel: "email", dedupeKey: `order-status-email:${order.id}:en_camino` });
    expect(correos[0]?.payload).toMatchObject({ to: "cliente@example.com", transaccional: true });
    // El WhatsApp fallido NO se reintenta: no hay ninguna fila de WhatsApp nueva.
    expect(ctx.restaurantesRepo.getOutbox().filter((o) => o.channel === "whatsapp" && o.eventType === "order.status.en_camino")).toHaveLength(1);
  });

  it("un webhook de SOLO statuses responde 200 y NO invoca el turno del agente ni encola una respuesta", async () => {
    const ctx = await montar();
    const { fila } = await avisoDePedidoEnviado(ctx);
    const antes = ctx.restaurantesRepo.getOutbox().length;

    const res = await ctx.app.request(WEBHOOK, postFirmado({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, statuses: [{ id: fila.providerMessageId, status: "delivered", timestamp: "1700000000", recipient_id: `52${TELEFONO}` }] } }] }] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(turnos).toBe(0);
    expect(ctx.restaurantesRepo.getOutbox()).toHaveLength(antes);
    expect(ctx.restaurantesRepo.getOutbox().find((o) => o.id === fila.id)?.deliveryStatus).toBe("delivered");
  });

  it("un webhook MIXTO (mensaje del cliente + status) procesa las dos cosas: el turno corre y el estado avanza", async () => {
    const ctx = await montar();
    const { fila } = await avisoDePedidoEnviado(ctx);
    const res = await ctx.app.request(
      WEBHOOK,
      postFirmado({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, messages: [{ id: "wamid.IN1", from: `52${TELEFONO}`, type: "text", text: { body: "hola" } }], statuses: [{ id: fila.providerMessageId, status: "read", timestamp: "1700000000" }] } }] }] }),
    );
    expect(res.status).toBe(200);
    expect(turnos).toBe(1);
    expect(ctx.restaurantesRepo.getOutbox().find((o) => o.id === fila.id)?.deliveryStatus).toBe("read");
  });

  it("statuses de un phone_number_id desconocido se ignoran con 200: ningun wamid ajeno cambia nada", async () => {
    const ctx = await montar();
    const { fila } = await avisoDePedidoEnviado(ctx);
    const res = await ctx.app.request(WEBHOOK, postFirmado({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-de-otro-tenant" }, statuses: [{ id: fila.providerMessageId, status: "failed", errors: [{ code: 131047, title: "x" }] }] } }] }] }));
    expect(res.status).toBe(200);
    expect(ctx.restaurantesRepo.getOutbox().find((o) => o.id === fila.id)?.deliveryStatus).toBe("sent");
    expect(ctx.emisiones.filter((e) => e.evento.startsWith("restaurantes.whatsapp.entrega"))).toHaveLength(0);
  });

  it("un status con wamid desconocido (mensaje enviado por otra via) responde 200 sin tocar nada", async () => {
    const ctx = await montar();
    const res = await ctx.app.request(WEBHOOK, postFirmado({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, statuses: [{ id: "wamid.NO-ES-NUESTRO", status: "failed", errors: [{ code: 131026, title: "x" }] }] } }] }] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ctx.emisiones).toHaveLength(0);
  });

  it("base SIN la migracion 066: el envio sigue (sin wamid) y el webhook de statuses responde 200 sin avisos ni errores", async () => {
    const ctx = await montar();
    ctx.restaurantesRepo.estadosEntregaDisponibles = false;
    const { fila } = await avisoDePedidoEnviado(ctx);
    expect(fila.status).toBe("sent");
    expect(fila.providerMessageId ?? null).toBeNull();

    const msg = sim.lastSentTo(`52${TELEFONO}`);
    expect(msg).toBeDefined();
    const res = await sim.deliverStatus(msg!.id, "failed", { code: 131047, title: "Re-engagement message" });
    expect(res.status).toBe(200);
    expect(ctx.emisiones.filter((e) => e.evento.startsWith("restaurantes.whatsapp.entrega"))).toHaveLength(0);
  });

  it("la firma sigue mandando: un status con firma falsa se rechaza con 401 y no cambia nada", async () => {
    const ctx = await montar();
    const { fila } = await avisoDePedidoEnviado(ctx);
    const res = await ctx.app.request(WEBHOOK, { ...postFirmado({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, statuses: [{ id: fila.providerMessageId, status: "failed" }] } }] }] }), headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" } });
    expect(res.status).toBe(401);
    expect(ctx.restaurantesRepo.getOutbox().find((o) => o.id === fila.id)?.deliveryStatus).toBe("sent");
  });
});
