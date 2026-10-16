// Documento adjunto por enlace (menu en PDF por sucursal): cliente real contra un `fetch` inyectado y contra el simulador de Meta (nunca graph.facebook.com),
// degradacion a texto con el enlace si Meta no puede traer el archivo, y validacion del payload del outbox. NUNCA se envia nada real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { WhatsAppInvalidPayloadError, WhatsAppSendError } from "../src/errors.ts";
import { WhatsAppOutboundDispatcher } from "../src/dispatcher.ts";
import { FakeWhatsAppGraphClient } from "../src/providers/fake-graph-client.ts";
import { MetaGraphWhatsAppClient } from "../src/providers/meta-graph-client.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "../src/outbox-port.ts";
import { MetaCloudSimulator, serveFetchHandler } from "../src/testing/index.ts";
import type { RunningServer } from "../src/testing/index.ts";
import { esUrlHttpsPublica } from "../src/types.ts";

const TOKEN = "test-fake-whatsapp-access-token-never-real";
const PDF = "https://menus.ejemplo.test/menu-pensiones.pdf";
const WEB = "https://sitio.ejemplo.test/menupensiones";
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const documento = { url: PDF, filename: "menu-pensiones.pdf", fallbackUrl: WEB };

describe("MetaGraphWhatsAppClient: type document", () => {
  it("manda el cuerpo documentado por Meta (type document + link + filename + caption) y no reporta enviadoComo propio", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "+5219991112233",
        type: "document",
        document: { link: PDF, filename: "menu-pensiones.pdf", caption: "Menú de Pensiones" },
      });
      return jsonResponse({ messages: [{ id: "wamid.doc" }] });
    });
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.sendMessage({ to: "+5219991112233", phoneNumberId: "p1", body: "Menú de Pensiones", documento });
    expect(r.providerMessageId).toBe("wamid.doc");
    expect(r.enviadoComo).toBeUndefined(); // el check de enviado_como (migracion 066) no admite 'documento': se guarda NULL
  });

  it("exclusivo y validado: sin red si el enlace no es https publico, el nombre no es .pdf, el pie esta vacio o se combina con botones/plantilla/ubicacion", async () => {
    const fetchImpl = vi.fn();
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const base = { to: "+52999", phoneNumberId: "p1", body: "Menú" };
    await expect(client.sendMessage({ ...base, documento: { ...documento, url: "http://menus.ejemplo.test/m.pdf" } })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, documento: { ...documento, url: "https://user:clave@menus.ejemplo.test/m.pdf" } })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, documento: { ...documento, filename: "menu.exe" } })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, documento: { ...documento, filename: "../menu.pdf" } })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, body: "x".repeat(1025), documento })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, documento, buttons: ["Si"] })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, documento, solicitarUbicacion: true })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    await expect(client.sendMessage({ ...base, documento, template: { name: "t", language: "es_MX", params: [] } })).rejects.toBeInstanceOf(WhatsAppInvalidPayloadError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("si Meta no puede traer el PDF (131052) degrada UNA vez a texto con el enlace de respaldo; otros errores no degradan", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.type === "document") return jsonResponse({ error: { message: "Media download error", code: 131052 } }, 400);
      return jsonResponse({ messages: [{ id: "wamid.texto" }] });
    });
    const client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "Menú de Pensiones", documento });
    expect(r).toEqual({ providerMessageId: "wamid.texto", enviadoComo: "texto" });
    expect(bodies.map((b) => b.type)).toEqual(["document", "text"]);
    expect((bodies[1]!.text as { body: string }).body).toBe(`Menú de Pensiones\n${WEB}`);

    // Sin enlace de respaldo cae al del propio documento.
    bodies.length = 0;
    await client.sendMessage({ to: "+52999", phoneNumberId: "p1", body: "Menú", documento: { url: PDF, filename: "menu-pensiones.pdf" } });
    expect((bodies[1]!.text as { body: string }).body).toBe(`Menú\n${PDF}`);

    // Un numero invalido (131026) o un 5xx NO es culpa del archivo: no se manda texto aparte.
    const malo = vi.fn(async () => jsonResponse({ error: { message: "x", code: 131026 } }, 400));
    await expect(new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: malo as unknown as typeof fetch }).sendMessage({ to: "+52999", phoneNumberId: "p1", body: "Menú", documento })).rejects.toBeInstanceOf(WhatsAppSendError);
    expect(malo).toHaveBeenCalledOnce();
    const caido = vi.fn(async () => jsonResponse({ error: { message: "x", code: 1 } }, 503));
    await expect(new MetaGraphWhatsAppClient({ accessToken: TOKEN, fetchImpl: caido as unknown as typeof fetch }).sendMessage({ to: "+52999", phoneNumberId: "p1", body: "Menú", documento })).rejects.toBeInstanceOf(WhatsAppSendError);
    expect(caido).toHaveBeenCalledOnce();
  });
});

