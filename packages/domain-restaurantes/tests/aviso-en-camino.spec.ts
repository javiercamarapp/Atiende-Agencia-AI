// Aviso «su pedido va en camino» (decision del dueno de PM, migracion 107): una sola vez por pedido a domicilio, venga de WhatsApp, de una
// llamada o del panel. Dentro de la ventana de 24 h sale texto libre; fuera de ella solo la plantilla utility APROBADA de la organizacion; sin
// plantilla no se envia nada, el pedido queda «omitido_falta_plantilla» y el dueno recibe UNA notificacion in-app. Repositorio en memoria (sin red).
import { describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { changeOrderStatus } from "../src/order-lifecycle.ts";
import { notifyCustomerOnOrderStatusChangeCore } from "../src/order-notifications.ts";
import { PLANTILLA_EN_CAMINO_SUGERIDA, avisarPedidoEnCamino } from "../src/aviso-en-camino.ts";
import type { ContextoAvisoEnCamino } from "../src/aviso-en-camino.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const CONTEXTO_BASE: ContextoAvisoEnCamino = {
  activo: true,
  ventanaAbierta: false,
  consentimiento: "sin_registro",
  requiereConsentimiento: false,
  avisoWhatsapp: null,
  plantilla: null,
};

async function pedidoEnCamino(opciones: { source?: "web" | "voice" | "whatsapp" | "admin"; contexto?: Partial<ContextoAvisoEnCamino> | null } = {}) {
  const fx = buildRestaurantFixture();
  fx.repo.seedWhatsAppChannel(fx.organizationId, "PHONE_NUMBER_ID_123");
  const order = await createOrder(fx.repo, {
    organizationId: fx.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Ana",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30",
    items: [{ productId: fx.products.cocaCola, requestedQuantity: 1 }],
    source: "web",
  });
  if (opciones.contexto !== null) fx.repo.configurarAvisoEnCamino(fx.organizationId, { ...CONTEXTO_BASE, ...(opciones.contexto ?? {}) });
  // El canal de origen solo importa para el contexto (que da la base); el pedido se crea por web para no depender de las reglas de captura de voz.
  return { fx, order: { ...order, source: opciones.source ?? "voice", status: "en_camino" as const } };
}

type PayloadWhatsApp = {
  to: string;
  phone_number_id: string;
  body: string;
  transaccional?: boolean;
  solo_plantilla?: boolean;
  template?: { name: string; language: string; params: string[] };
};

describe("aviso en camino: base sin la migracion 107", () => {
  it("sin el contexto disponible se conserva el aviso anterior (texto + plantilla declarada, decide el gateway)", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: null });
    expect(await avisarPedidoEnCamino(fx.repo, order)).toBeNull();
    expect(await notifyCustomerOnOrderStatusChangeCore(fx.repo, order)).toEqual({ enqueued: true });
    const payload = fx.repo.getOutbox()[0]?.payload as PayloadWhatsApp;
    expect(payload.body).toMatch(/va en camino/);
    expect(payload.template?.name).toBe("pedido_en_camino");
    expect(payload.solo_plantilla).toBeUndefined();
  });
});

describe("aviso en camino: dentro de la ventana de 24 h", () => {
  it("manda texto libre SIN plantilla y marca el pedido como «texto»", async () => {
    const { fx, order } = await pedidoEnCamino({ source: "whatsapp", contexto: { ventanaAbierta: true, plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    expect(await notifyCustomerOnOrderStatusChangeCore(fx.repo, order)).toEqual({ enqueued: true, como: "texto" });
    const filas = fx.repo.getOutbox();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.dedupeKey).toBe(`order-status:${order.id}:en_camino`);
    const payload = filas[0]?.payload as PayloadWhatsApp;
    expect(payload.to).toBe("+529990001111");
    expect(payload.phone_number_id).toBe("PHONE_NUMBER_ID_123");
    expect(payload.body).toMatch(/va en camino/);
    expect(payload.template).toBeUndefined();
    expect(payload.transaccional).toBe(true);
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBe("texto");
  });

  it("el texto incluye el tiempo estimado cuando la sucursal lo tiene configurado", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { ventanaAbierta: true } });
    vi.spyOn(fx.repo, "findWhatsAppAgentConfig").mockResolvedValue({ deliveryTimeText: "40 a 50 minutos" } as never);
    await avisarPedidoEnCamino(fx.repo, order);
    expect((fx.repo.getOutbox()[0]?.payload as PayloadWhatsApp).body).toMatch(/Tiempo estimado de llegada: 40 a 50 minutos\./);
  });
});

