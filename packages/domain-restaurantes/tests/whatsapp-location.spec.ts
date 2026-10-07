// PM PR-3 (c): la ubicacion compartida por WhatsApp (mensaje `type: "location"`) llega al agente y
// alimenta la asignacion de sucursal por km. Antes el webhook solo leia mensajes de texto.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool, type AgentToolContext } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { extractMetaInboundMessages } from "../src/whatsapp/channel-config.ts";
import { formatLocationMessage, latestSharedLocation, parseSharedLocation } from "../src/whatsapp/location.ts";

function payload(messages: unknown[]) {
  return { entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn" }, messages } }] }] };
}
const FROM = "5219991234567";

describe("extractMetaInboundMessages", () => {
  it("devuelve texto, ubicacion (como marcador estable) y la nota de archivo en el orden del payload", () => {
    const out = extractMetaInboundMessages(
      payload([
        { id: "m1", from: FROM, type: "text", text: { body: "hola" } },
        { id: "m2", from: FROM, type: "location", location: { latitude: 21.0165, longitude: -89.596, name: "Mi casa", address: "Calle 5 x 6" } },
        { id: "m3", from: FROM, type: "image", image: { id: "x" } },
      ]),
    );
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(out[0]).toEqual({ id: "m1", from: FROM, body: "hola" });
    expect(out[1]!.body).toBe(formatLocationMessage({ latitude: 21.0165, longitude: -89.596 }));
    // Minimizacion: el nombre y la direccion que manda Meta no se guardan en el historial.
    expect(out[1]!.body).not.toMatch(/Mi casa|Calle 5/);
    expect(parseSharedLocation(out[1]!.body)).toEqual({ lat: 21.0165, lng: -89.596 });
    expect(out[2]!.body).toMatch(/imagen que el asistente no puede ver/);
  });

  it("ubicaciones con coordenadas invalidas, fuera de rango o no numericas NO producen marcador: cae a la nota honesta, nunca adivina", () => {
    const out = extractMetaInboundMessages(
      payload([
        { id: "a", from: FROM, type: "location", location: { latitude: 91, longitude: -89 } },
        { id: "b", from: FROM, type: "location", location: { latitude: 21, longitude: -181 } },
        { id: "c", from: FROM, type: "location", location: { latitude: "21.0", longitude: "-89.0" } },
        { id: "d", from: FROM, type: "location" },
        { id: "e", from: FROM, type: "location", location: { latitude: Number.NaN, longitude: 0 } },
      ]),
    );
    expect(out).toHaveLength(5);
    for (const m of out) {
      expect(parseSharedLocation(m.body)).toBeNull();
      expect(m.body).toMatch(/compartió su ubicación/);
    }
  });

  it("coordenadas numericas fuera de rango (lat=123) dan la nota de ubicacion invalida y no repiten las coordenadas ni mandan a buscar_sucursal_cercana", () => {
    const out = extractMetaInboundMessages(
      payload([
        { id: "f", from: FROM, type: "location", location: { latitude: 123, longitude: -89.5 } },
        { id: "g", from: FROM, type: "location", location: { latitude: 21, longitude: 400.25 } },
      ]),
    );
    expect(out).toHaveLength(2);
    for (const m of out) {
      expect(m.body).toMatch(/no trae coordenadas utilizables/);
      expect(m.body).not.toMatch(/buscar_sucursal_cercana/);
      expect(m.body).not.toMatch(/123|400|89\.5|21/);
    }
  });

  it("exige id y remitente validos tambien para ubicaciones", () => {
    const out = extractMetaInboundMessages(
      payload([
        { id: "", from: FROM, type: "location", location: { latitude: 21, longitude: -89 } },
        { id: "ok", from: "no-es-un-telefono", type: "location", location: { latitude: 21, longitude: -89 } },
      ]),
    );
    expect(out).toEqual([]);
  });

  it("un payload sin entry no truena", () => {
    expect(extractMetaInboundMessages({})).toEqual([]);
    expect(extractMetaInboundMessages(null)).toEqual([]);
  });
});

describe("marcador de ubicacion en el historial", () => {
  it("ida y vuelta: lo que se formatea se vuelve a parsear", () => {
    const text = formatLocationMessage({ latitude: 21.016512, longitude: -89.596034 });
    expect(text).toBe("[Ubicación compartida por WhatsApp] lat=21.016512 lng=-89.596034");
    expect(parseSharedLocation(text)).toEqual({ lat: 21.016512, lng: -89.596034 });
  });

  it("un texto normal o un marcador con coordenadas fuera de rango no es ubicacion", () => {
    expect(parseSharedLocation("estoy en lat=21 lng=-89")).toBeNull();
    expect(parseSharedLocation("[Ubicación compartida por WhatsApp] lat=95.000000 lng=-89.000000")).toBeNull();
  });

  it("latestSharedLocation toma la mas reciente y solo de mensajes del cliente", () => {
    const first = formatLocationMessage({ latitude: 21.0, longitude: -89.6 });
    const second = formatLocationMessage({ latitude: 21.03, longitude: -89.62 });
    expect(
      latestSharedLocation([
        { role: "user", content: first },
        { role: "assistant", content: second }, // el asistente nunca cuenta
        { role: "user", content: "gracias" },
      ]),
    ).toEqual({ lat: 21.0, lng: -89.6 });
    expect(latestSharedLocation([{ role: "user", content: first }, { role: "user", content: second }])).toEqual({ lat: 21.03, lng: -89.62 });
    expect(latestSharedLocation([{ role: "user", content: "hola" }])).toBeNull();
  });
});

describe("buscar_sucursal_cercana con la ubicacion compartida", () => {
  function seed() {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "pm", name: "PM" });
    for (const s of [
      { slug: "prol-montejo", lat: 21.028, lng: -89.61 },
      { slug: "altabrisa", lat: 21.0156, lng: -89.5982 },
    ]) {
      repo.seedBranch({ propertyId: randomUUID(), organizationId, name: s.slug, slug: s.slug, status: "active", phone: null, address: null, lat: s.lat, lng: s.lng });
    }
    const ctx = (extra: Partial<AgentToolContext> = {}): AgentToolContext => ({ organizationId, channel: "whatsapp", phone: "+5219991234567", ...extra });
    return { repo, ctx };
  }

  it("sin lat/lng del modelo usa la ubicacion compartida y asigna por km", async () => {
    const { repo, ctx } = seed();
    const out = await invokeAgentTool(repo, ctx({ sharedLocation: { lat: 21.0165, lng: -89.596 } }), "buscar_sucursal_cercana", {});
    expect(out.result).toMatchObject({ encontrada: true, branch_slug: "altabrisa", via: "coordenadas" });
  });

  it("una colonia dicha por el cliente despues de compartir ubicacion NO se pisa con las coordenadas viejas", async () => {
    const { repo, ctx } = seed();
    const out = await invokeAgentTool(repo, ctx({ sharedLocation: { lat: 21.0165, lng: -89.596 } }), "buscar_sucursal_cercana", { colonia: "Colonia Inexistente" });
    expect(out.result).toMatchObject({ encontrada: false, estado: "no_reconocida" });
  });

  it("coordenadas explicitas del modelo ganan sobre la ubicacion guardada", async () => {
    const { repo, ctx } = seed();
    const out = await invokeAgentTool(repo, ctx({ sharedLocation: { lat: 21.0165, lng: -89.596 } }), "buscar_sucursal_cercana", { lat: 21.0285, lng: -89.6105 });
    expect(out.result).toMatchObject({ encontrada: true, branch_slug: "prol-montejo" });
  });

  it("sin ubicacion ni colonia no adivina sucursal", async () => {
    const { repo, ctx } = seed();
    const out = await invokeAgentTool(repo, ctx(), "buscar_sucursal_cercana", {});
    expect(out.result).toMatchObject({ encontrada: false, estado: "no_reconocida" });
  });
});
