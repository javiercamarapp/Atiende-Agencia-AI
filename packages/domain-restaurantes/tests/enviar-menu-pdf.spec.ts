// enviar_menu (T7-065): el menu en PDF de la sucursal correcta por URL publica. Meta SIMULADO (MetaCloudSimulator), nunca mensajes reales ni red.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { MetaCloudSimulator, serveFetchHandler, type RunningServer } from "@atiende/whatsapp-gateway/testing";
import { invokeAgentTool, toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import { MENU_PDF_POR_SUCURSAL, normalizarBaseMenuPdf, resolverMenuPdf } from "../src/menu-pdf.ts";
import { OrderValidationError } from "../src/errors.ts";
import { createRestaurantesMessagingOutboxPort } from "../src/whatsapp/outbox-adapter.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const BASE = "https://menus.ejemplo.test/pm";
const TOKEN = "test-fake-whatsapp-access-token-never-real";
const PHONE = "9991230000";

describe("mapa sucursal -> menu publicado", () => {
  it("las 7 sucursales del seed tienen menu; Montejo, García Lavín (Victory) y Altabrisa comparten el del sitio; el resto, el suyo", () => {
    expect(Object.keys(MENU_PDF_POR_SUCURSAL).sort()).toEqual(["altabrisa", "fco-montejo", "galerias", "garcia-lavin", "pensiones", "playa", "prol-montejo"]);
    const compartido = MENU_PDF_POR_SUCURSAL["prol-montejo"]!.archivo;
    expect(MENU_PDF_POR_SUCURSAL["garcia-lavin"]!.archivo).toBe(compartido);
    expect(MENU_PDF_POR_SUCURSAL.altabrisa!.archivo).toBe(compartido);
    const otros = ["fco-montejo", "galerias", "pensiones", "playa"].map((s) => MENU_PDF_POR_SUCURSAL[s]!.archivo);
    expect(new Set([...otros, compartido]).size).toBe(5);
    for (const m of Object.values(MENU_PDF_POR_SUCURSAL)) {
      expect(m.archivo).toMatch(/^menu-[a-z-]+\.pdf$/);
      expect(m.paginaWeb).toMatch(/^https:\/\/www\.lostaquitosdepm\.com\/[a-z-]+$/);
    }
  });

  it("resolverMenuPdf: PDF con base valida; enlace oficial sin base o con base invalida; sin_menu para sucursal desconocida (incluido __proto__)", () => {
    expect(resolverMenuPdf("pensiones", BASE + "/")).toMatchObject({ tipo: "pdf", url: `${BASE}/menu-pensiones.pdf`, archivo: "menu-pensiones.pdf" });
    expect(resolverMenuPdf("pensiones", null)).toMatchObject({ tipo: "enlace", paginaWeb: "https://www.lostaquitosdepm.com/menupensiones" });
    for (const mala of ["http://menus.ejemplo.test", "javascript:alert(1)", "https://u:p@menus.ejemplo.test", "https://menus.ejemplo.test/?x=1", "no es url", ""]) {
      expect(normalizarBaseMenuPdf(mala), mala).toBeNull();
      expect(resolverMenuPdf("pensiones", mala).tipo).toBe("enlace");
    }
    expect(resolverMenuPdf("sucursal-inventada", BASE)).toEqual({ tipo: "sin_menu" });
    expect(resolverMenuPdf("__proto__", BASE)).toEqual({ tipo: "sin_menu" });
    expect(resolverMenuPdf("constructor", BASE)).toEqual({ tipo: "sin_menu" });
  });
});

describe("tool enviar_menu", () => {
  it("solo existe en WhatsApp (no en el manifiesto de voz) y no recibe telefono", () => {
    expect(toolDefinitionsForChannel("whatsapp").some((t) => t.name === "enviar_menu")).toBe(true);
    expect(toolDefinitionsForChannel("voz").some((t) => t.name === "enviar_menu")).toBe(false);
  });

  it("encola UN documento con el PDF de la sucursal pedida (no el de la del chat), por el numero del chat, y es idempotente por mensaje", async () => {
    const { repo, organizationId, propertyId } = buildRestaurantFixture();
    repo.seedWhatsAppBranchChannel(organizationId, propertyId, "1234567890");
    const ctx = { organizationId, channel: "whatsapp" as const, phone: PHONE, entryPropertyId: propertyId, sourceEventId: "wamid.IN1", menuPdfBaseUrl: BASE };
    const a = await invokeAgentTool(repo, ctx, "enviar_menu", { branch_slug: "fco-montejo" });
    expect(a.result).toMatchObject({ ok: true, enviado: "pdf", branch_slug: "fco-montejo", archivo: "menu-francisco-de-montejo.pdf" });
    await invokeAgentTool(repo, ctx, "enviar_menu", { branch_slug: "fco-montejo" }); // reintento del mismo turno
    const outbox = repo.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ channel: "whatsapp", eventType: "whatsapp.menu_pdf", status: "pending" });
    expect(outbox[0]!.payload).toMatchObject({
      to: "+529991230000",
      phone_number_id: "1234567890",
      transaccional: true,
      documento: { url: `${BASE}/menu-francisco-de-montejo.pdf`, filename: "menu-francisco-de-montejo.pdf", fallbackUrl: "https://www.lostaquitosdepm.com/menufranciscodemontejo" },
    });
  });

  it("sin base de PDF configurada NO encola: devuelve el enlace de la pagina oficial para que el agente lo diga en texto", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const out = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: PHONE }, "enviar_menu", { branch_slug: "fco-montejo" });
    expect(out.result).toMatchObject({ ok: true, enviado: "enlace", enlace: "https://www.lostaquitosdepm.com/menufranciscodemontejo" });
    expect(repo.getOutbox()).toHaveLength(0);
  });

  it("sin numero de WhatsApp activo cae al enlace en texto; vista previa del dueño simula sin encolar", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const sinCanal = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: PHONE, menuPdfBaseUrl: BASE }, "enviar_menu", { branch_slug: "fco-montejo" });
    expect(sinCanal.result).toMatchObject({ enviado: "enlace" });
    const preview = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: PHONE, menuPdfBaseUrl: BASE, modo: "preview" }, "enviar_menu", { branch_slug: "fco-montejo" });
    expect(preview).toMatchObject({ simulated: true, result: { simulado: true, enviado: "pdf" } });
    expect(repo.getOutbox()).toHaveLength(0);
  });

  it("sucursal desconocida: error de regla para que el agente pregunte (nada encolado); slug vacio o inventado igual", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const ctx = { organizationId, channel: "whatsapp" as const, phone: PHONE, menuPdfBaseUrl: BASE };
    await expect(invokeAgentTool(repo, ctx, "enviar_menu", { branch_slug: "sucursal-inventada" })).rejects.toBeInstanceOf(OrderValidationError);
    await expect(invokeAgentTool(repo, ctx, "enviar_menu", { branch_slug: "" })).rejects.toBeInstanceOf(OrderValidationError);
    await expect(invokeAgentTool(repo, ctx, "enviar_menu", {})).rejects.toBeInstanceOf(OrderValidationError);
    expect(repo.getOutbox()).toHaveLength(0);
  });

  it("sucursal activa del negocio sin menu publicado (slug fuera del mapa): sin_menu, nada encolado", async () => {
    const { repo, organizationId, propertyId } = buildRestaurantFixture();
    repo.seedWhatsAppBranchChannel(organizationId, propertyId, "1234567890");
    repo.seedBranch({ propertyId: randomUUID(), organizationId, name: "Nueva", slug: "nueva-sucursal", status: "active", phone: "+529991234568", address: "Calle 2", lat: 21.0, lng: -89.6 });
    const out = await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: PHONE, entryPropertyId: propertyId, menuPdfBaseUrl: BASE }, "enviar_menu", { branch_slug: "nueva-sucursal" });
    expect(out.result).toMatchObject({ ok: true, enviado: "sin_menu", branch_slug: "nueva-sucursal" });
    expect(repo.getOutbox()).toHaveLength(0);
  });
});