describe("aviso en camino: fuera de la ventana (siempre en pedidos por llamada)", () => {
  it("con la plantilla aprobada de la organizacion manda SOLO la plantilla, con sucursal, folio y tiempo", async () => {
    const { fx, order } = await pedidoEnCamino({ source: "voice", contexto: { plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    vi.spyOn(fx.repo, "findWhatsAppAgentConfig").mockResolvedValue({ deliveryTimeText: "40 a 50 minutos" } as never);
    expect(await notifyCustomerOnOrderStatusChangeCore(fx.repo, { ...order, orderNumber: 1234 })).toEqual({ enqueued: true, como: "plantilla" });
    const payload = fx.repo.getOutbox()[0]?.payload as PayloadWhatsApp;
    expect(payload.template).toEqual({ name: "pedido_en_camino", language: "es_MX", params: ["Francisco de Montejo", "1234", "40 a 50 minutos"] });
    expect(payload.solo_plantilla).toBe(true);
    expect(payload.transaccional).toBe(true);
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBe("plantilla");
  });

  it("respeta el ORDEN de variables registrado en el catalogo (por ejemplo nombre, sucursal, total)", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { plantilla: { nombre: "aviso_salida", idioma: "es_MX", variables: ["nombre", "sucursal", "total"] } } });
    await avisarPedidoEnCamino(fx.repo, order);
    const payload = fx.repo.getOutbox()[0]?.payload as PayloadWhatsApp;
    expect(payload.template?.name).toBe("aviso_salida");
    expect(payload.template?.params).toEqual(["Ana", "Francisco de Montejo", `$${order.total.toFixed(2)} MXN`]);
  });

  it("sin dato de tiempo ni folio las variables nunca van vacias (Meta las rechazaria)", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    await avisarPedidoEnCamino(fx.repo, { ...order, orderNumber: undefined });
    const params = (fx.repo.getOutbox()[0]?.payload as PayloadWhatsApp).template?.params ?? [];
    expect(params[1]).toBe(order.id.slice(0, 8).toUpperCase());
    expect(params[2]).toBe("unos minutos");
  });

  it("SIN plantilla aprobada no encola nada, marca «omitido_falta_plantilla» y avisa al dueno UNA sola vez", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { plantilla: null } });
    expect(await notifyCustomerOnOrderStatusChangeCore(fx.repo, order)).toEqual({ enqueued: false, reason: "falta_plantilla" });
    expect(fx.repo.getOutbox()).toHaveLength(0);
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBe("omitido_falta_plantilla");
    // Un segundo pedido de la misma organizacion: la notificacion usa la misma clave de dedupe (una por organizacion).
    const otro = await createOrder(fx.repo, {
      organizationId: fx.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Luis",
      customerPhone: "9990002222",
      customerAddress: "Calle 60 #1",
      items: [{ productId: fx.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });
    await avisarPedidoEnCamino(fx.repo, { ...otro, status: "en_camino" });
    const avisos = fx.repo.getNotificacionesFaltaPlantillaEnCamino();
    expect(avisos.length).toBeGreaterThanOrEqual(1);
    expect(new Set(avisos.map((a) => `${a.organizationId}:${a.clave}`)).size).toBe(1);
  });

  it("una plantilla que pide una variable que el aviso no calcula se trata como falta de plantilla (nada sale)", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { plantilla: { nombre: "pedido_en_camino", idioma: "es_MX", variables: ["sucursal", "placas"] } } });
    expect(await avisarPedidoEnCamino(fx.repo, order)).toEqual({ enqueued: false, reason: "falta_plantilla" });
    expect(fx.repo.getOutbox()).toHaveLength(0);
  });
});

