// El pin de WhatsApp o el link de Maps que da el cliente viaja con el pedido hasta el repartidor (chats reales de T7).
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { formatLocationMessage, formatUbicacionEntregaNota, latestDeliveryPin, parseMapsLink, parseUbicacionEntregaNota } from "../src/whatsapp/location.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

describe("parseMapsLink", () => {
  it.each([
    ["https://www.google.com/maps/place/Casa/@21.012345,-89.601234,17z/data=!3m1", 21.012345, -89.601234],
    ["mira https://www.google.com/maps?q=21.0165,-89.596 gracias", 21.0165, -89.596],
    ["https://www.google.com/maps/search/?api=1&query=21.02%2C-89.55", 21.02, -89.55],
    ["https://maps.google.com/?ll=21.0,-89.6", 21.0, -89.6],
    ["https://www.google.com/maps/place/x/data=!3d21.01!4d-89.62", 21.01, -89.62],
  ])("%s trae coordenadas", (texto, lat, lng) => {
    expect(parseMapsLink(texto)).toEqual({ fuente: "link", lat, lng });
  });

  it("un link corto sin coordenadas se guarda tal cual, sin seguir redirecciones", () => {
    expect(parseMapsLink("es aquí https://maps.app.goo.gl/AbC123xyz?g_st=ic.")).toEqual({ fuente: "link_corto", url: "https://maps.app.goo.gl/AbC123xyz" });
  });

  it("ignora enlaces que no son de Maps, hosts parecidos y coordenadas fuera de rango", () => {
    expect(parseMapsLink("https://evil.example/maps?q=21,-89")).toBeNull();
    expect(parseMapsLink("https://maps.app.goo.gl.evil.example/abc")).toBeNull();
    expect(parseMapsLink("https://www.google.com/search?q=21.0,-89.6")).toBeNull();
    expect(parseMapsLink("https://www.google.com/maps?q=95.0,-89.6")).toBeNull();
    expect(parseMapsLink("sin enlaces")).toBeNull();
  });
});

describe("latestDeliveryPin", () => {
  it("toma lo más reciente del cliente: pin o link; ignora lo que escribe el asistente", () => {
    const pin = formatLocationMessage({ latitude: 21.01, longitude: -89.6 });
    expect(latestDeliveryPin([{ role: "user", content: pin }, { role: "assistant", content: "https://www.google.com/maps?q=1,2" }])).toEqual({ fuente: "pin", lat: 21.01, lng: -89.6 });
    expect(latestDeliveryPin([{ role: "user", content: pin }, { role: "user", content: "https://www.google.com/maps?q=21.5,-89.5" }])).toEqual({ fuente: "link", lat: 21.5, lng: -89.5 });
    expect(latestDeliveryPin([{ role: "user", content: "hola" }])).toBeNull();
  });
});

describe("latestDeliveryPin acotado al pedido en curso", () => {
  const pinOficina = formatLocationMessage({ latitude: 21.01, longitude: -89.6 });

  it("el pin de un pedido ya creado NO se pega al pedido nuevo con otra dirección", () => {
    const historial = [
      { role: "user" as const, content: pinOficina },
      { role: "assistant" as const, content: "Pedido registrado, folio 12.", pedidoCreado: true },
      { role: "user" as const, content: "Quiero otro pedido, ahora en Calle 60 #100 de Itzimná" },
    ];
    expect(latestDeliveryPin(historial)).toBeNull();
  });

  it("un link de Maps anterior a la marca tampoco se usa; uno posterior sí", () => {
    const viejo = [{ role: "user" as const, content: "https://www.google.com/maps?q=21.5,-89.5" }, { role: "assistant" as const, content: "Listo.", pedidoCreado: true }];
    expect(latestDeliveryPin(viejo)).toBeNull();
    expect(latestDeliveryPin([...viejo, { role: "user" as const, content: pinOficina }])).toEqual({ fuente: "pin", lat: 21.01, lng: -89.6 });
  });

  it("sin marca (conversación en curso) conserva el comportamiento de lo más reciente", () => {
    expect(latestDeliveryPin([{ role: "user" as const, content: pinOficina }, { role: "assistant" as const, content: "¿Cuál es la dirección?" }])).toEqual({ fuente: "pin", lat: 21.01, lng: -89.6 });
  });

  it("el turno que deja un pedido creado marca el mensaje del asistente en el historial", async () => {
    const f = buildRestaurantFixture();
    await handleInboundWhatsAppMessage(
      f.repo,
      { handleInboundMessage: async () => ({ reply: "Pedido registrado.", orderId: "00000000-0000-4000-8000-000000000001", propertyId: null }) },
      { organizationId: f.organizationId, messageId: "wamid.1", phone: "9991234567", body: pinOficina, phoneNumberId: "pn" },
    );
    const guardado = await f.repo.appendWhatsAppUserMessageOnce(f.organizationId, "9991234567", { role: "user", content: "otro pedido en Calle 60" });
    const marca = guardado.filter((m) => m.role === "assistant");
    expect(marca).toHaveLength(1);
    expect(marca[0]).toMatchObject({ pedidoCreado: true });
    expect(latestDeliveryPin(guardado)).toBeNull();
  });
});

describe("nota de ubicación de entrega", () => {
  it.each([
    [{ fuente: "pin", lat: 21.01, lng: -89.6 } as const],
    [{ fuente: "link", lat: -21.5, lng: -89.5 } as const],
    [{ fuente: "link_corto", url: "https://maps.app.goo.gl/AbC123" } as const],
  ])("ida y vuelta %j", (u) => {
    const nota = `Otra nota\n${formatUbicacionEntregaNota(u)}\nCanal: domicilio.`;
    const leida = parseUbicacionEntregaNota(nota);
    expect(leida).toMatchObject(u.fuente === "link_corto" ? u : { fuente: u.fuente, lat: u.lat, lng: u.lng });
  });

  it("un texto libre del cliente que imita la nota con un host ajeno no se lee como enlace", () => {
    expect(parseUbicacionEntregaNota("Ubicación de entrega (enlace corto de Maps): https://evil.example/x")).toBeNull();
  });
});

describe("createOrder lleva el destino al pedido", () => {
  const base = (f: ReturnType<typeof buildRestaurantFixture>, o: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente Sintético",
    customerPhone: "9991234567",
    customerAddress: "Calle 50 #200",
    items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }],
    source: "whatsapp",
    paymentMethod: "efectivo",
    ...o,
  });

  it("a domicilio agrega la línea; a recoger no", async () => {
    const f = buildRestaurantFixture();
    const dom = await createOrder(f.repo, base(f, { canal: "domicilio", ubicacionEntrega: { fuente: "pin", lat: 21.01, lng: -89.6 } }));
    expect(parseUbicacionEntregaNota(dom.notes)).toEqual({ fuente: "pin", lat: 21.01, lng: -89.6 });
    const rec = await createOrder(f.repo, base(f, { customerPhone: "9990000002", canal: "recoger", ubicacionEntrega: { fuente: "pin", lat: 21.01, lng: -89.6 } }));
    expect(parseUbicacionEntregaNota(rec.notes)).toBeNull();
  });
});