describe("de punta a punta con Meta simulado: el cliente pide el menu y recibe el PDF de SU sucursal", () => {
  let sim: MetaCloudSimulator;
  let webhook: RunningServer;
  beforeEach(async () => {
    webhook = await serveFetchHandler(async () => new Response('{"ok":true}', { status: 200 }));
    sim = new MetaCloudSimulator({ appSecret: "s", accessToken: TOKEN, phoneNumberId: "1234567890", webhookUrl: `${webhook.baseUrl}/hook` });
    await sim.start();
  });
  afterEach(async () => {
    await sim.stop();
    await webhook.close();
  });

  async function pedirMenu(base: string | null) {
    const { repo, organizationId, propertyId } = buildRestaurantFixture();
    repo.seedWhatsAppBranchChannel(organizationId, propertyId, "1234567890");
    await sim.deliverText("529991230000", "me manda el menu por favor");
    await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: PHONE, entryPropertyId: propertyId, sourceEventId: "wamid.IN9", menuPdfBaseUrl: base }, "enviar_menu", { branch_slug: "fco-montejo" });
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl });
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: client }).dispatchPending(createRestaurantesMessagingOutboxPort(repo));
    return { repo, resumen };
  }

  it("el despachador entrega el documento: enlace, nombre y pie de la sucursal; el outbox queda sent", async () => {
    const { repo, resumen } = await pedirMenu(BASE);
    expect(resumen.sent).toBe(1);
    expect(sim.accepted.at(-1)).toMatchObject({
      type: "document",
      to: "+529991230000",
      document: { link: `${BASE}/menu-francisco-de-montejo.pdf`, filename: "menu-francisco-de-montejo.pdf", caption: "Menú de Los Taquitos de PM · Francisco de Montejo" },
    });
    expect(repo.getOutbox().map((o) => o.status)).toEqual(["sent"]);
  });

  it("PDF no disponible (Meta no puede descargarlo): el cliente recibe el texto con el enlace oficial de esa sucursal, no se queda sin menu", async () => {
    sim.unreachableMedia.push(BASE);
    const { repo, resumen } = await pedirMenu(BASE);
    expect(resumen.sent).toBe(1);
    expect(sim.rejected.at(-1)).toMatchObject({ code: 131052 });
    expect(sim.accepted.at(-1)).toMatchObject({ type: "text", text: "Menú de Los Taquitos de PM · Francisco de Montejo\nhttps://www.lostaquitosdepm.com/menufranciscodemontejo" });
    expect(repo.getOutbox().map((o) => o.status)).toEqual(["sent"]);
  });

  it("sin PM_MENU_PDF_BASE_URL no sale ningun documento: el agente da el enlace en su respuesta", async () => {
    const { repo, resumen } = await pedirMenu(null);
    expect(resumen.sent).toBe(0);
    expect(sim.accepted.filter((m) => m.type === "document")).toHaveLength(0);
    expect(repo.getOutbox()).toHaveLength(0);
  });
});