describe("aviso en camino: reglas de envio", () => {
  it("una sola vez por pedido: un pedido ya avisado no se vuelve a encolar", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { ventanaAbierta: true } });
    await avisarPedidoEnCamino(fx.repo, order);
    expect(await avisarPedidoEnCamino(fx.repo, order)).toEqual({ enqueued: false, reason: "ya_avisado" });
    expect(fx.repo.getOutbox()).toHaveLength(1);
  });

  it("apagado por la organizacion: no sale y queda «omitido_desactivado»", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { activo: false, ventanaAbierta: true } });
    expect(await avisarPedidoEnCamino(fx.repo, order)).toEqual({ enqueued: false, reason: "desactivado" });
    expect(fx.repo.getOutbox()).toHaveLength(0);
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBe("omitido_desactivado");
  });

  it("una BAJA (consentimiento revocado) gana aunque la ventana este abierta", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { ventanaAbierta: true, consentimiento: "revocado" } });
    expect(await avisarPedidoEnCamino(fx.repo, order)).toEqual({ enqueued: false, reason: "baja" });
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBe("omitido_baja");
  });

  it("pedido capturado por el personal: sin consentimiento no se avisa; con consentimiento vigente o del pedido, si", async () => {
    const sin = await pedidoEnCamino({ source: "admin", contexto: { requiereConsentimiento: true, plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    expect(await avisarPedidoEnCamino(sin.fx.repo, sin.order)).toEqual({ enqueued: false, reason: "sin_consentimiento" });
    expect(sin.fx.repo.getAvisoEnCaminoMarca(sin.order.id)).toBe("omitido_sin_consentimiento");

    const noDelPedido = await pedidoEnCamino({ source: "admin", contexto: { requiereConsentimiento: true, consentimiento: "vigente", avisoWhatsapp: false, plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    expect(await avisarPedidoEnCamino(noDelPedido.fx.repo, noDelPedido.order)).toEqual({ enqueued: false, reason: "sin_consentimiento" });

    const vigente = await pedidoEnCamino({ source: "admin", contexto: { requiereConsentimiento: true, consentimiento: "vigente", plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    expect(await avisarPedidoEnCamino(vigente.fx.repo, vigente.order)).toEqual({ enqueued: true, como: "plantilla" });

    const delPedido = await pedidoEnCamino({ source: "admin", contexto: { requiereConsentimiento: true, avisoWhatsapp: true, plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    expect(await avisarPedidoEnCamino(delPedido.fx.repo, delPedido.order)).toEqual({ enqueued: true, como: "plantilla" });
  });

  it("sin canal de WhatsApp conectado no hay a donde enviar (no se marca nada)", async () => {
    const fx = buildRestaurantFixture();
    const order = await createOrder(fx.repo, {
      organizationId: fx.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Ana",
      customerPhone: "9990001111",
      customerAddress: "Calle 80 #30",
      items: [{ productId: fx.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });
    fx.repo.configurarAvisoEnCamino(fx.organizationId, { ...CONTEXTO_BASE, ventanaAbierta: true });
    expect(await avisarPedidoEnCamino(fx.repo, { ...order, status: "en_camino" })).toEqual({ enqueued: false, reason: "no_whatsapp_channel" });
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBeNull();
  });

  it("una sucursal solo venta local (Galerias) no aplica", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { ventanaAbierta: true } });
    fx.repo.seedBranchPolicy(fx.propertyId, { soloVentaLocal: true });
    expect(await avisarPedidoEnCamino(fx.repo, order)).toEqual({ enqueued: false, reason: "no_aplica" });
    expect(fx.repo.getOutbox()).toHaveLength(0);
  });

  it("los demas estados (preparando, entregado) siguen igual que antes", async () => {
    const { fx, order } = await pedidoEnCamino({ contexto: { plantilla: null } });
    expect(await notifyCustomerOnOrderStatusChangeCore(fx.repo, { ...order, status: "preparando" })).toEqual({ enqueued: true });
    expect(await notifyCustomerOnOrderStatusChangeCore(fx.repo, { ...order, status: "entregado" })).toEqual({ enqueued: true });
    expect(fx.repo.getOutbox()).toHaveLength(2);
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBeNull();
  });

  it("de punta a punta: el staff pasa el pedido de preparando a en_camino y sale la plantilla", async () => {
    const { fx, order } = await pedidoEnCamino({ source: "voice", contexto: { plantilla: PLANTILLA_EN_CAMINO_SUGERIDA } });
    const guardado = await fx.repo.findOrderById(fx.organizationId, order.id);
    const preparando = await changeOrderStatus(fx.repo, fx.organizationId, guardado!, "preparando");
    await changeOrderStatus(fx.repo, fx.organizationId, preparando, "en_camino");
    const enCamino = fx.repo.getOutbox().find((f) => f.dedupeKey === `order-status:${order.id}:en_camino`);
    expect((enCamino?.payload as PayloadWhatsApp | undefined)?.template?.name).toBe("pedido_en_camino");
    expect(fx.repo.getAvisoEnCaminoMarca(order.id)).toBe("plantilla");
  });
});
