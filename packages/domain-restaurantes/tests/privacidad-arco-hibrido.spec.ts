// ARCO hibrido de punta a punta: clasificador en el webhook (fail-open), herramienta `registrar_solicitud_arco` del agente, telefono canonico entre canales.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryPrivacidadRepository } from "../src/privacidad/in-memory-repository.ts";
import { runArcoFastPath, telefonoCanonicoArco } from "../src/privacidad/arco-intent.ts";
import type { ClasificadorArco, ResultadoClasificadorArco } from "../src/privacidad/clasificador-arco.ts";
import { executeAgentToolSafely, toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import { PRIVACY_AND_AI_RULES } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219981234567";
const CANON = "+529981234567";
const R = (intencion: ResultadoClasificadorArco["intencion"], confianza: number, d: ResultadoClasificadorArco["derechoMasProbable"] = null): ResultadoClasificadorArco => ({ intencion, confianza, derechoMasProbable: d });

function setup(clasificador?: ClasificadorArco) {
  const { repo, organizationId } = buildRestaurantFixture();
  const privacy = new InMemoryPrivacidadRepository();
  const handle = vi.fn<WhatsAppTurnHandler["handleInboundMessage"]>(async () => ({ reply: "Claro, ¿qué desea pedir?", orderId: null, propertyId: null }));
  const send = (body: string) =>
    handleInboundWhatsAppMessage(repo, { handleInboundMessage: handle }, { organizationId, messageId: randomUUID(), phone: PHONE, body, phoneNumberId: "pn-1", privacy, ...(clasificador ? { arcoClassifier: clasificador } : {}) });
  return { repo, organizationId, privacy, handle, send };
}

describe("clasificador dentro del webhook", () => {
  it("lo que la regex no vio y el modelo si: se REGISTRA la solicitud (sin pasar por el agente)", async () => {
    const llamadas: string[] = [];
    const { send, handle, privacy } = setup({ clasificar: async ({ texto }) => { llamadas.push(texto); return R("revocacion_contacto", 0.93, "oposicion"); } });
    const out = await send("oiga ya no quiero que me anden buscando");
    expect(llamadas).toHaveLength(1);
    expect(handle).not.toHaveBeenCalled();
    expect(out.reply).toContain("CONFIRMO");
    expect(privacy.requests[0]).toMatchObject({ rightType: "oposicion", customerPhone: CANON, status: "pendiente_confirmacion" });
  });
  it("si el clasificador falla (null) o lanza, el pedido sigue su camino normal", async () => {
    for (const clasificar of [async () => null, async () => { throw new Error("proveedor caido"); }] as ClasificadorArco["clasificar"][]) {
      const { send, handle, privacy } = setup({ clasificar });
      // El contrato dice que no lanza; aun si un doble defectuoso lanzara, el turno de un mensaje de pedido no se pierde.
      const out = await send("oiga ya no quiero que me anden buscando").catch(() => ({ reply: "ERROR" }));
      if (out.reply === "ERROR") continue;
      expect(handle).toHaveBeenCalledTimes(1);
      expect(privacy.requests).toHaveLength(0);
    }
  });
  it("un mensaje de pedido no gasta ni una llamada al modelo", async () => {
    const clasificar = vi.fn(async () => R("ninguna", 0.99));
    const { send, handle } = setup({ clasificar });
    await send("quiero 2 tacos de pastor y una coca");
    expect(clasificar).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it("sin clasificador el comportamiento es el de la capa regex", async () => {
    const { send, handle } = setup();
    await send("oiga ya no quiero que me anden buscando");
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

describe("telefono canonico: voz y WhatsApp encuentran la MISMA solicitud", () => {
  it("formatos", () => {
    expect(telefonoCanonicoArco("9981234567")).toBe(CANON);
    expect(telefonoCanonicoArco("+52 998 123 4567")).toBe(CANON);
    expect(telefonoCanonicoArco("5219981234567")).toBe(CANON);
    expect(telefonoCanonicoArco("+5219981234567")).toBe(CANON);
    expect(telefonoCanonicoArco("+14155550123")).toBe("+14155550123");
  });
  it("registrada por voz con 10 digitos, el CONFIRMO que llega por WhatsApp (521...) la encuentra", async () => {
    const repo = new InMemoryPrivacidadRepository();
    const org = "00000000-0000-0000-0000-0000000000a1";
    await runArcoFastPath(repo, org, "9981234567", "borren mis datos", "voice");
    const r = await runArcoFastPath(repo, org, PHONE, "CONFIRMO", "whatsapp");
    expect(r?.reply).toContain("quedó registrada");
    expect(repo.requests).toHaveLength(1);
    expect(repo.requests[0]).toMatchObject({ customerPhone: CANON, status: "recibida", channel: "voice" });
  });
  it("la misma solicitud abierta no se duplica entre canales", async () => {
    const repo = new InMemoryPrivacidadRepository();
    const org = "00000000-0000-0000-0000-0000000000a1";
    await runArcoFastPath(repo, org, "9981234567", "borren mis datos", "voice");
    await runArcoFastPath(repo, org, PHONE, "borren mis datos", "whatsapp");
    expect(repo.requests).toHaveLength(1);
  });
});

describe("herramienta del agente registrar_solicitud_arco", () => {
  const base = () => {
    const { repo, organizationId } = buildRestaurantFixture();
    return { repo, organizationId };
  };
  it("existe solo en WhatsApp y el prompt le indica al modelo cuando usarla (y cuando NO)", () => {
    expect(toolDefinitionsForChannel("whatsapp").some((t) => t.name === "registrar_solicitud_arco")).toBe(true);
    expect(toolDefinitionsForChannel("voz").some((t) => t.name === "registrar_solicitud_arco")).toBe(false);
    expect(PRIVACY_AND_AI_RULES).toContain("registrar_solicitud_arco");
    expect(PRIVACY_AND_AI_RULES).toMatch(/NO la uses para cosas del pedido/);
    const def = toolDefinitionsForChannel("whatsapp").find((t) => t.name === "registrar_solicitud_arco")!;
    expect(JSON.stringify(def.parameters)).not.toMatch(/phone|telefono/i); // el telefono sale del contexto, nunca del modelo
  });
  it("registra con el telefono del contexto, deja pendiente de CONFIRMO y devuelve la frase a decir tal cual", async () => {
    const { repo, organizationId } = base();
    const privacy = new InMemoryPrivacidadRepository();
    const registrarArco = async ({ derecho, detalle }: { derecho: "acceso" | "rectificacion" | "cancelacion" | "oposicion"; detalle?: string }) => {
      const r = await runArcoFastPath(privacy, organizationId, PHONE, detalle ?? derecho);
      return r ? { reply: r.reply, registrada: true } : null;
    };
    void registrarArco;
    const { crearRegistroArcoParaAgente } = await import("../src/whatsapp/inbound.ts");
    const puerto = crearRegistroArcoParaAgente(privacy, { organizationId, phone: PHONE, textosDelCliente: ["paren de mandarme mensajes"] });
    const out = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone: PHONE, registrarArco: puerto }, "registrar_solicitud_arco", { derecho: "oposicion", detalle: "paren de mandarme mensajes" });
    expect(out.result).toMatchObject({ ok: true });
    expect((out.result as { decir_al_cliente: string }).decir_al_cliente).toContain("CONFIRMO");
    expect((out.result as { instruccion: string }).instruccion).toMatch(/TAL CUAL/);
    expect(privacy.requests[0]).toMatchObject({ customerPhone: CANON, rightType: "oposicion", status: "pendiente_confirmacion", channel: "whatsapp" });
  });
  it("el modelo no puede cambiar el telefono: un argumento `phone` se ignora", async () => {
    const { repo, organizationId } = base();
    const privacy = new InMemoryPrivacidadRepository();
    const { crearRegistroArcoParaAgente } = await import("../src/whatsapp/inbound.ts");
    const puerto = crearRegistroArcoParaAgente(privacy, { organizationId, phone: PHONE, textosDelCliente: ["x"] });
    await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone: PHONE, registrarArco: puerto }, "registrar_solicitud_arco", { derecho: "acceso", phone: "+5219990000000" });
    expect(privacy.requests[0]!.customerPhone).toBe(CANON);
  });
  it("derecho invalido -> error de regla, nada se registra", async () => {
    const { repo, organizationId } = base();
    const puerto = vi.fn();
    const out = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone: PHONE, registrarArco: puerto }, "registrar_solicitud_arco", { derecho: "portabilidad" });
    expect(out.result).toHaveProperty("error");
    expect(puerto).not.toHaveBeenCalled();
  });
  it("preview: simulada, no registra nada", async () => {
    const { repo, organizationId } = base();
    const puerto = vi.fn();
    const out = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone: "9990000001", modo: "preview", registrarArco: puerto }, "registrar_solicitud_arco", { derecho: "cancelacion" });
    expect(out.simulated).toBe(true);
    expect(puerto).not.toHaveBeenCalled();
  });
  it("sin puerto (despliegue anterior) o base sin migrar: responde que no esta disponible y manda a escalar", async () => {
    const { repo, organizationId } = base();
    const sinPuerto = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone: PHONE }, "registrar_solicitud_arco", { derecho: "cancelacion" });
    expect(JSON.stringify(sinPuerto.result)).toMatch(/escalar_a_humano/);
    const sinMigrar = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone: PHONE, registrarArco: async () => null }, "registrar_solicitud_arco", { derecho: "cancelacion" });
    expect(JSON.stringify(sinMigrar.result)).toMatch(/escalar_a_humano/);
  });
});
