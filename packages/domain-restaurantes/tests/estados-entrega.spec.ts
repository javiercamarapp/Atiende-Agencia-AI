// Estados de entrega de WhatsApp (statuses de Meta), migracion 066: guardar el wamid al enviar y procesar delivered/read/failed.
// Dos mitades: (1) la logica de dominio contra el repositorio en memoria (avance, idempotencia, aviso y correo de respaldo) y (2) el adaptador
// Postgres contra AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion real): la base sin la 066 nunca tumba el webhook.
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { notifyCustomerOnOrderStatusChangeCore } from "../src/order-notifications.ts";
import { createRestaurantesMessagingOutboxPort } from "../src/whatsapp/outbox-adapter.ts";
import { UMBRAL_AVISOS_AGRUPADOS, procesarEstadosEntrega } from "../src/whatsapp/estados-entrega.ts";
import type { EmisionEntregaFallida } from "../src/whatsapp/estados-entrega.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { PostgresWhatsappKpiRepository, resumirWhatsappEntrega } from "../src/whatsapp-kpi/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { CreateOrderInput } from "../src/types.ts";

type Fixture = ReturnType<typeof buildRestaurantFixture>;

async function pedido(fixture: Fixture, extra: Partial<CreateOrderInput> = {}) {
  return createOrder(fixture.repo, {
    organizationId: fixture.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Deb",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30",
    items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
    source: "web",
    ...extra,
  });
}

/** Encola el aviso `en_camino` del pedido, lo reclama y lo marca enviado con el wamid (lo que hace el despachador). */
async function avisoEnviado(fixture: Fixture, order: Awaited<ReturnType<typeof pedido>>, wamid: string, enviadoComo: "texto" | "plantilla" = "texto"): Promise<string> {
  const enCamino = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "pending", "en_camino");
  await notifyCustomerOnOrderStatusChangeCore(fixture.repo, enCamino!);
  const [fila] = await fixture.repo.claimMessagingOutboxBatch(5, 120);
  await fixture.repo.markMessagingOutboxSent(fila!.id, { providerMessageId: wamid, enviadoComo });
  return fila!.id;
}

function conEmision() {
  const emisiones: EmisionEntregaFallida[] = [];
  return { emisiones, emitir: async (e: EmisionEntregaFallida) => void emisiones.push(e) };
}

const FALLO = { status: "failed", errorCode: 131047, errorTitle: "Re-engagement message" } as const;