describe("simulador de Meta: documento", () => {
  let sim: MetaCloudSimulator;
  let webhook: RunningServer;
  let client: MetaGraphWhatsAppClient;
  beforeEach(async () => {
    webhook = await serveFetchHandler(async () => new Response('{"ok":true}', { status: 200 }));
    sim = new MetaCloudSimulator({ appSecret: "s", accessToken: TOKEN, phoneNumberId: "1234567890", webhookUrl: `${webhook.baseUrl}/hook` });
    await sim.start();
    client = new MetaGraphWhatsAppClient({ accessToken: TOKEN, baseUrl: sim.baseUrl });
  });
  afterEach(async () => {
    await sim.stop();
    await webhook.close();
  });

  it("dentro de la ventana de 24 h lo acepta (con enlace, nombre y pie); fuera de ella lo rechaza como cualquier mensaje libre", async () => {
    await sim.deliverText("5219991230000", "me manda el menu");
    await client.sendMessage({ to: "5219991230000", phoneNumberId: "1234567890", body: "Menú de Pensiones", documento });
    expect(sim.accepted.at(-1)).toMatchObject({ type: "document", text: "Menú de Pensiones", document: { link: PDF, filename: "menu-pensiones.pdf", caption: "Menú de Pensiones" } });
    await expect(client.sendMessage({ to: "5219998887777", phoneNumberId: "1234567890", body: "Menú", documento })).rejects.toThrow();
  });

  it("con el enlace caido (131052) el cliente real degrada a texto con el enlace de la pagina oficial y el simulador lo acepta", async () => {
    await sim.deliverText("5219991230000", "el menu por favor");
    sim.unreachableMedia.push("https://menus.ejemplo.test/");
    const r = await client.sendMessage({ to: "5219991230000", phoneNumberId: "1234567890", body: "Menú de Pensiones", documento });
    expect(r.enviadoComo).toBe("texto");
    expect(sim.rejected.at(-1)).toMatchObject({ code: 131052 });
    expect(sim.accepted.at(-1)).toMatchObject({ type: "text", text: `Menú de Pensiones\n${WEB}` });
  });
});

describe("despachador del outbox: documento", () => {
  class Port implements MessagingOutboxPort {
    readonly label = "test";
    readonly rows: { id: string; payload: unknown; status: string; detalle?: unknown }[] = [];
    enqueue(payload: unknown) {
      this.rows.push({ id: randomUUID(), payload, status: "pending" });
    }
    async claimBatch(): Promise<readonly MessagingOutboxItem[]> {
      return this.rows.filter((r) => r.status === "pending").map((r) => ({ id: r.id, attempts: 0, payload: r.payload }));
    }
    async markSent(id: string, detalle?: unknown) {
      const r = this.rows.find((x) => x.id === id)!;
      r.status = "sent";
      r.detalle = detalle;
    }
    async markRetry(id: string) {
      this.rows.find((x) => x.id === id)!.status = "retry";
    }
    async markDead(id: string) {
      this.rows.find((x) => x.id === id)!.status = "dead";
    }
  }
  const base = { to: "+5219991230000", phone_number_id: "p1", body: "Menú de Pensiones", transaccional: true };

  it("pasa el documento al cliente de Graph y marca sent sin enviadoComo", async () => {
    const port = new Port();
    const graph = new FakeWhatsAppGraphClient();
    port.enqueue({ ...base, documento });
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(port);
    expect(resumen.sent).toBe(1);
    expect(graph.sent[0]).toMatchObject({ to: "+5219991230000", phoneNumberId: "p1", body: "Menú de Pensiones", documento });
    expect(port.rows[0]).toMatchObject({ status: "sent", detalle: { providerMessageId: "fake-msg-0" } });
    expect((port.rows[0]!.detalle as { enviadoComo?: string }).enviadoComo).toBeUndefined();
  });

  it("un documento mal formado (http, sin .pdf, o combinado con botones) es error de ENCOLADO: dead, sin tocar la red", async () => {
    const port = new Port();
    const graph = new FakeWhatsAppGraphClient();
    port.enqueue({ ...base, documento: { ...documento, url: "http://menus.ejemplo.test/m.pdf" } });
    port.enqueue({ ...base, documento: { ...documento, filename: "menu.png" } });
    port.enqueue({ ...base, documento, buttons: ["Si"] });
    port.enqueue({ ...base, documento: "https://menus.ejemplo.test/m.pdf" });
    await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(port);
    expect(port.rows.map((r) => r.status)).toEqual(["dead", "dead", "dead", "dead"]);
    expect(graph.sent).toHaveLength(0);
  });
});

describe("esUrlHttpsPublica", () => {
  it("solo https sin credenciales y de hasta 2048 caracteres", () => {
    expect(esUrlHttpsPublica(PDF)).toBe(true);
    expect(esUrlHttpsPublica("http://a.test/x.pdf")).toBe(false);
    expect(esUrlHttpsPublica("javascript:alert(1)")).toBe(false);
    expect(esUrlHttpsPublica("https://a:b@c.test/x.pdf")).toBe(false);
    expect(esUrlHttpsPublica(`https://a.test/${"x".repeat(2100)}`)).toBe(false);
    expect(esUrlHttpsPublica(undefined)).toBe(false);
  });
});