describe("procesarEstadosEntrega (dominio, repositorio en memoria)", () => {
  it("avanza sent -> delivered -> read y no retrocede; repetir un estado no cambia nada", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    const id = await avisoEnviado(fixture, await pedido(fixture), "wamid.A");
    const { emitir, emisiones } = conEmision();
    const sinError = { errorCode: null, errorTitle: null };

    const r1 = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.A", status: "read", ...sinError }, { wamid: "wamid.A", status: "delivered", ...sinError }, { wamid: "wamid.A", status: "read", ...sinError }], { emitir });
    expect(r1).toMatchObject({ recibidos: 3, actualizados: 1, sinCambio: 2, fallidos: 0, errores: 0 });
    expect(fixture.repo.getOutbox().find((o) => o.id === id)).toMatchObject({ providerMessageId: "wamid.A", deliveryStatus: "read" });
    expect(emisiones).toHaveLength(0);
  });

  it("failed gana, conserva su primer error y avisa UNA sola vez (idempotente ante el reintento de Meta)", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    const id = await avisoEnviado(fixture, await pedido(fixture), "wamid.B");
    const { emitir, emisiones } = conEmision();

    await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.B", status: "delivered", errorCode: null, errorTitle: null }, { wamid: "wamid.B", ...FALLO }], { emitir });
    const reintento = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.B", ...FALLO }, { wamid: "wamid.B", status: "read", errorCode: null, errorTitle: null }], { emitir });

    expect(reintento).toMatchObject({ actualizados: 0, sinCambio: 2, fallidos: 0 });
    expect(fixture.repo.getOutbox().find((o) => o.id === id)).toMatchObject({ deliveryStatus: "failed", deliveryErrorCode: 131047, status: "sent" });
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "restaurantes.whatsapp.entrega_fallida_pedido",
      organizationId: fixture.organizationId,
      clave: id,
      parametros: { motivo: "fuera_de_ventana_plantilla_sin_usar" },
      entidadTipo: "messaging_outbox",
      entidadId: id,
    });
    // Sin PII: ni telefono ni nombre en lo que se emite.
    expect(JSON.stringify(emisiones)).not.toMatch(/9990001111|Deb|Calle/);
  });

  it("131047 con la plantilla ya usada se explica como fuera_de_ventana a secas", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    await avisoEnviado(fixture, await pedido(fixture), "wamid.C", "plantilla");
    const { emitir, emisiones } = conEmision();
    await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.C", ...FALLO }], { emitir });
    expect(emisiones[0]?.parametros).toEqual({ motivo: "fuera_de_ventana" });
  });

  it("respalda por correo el aviso de estado de un pedido cuyo cliente dejo correo (una vez por pedido y estado), sin reintentar el WhatsApp", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    await avisoEnviado(fixture, await pedido(fixture, { customerEmail: "cliente@example.com" }), "wamid.D");
    const { emitir } = conEmision();

    const r1 = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.D", ...FALLO }], { emitir });
    const r2 = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.D", ...FALLO }], { emitir });

    expect(r1.correosEncolados).toBe(1);
    expect(r2.correosEncolados).toBe(0);
    const correos = fixture.repo.getOutbox().filter((o) => o.eventType === "order.status.whatsapp_fallido.email");
    expect(correos).toHaveLength(1);
    expect(correos[0]).toMatchObject({ channel: "email", dedupeKey: expect.stringMatching(/^order-status-email:.+:en_camino$/) });
    expect(correos[0]?.payload).toMatchObject({ to: "cliente@example.com", transaccional: true });
    expect((correos[0]?.payload as { text: string }).text).toMatch(/va en camino/);
    // El WhatsApp fallido NO se reencola: solo el original, ya enviado.
    expect(fixture.repo.getOutbox().filter((o) => o.channel === "whatsapp")).toHaveLength(1);
  });

  it("sin correo del cliente no encola ningun respaldo, pero el aviso in-app sale igual", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    await avisoEnviado(fixture, await pedido(fixture), "wamid.E");
    const { emitir, emisiones } = conEmision();
    const r = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.E", ...FALLO }], { emitir });
    expect(r.correosEncolados).toBe(0);
    expect(emisiones).toHaveLength(1);
    expect(fixture.repo.getOutbox().filter((o) => o.eventType === "order.status.whatsapp_fallido.email")).toHaveLength(0);
  });

  it("un mensaje que no es aviso de pedido avisa con el evento de la conversacion y no genera correo", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    await fixture.repo.enqueueMessagingOutbox(fixture.organizationId, "whatsapp", "whatsapp.inbound_reply", "reply:1", { to: "+529990001111", phone_number_id: "PN-1", body: "hola", transaccional: true });
    const [fila] = await fixture.repo.claimMessagingOutboxBatch(5, 120);
    await fixture.repo.markMessagingOutboxSent(fila!.id, { providerMessageId: "wamid.F", enviadoComo: "texto" });
    const { emitir, emisiones } = conEmision();
    const r = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.F", status: "failed", errorCode: 131026, errorTitle: "Message undeliverable" }], { emitir });
    expect(r.correosEncolados).toBe(0);
    expect(emisiones[0]).toMatchObject({ evento: "restaurantes.whatsapp.entrega_fallida", parametros: { motivo: "numero_no_entregable" } });
  });

  it(`agrupa: pasadas ${UMBRAL_AVISOS_AGRUPADOS} entregas fallidas en una hora, emite UN aviso agrupado por hora en vez de uno por mensaje`, async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    const total = UMBRAL_AVISOS_AGRUPADOS + 3;
    for (let i = 0; i < total; i++) {
      await fixture.repo.enqueueMessagingOutbox(fixture.organizationId, "whatsapp", "whatsapp.inbound_reply", `reply:${i}`, { to: "+529990001111", phone_number_id: "PN-1", body: "x", transaccional: true });
    }
    const filas = await fixture.repo.claimMessagingOutboxBatch(50, 120);
    for (const [i, f] of filas.entries()) await fixture.repo.markMessagingOutboxSent(f.id, { providerMessageId: `wamid.G${i}`, enviadoComo: "texto" });
    const { emitir, emisiones } = conEmision();
    const ahora = () => new Date("2026-10-04T15:20:00Z");
    await procesarEstadosEntrega(fixture.repo, fixture.organizationId, filas.map((_, i) => ({ wamid: `wamid.G${i}`, status: "failed" as const, errorCode: 131047, errorTitle: null })), { emitir, ahora });

    const individuales = emisiones.filter((e) => e.evento === "restaurantes.whatsapp.entrega_fallida");
    const agrupados = emisiones.filter((e) => e.evento === "restaurantes.whatsapp.entregas_fallidas_varias");
    expect(individuales).toHaveLength(UMBRAL_AVISOS_AGRUPADOS);
    expect(agrupados).toHaveLength(total - UMBRAL_AVISOS_AGRUPADOS);
    // Misma clave de dedupe (organizacion + hora UTC): la base los colapsa en UNA fila por destinatario.
    expect(new Set(agrupados.map((e) => e.clave)).size).toBe(1);
    expect(agrupados[0]?.clave).toBe(`${fixture.organizationId}:2026-10-0415`);
    expect(agrupados.at(-1)?.parametros).toEqual({ cantidad: total });
  });

  it("CROSS-TENANT: el wamid de una organizacion no se registra con otra (desconocido, sin cambios ni avisos)", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    const id = await avisoEnviado(fixture, await pedido(fixture), "wamid.H");
    const { emitir, emisiones } = conEmision();
    const r = await procesarEstadosEntrega(fixture.repo, "00000000-0000-0000-0000-00000000dead", [{ wamid: "wamid.H", ...FALLO }], { emitir });
    expect(r).toMatchObject({ desconocidos: 1, actualizados: 0, fallidos: 0 });
    expect(fixture.repo.getOutbox().find((o) => o.id === id)).toMatchObject({ deliveryStatus: "sent" });
    expect(emisiones).toHaveLength(0);
  });

  it("un wamid desconocido (mensaje enviado por otra via) se ignora sin lanzar", async () => {
    const fixture = buildRestaurantFixture();
    const { emitir } = conEmision();
    const r = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.NADA", ...FALLO }], { emitir });
    expect(r).toMatchObject({ recibidos: 1, desconocidos: 1, errores: 0 });
  });

  it("base SIN la migracion 066: no guarda wamid, los statuses se ignoran y nada lanza", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    fixture.repo.estadosEntregaDisponibles = false;
    const id = await avisoEnviado(fixture, await pedido(fixture), "wamid.I");
    const fila = fixture.repo.getOutbox().find((o) => o.id === id);
    expect(fila?.status).toBe("sent");
    expect(fila?.providerMessageId ?? null).toBeNull();
    const { emitir, emisiones } = conEmision();
    const r = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.I", ...FALLO }], { emitir });
    expect(r).toMatchObject({ noDisponibles: 1, actualizados: 0, errores: 0 });
    expect(emisiones).toHaveLength(0);
  });

  it("un error inesperado del repositorio en un status no tumba los demas", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    await avisoEnviado(fixture, await pedido(fixture), "wamid.J");
    const original = fixture.repo.registrarEstadoEntregaWhatsapp.bind(fixture.repo);
    let llamada = 0;
    fixture.repo.registrarEstadoEntregaWhatsapp = async (org, e) => {
      llamada++;
      if (llamada === 1) throw Object.assign(new Error("boom"), { code: "XX000" });
      return original(org, e);
    };
    const { emitir, emisiones } = conEmision();
    const r = await procesarEstadosEntrega(fixture.repo, fixture.organizationId, [{ wamid: "wamid.X", ...FALLO }, { wamid: "wamid.J", ...FALLO }], { emitir });
    expect(r).toMatchObject({ errores: 1, fallidos: 1 });
    expect(emisiones).toHaveLength(1);
  });

  it("el adaptador del puerto entrega el wamid a markMessagingOutboxSent (lo que cierra el ciclo con el despachador)", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PN-1");
    await fixture.repo.enqueueMessagingOutbox(fixture.organizationId, "whatsapp", "whatsapp.inbound_reply", "reply:puerto", { to: "+529990001111", phone_number_id: "PN-1", body: "x", transaccional: true });
    const puerto = createRestaurantesMessagingOutboxPort(fixture.repo);
    const [item] = await puerto.claimBatch(1, 120);
    await puerto.markSent(item!.id, { providerMessageId: "wamid.PUERTO", enviadoComo: "botones" });
    expect(fixture.repo.getOutbox().find((o) => o.id === item!.id)).toMatchObject({ providerMessageId: "wamid.PUERTO", enviadoComo: "botones", deliveryStatus: "sent" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Adaptador Postgres: la base real va ATRAS de las migraciones. AbortAwareFakeSession deja la sesion ABORTADA tras un error, igual que Postgres.
// ---------------------------------------------------------------------------------------------------------------------------------------
function funcionInexistente(firma: string): Error & { code: string } {
  const err = new Error(`function ${firma} does not exist`) as Error & { code: string };
  err.code = "42883";
  return err;
}

const ORG = "00000000-0000-0000-0000-0000000000a1";
const OUTBOX_ID = "00000000-0000-0000-0000-0000000000b1";

describe("PostgresRestaurantesRepository: estados de entrega contra la base SIN migrar (AbortAwareFakeSession)", () => {
  it("registrarEstadoEntregaWhatsapp: 42883 -> no_disponible y la sesion SIGUE utilizable (SAVEPOINT + ROLLBACK TO SAVEPOINT)", async () => {
    const db = new AbortAwareFakeSession([
      { match: /registrar_estado_entrega_whatsapp/, respond: () => funcionInexistente("restaurantes.registrar_estado_entrega_whatsapp(uuid, text, text, integer, text)") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresRestaurantesRepository(db);
    const r = await repo.registrarEstadoEntregaWhatsapp(ORG, { wamid: "wamid.X", status: "failed", errorCode: 131047, errorTitle: null });
    expect(r.resultado).toBe("no_disponible");
    expect(db.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // Sin el SAVEPOINT esta consulta fallaria con 25P02 y el COMMIT haria ROLLBACK de todo el webhook.
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("registrarEstadoEntregaWhatsapp: base migrada -> mapea la fila (pedido ligado, motivo, fallos de la ultima hora)", async () => {
    const db = new AbortAwareFakeSession([
      {
        match: /registrar_estado_entrega_whatsapp/,
        respond: () => [{ outbox_id: OUTBOX_ID, resultado: "actualizado", estado: "failed", event_type: "order.status.en_camino", failure_reason: "fuera_de_ventana", order_id: "00000000-0000-0000-0000-0000000000c1", order_status: "en_camino", fallidas_ultima_hora: "3", pedido_correo: "cliente@example.com", pedido_cliente: "Deb", pedido_sucursal: "Fco. de Montejo", pedido_total: "45.00" }],
      },
    ]);
    const r = await new PostgresRestaurantesRepository(db).registrarEstadoEntregaWhatsapp(ORG, { wamid: "wamid.Y", status: "failed", errorCode: 131047, errorTitle: "t" });
    expect(r).toEqual({ resultado: "actualizado", outboxId: OUTBOX_ID, estado: "failed", eventType: "order.status.en_camino", motivoFallo: "fuera_de_ventana", orderId: "00000000-0000-0000-0000-0000000000c1", orderStatus: "en_camino", fallidasUltimaHora: 3, respaldoCorreo: { to: "cliente@example.com", clienteNombre: "Deb", sucursal: "Fco. de Montejo", total: 45 } });
  });

  it("registrarEstadoEntregaWhatsapp: un error que NO es de base sin migrar se repropaga, pero la sesion queda utilizable", async () => {
    const permiso = Object.assign(new Error("permission denied"), { code: "42501" });
    const db = new AbortAwareFakeSession([
      { match: /registrar_estado_entrega_whatsapp/, respond: () => permiso },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresRestaurantesRepository(db).registrarEstadoEntregaWhatsapp(ORG, { wamid: "w", status: "read", errorCode: null, errorTitle: null })).rejects.toBe(permiso);
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("markMessagingOutboxSent con wamid: 42883 -> cierra el mensaje con la funcion de siempre dentro de la MISMA transaccion (nunca 25P02)", async () => {
    const db = new AbortAwareFakeSession([
      { match: /complete_messaging_outbox_sent\(\$1, \$2, \$3\)/, respond: () => funcionInexistente("restaurantes.complete_messaging_outbox_sent(uuid, text, text)") },
      { match: /complete_messaging_outbox_sent\(\$1\)/, respond: () => [] },
    ]);
    await new PostgresRestaurantesRepository(db).markMessagingOutboxSent(OUTBOX_ID, { providerMessageId: "wamid.Z", enviadoComo: "texto" });
    expect(db.calls.filter((c) => c.includes("complete_messaging_outbox_sent"))).toHaveLength(2);
    expect(db.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("markMessagingOutboxSent sin detalle usa directo la funcion de un argumento (sin SAVEPOINT)", async () => {
    const db = new AbortAwareFakeSession([{ match: /complete_messaging_outbox_sent\(\$1\)/, respond: () => [] }]);
    await new PostgresRestaurantesRepository(db).markMessagingOutboxSent(OUTBOX_ID);
    expect(db.calls.some((c) => c.includes("savepoint"))).toBe(false);
  });
});

describe("PostgresWhatsappKpiRepository.getEntregaDiaria contra la base SIN la 066 (AbortAwareFakeSession)", () => {
  it("42883 -> disponible:false y la sesion sigue utilizable (SAVEPOINT); la base migrada mapea la serie", async () => {
    const sinMigrar = new AbortAwareFakeSession([
      { match: /whatsapp_entrega_diaria/, respond: () => funcionInexistente("restaurantes.whatsapp_entrega_diaria(uuid, uuid, date, date)") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await new PostgresWhatsappKpiRepository(sinMigrar).getEntregaDiaria(ORG, ORG, "2026-03-10", "2026-03-10")).toEqual({ disponible: false, valor: [] });
    await expect(sinMigrar.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });

    const migrada = new AbortAwareFakeSession([
      { match: /whatsapp_entrega_diaria/, respond: () => [{ fecha: "2026-03-10", enviados: 5, entregados: 3, leidos: 1, fallidos: 2, sin_estado: "0", fallos_por_motivo: { fuera_de_ventana: 2 } }] },
    ]);
    const l = await new PostgresWhatsappKpiRepository(migrada).getEntregaDiaria(ORG, ORG, "2026-03-10", "2026-03-10");
    expect(l.valor).toEqual([{ fecha: "2026-03-10", enviados: 5, entregados: 3, leidos: 1, fallidos: 2, sinEstado: 0, fallosPorMotivo: { fuera_de_ventana: 2 } }]);
    expect(resumirWhatsappEntrega(l.valor)).toMatchObject({ entregaPct: 60, lecturaPct: 33.3 });
  });
});
