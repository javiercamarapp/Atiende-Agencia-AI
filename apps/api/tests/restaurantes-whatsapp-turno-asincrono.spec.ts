// Turno ASINCRONO del webhook de WhatsApp de restaurantes (cerebro v2 o `WHATSAPP_TURNO_ASINCRONO`): el webhook acusa a Meta al terminar la fase A
// (reclamo del mensaje + lease de conversacion confirmados) y la fase B (turno + despacho) corre despues con la vida extendida de la funcion (60 s).
// En Vercel el «despues» es `waitUntil` del contexto de la peticion; aqui se inyecta `deps.enSegundoPlano`. Sin contexto de Vercel (local, arnes de
// medicion, tests) la fase B corre SINCRONA pero con el mismo presupuesto extendido.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FUNCION_ASINCRONA_MAX_MS, type WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { waitUntilDeVercel } from "../src/en-segundo-plano.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

const payload = (messageId: string, texto: string, from = "5219991234567") => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-t7" }, messages: [{ id: messageId, from, type: "text", text: { body: texto } }] } }] }] });
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const MARGEN = 6_000;

async function setup(opts: { asincrono: boolean | "lanza"; conSegundoPlano: boolean; handler?: WhatsAppTurnHandler; escribiendo?: (a: { phoneNumberId: string; messageId: string }) => Promise<void> }) {
  const base = await buildTestDeps();
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
  await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, PM);
  const vistos: Array<{ finTurnoMs: number | undefined; turnoAsincrono: boolean | undefined; mensajes: string[] }> = [];
  let liberar!: () => void;
  const compuerta = new Promise<void>((r) => (liberar = r));
  const handler: WhatsAppTurnHandler = opts.handler ?? {
    async handleInboundMessage({ messages, finTurnoMs, turnoAsincrono }) {
      await compuerta;
      vistos.push({ finTurnoMs, turnoAsincrono, mensajes: messages.map((m) => m.content) });
      return { reply: `respuesta ${vistos.length}`, orderId: null, propertyId: null };
    },
  };
  const tareas: Array<Promise<unknown>> = [];
  const app = buildApp({
    ...base.deps,
    turnHandler: handler,
    relojMs: () => 1_000,
    turnoAsincrono: async () => {
      if (opts.asincrono === "lanza") throw new Error("42703 column does not exist");
      return opts.asincrono;
    },
    ...(opts.conSegundoPlano ? { enSegundoPlano: (p: Promise<unknown>) => void tareas.push(p) } : {}),
    ...(opts.escribiendo ? { escribiendoWhatsApp: opts.escribiendo } : {}),
  });
  return { ...base, app, vistos, liberar, tareas };
}

const textoSalida = (repo: Awaited<ReturnType<typeof setup>>["restaurantesRepo"]) => repo.getOutbox().map((o) => (o.payload as { body: string }).body);

describe("webhook de WhatsApp de restaurantes: turno asincrono", () => {
  it("con la bandera y waitUntil: responde 200 ANTES de que termine el turno; el turno corre despues y encola la respuesta", async () => {
    const s = await setup({ asincrono: true, conSegundoPlano: true });
    const r = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r.status).toBe(200);
    expect(s.vistos).toHaveLength(0); // el turno sigue detenido en la compuerta: Meta ya tiene su 200
    expect(s.tareas).toHaveLength(1);
    s.liberar();
    await s.tareas[0];
    expect(s.vistos).toEqual([{ finTurnoMs: 1_000 + FUNCION_ASINCRONA_MAX_MS - MARGEN, turnoAsincrono: true, mensajes: ["Hola"] }]);
    expect(textoSalida(s.restaurantesRepo)).toEqual(["respuesta 1"]);
  });

  it("sin contexto de Vercel (local / arnes): la fase B corre sincrona, con el presupuesto extendido", async () => {
    const s = await setup({ asincrono: true, conSegundoPlano: false });
    s.liberar();
    const r = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r.status).toBe(200);
    expect(s.vistos).toEqual([{ finTurnoMs: 1_000 + FUNCION_ASINCRONA_MAX_MS - MARGEN, turnoAsincrono: true, mensajes: ["Hola"] }]);
    expect(textoSalida(s.restaurantesRepo)).toEqual(["respuesta 1"]);
  });

  it("sin la bandera el camino es el de siempre: turno dentro de la peticion, sin presupuesto extendido ni marca, aunque haya waitUntil", async () => {
    const s = await setup({ asincrono: false, conSegundoPlano: true });
    s.liberar();
    const r = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r.status).toBe(200);
    expect(s.tareas).toHaveLength(0);
    expect(s.vistos).toEqual([{ finTurnoMs: undefined, turnoAsincrono: undefined, mensajes: ["Hola"] }]);
  });

  it("si leer la bandera falla, ese mensaje va por el camino de siempre (sin 500)", async () => {
    const s = await setup({ asincrono: "lanza", conSegundoPlano: true });
    s.liberar();
    const r = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r.status).toBe(200);
    expect(s.tareas).toHaveLength(0);
    expect(s.vistos.map((v) => v.turnoAsincrono)).toEqual([undefined]);
  });

  it("un fallo del turno en segundo plano no cambia el 200 a Meta: el mensaje queda 'failed' (lo retoma el barredor) y el turno se suelta", async () => {
    const roto: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        throw new Error("proveedor caido");
      },
    };
    const s = await setup({ asincrono: true, conSegundoPlano: true, handler: roto });
    const r = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r.status).toBe(200);
    await s.tareas[0];
    expect(s.restaurantesRepo.getOutbox()).toHaveLength(0);
    // Reclamable de nuevo (failed): es lo que hara el barredor de turnos huerfanos.
    await expect(s.restaurantesRepo.claimWhatsAppMessage(s.organizationId, "wamid.1", "x".repeat(64))).resolves.toBe(true);
  });

  it("la fase A deja la sucursal de entrada en la conversacion: si el primer turno muere, el barredor sabe con que numero contestar", async () => {
    const roto: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        throw new Error("la funcion murio");
      },
    };
    const s = await setup({ asincrono: true, conSegundoPlano: true, handler: roto });
    expect((await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")))).status).toBe(200);
    const conversaciones = (s.restaurantesRepo as unknown as { whatsappConversations: Map<string, { propertyId: string | null }> }).whatsappConversations;
    expect(conversaciones.get(`${s.organizationId}:+5219991234567`)?.propertyId).toBe(s.propertyId);
  });

  it("manda el indicador de «escribiendo» al tomar el turno asincrono; si falla, el turno sigue", async () => {
    const avisos: Array<{ phoneNumberId: string; messageId: string }> = [];
    const s = await setup({
      asincrono: true,
      conSegundoPlano: true,
      escribiendo: async (a) => {
        avisos.push(a);
        throw new Error("Graph API caida");
      },
    });
    s.liberar();
    expect((await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")))).status).toBe(200);
    await s.tareas[0];
    expect(avisos).toEqual([{ phoneNumberId: "pn-t7", messageId: "wamid.1" }]);
    expect(textoSalida(s.restaurantesRepo)).toEqual(["respuesta 1"]);
  });
});

describe("waitUntilDeVercel", () => {
  const SIMBOLO = Symbol.for("@vercel/request-context");
  it("sin contexto de Vercel devuelve null (el webhook corre la fase B sincrona)", () => {
    expect(waitUntilDeVercel()).toBeNull();
  });
  it("con el contexto de peticion de Vercel delega en su waitUntil", () => {
    const recibidas: Array<Promise<unknown>> = [];
    (globalThis as Record<symbol, unknown>)[SIMBOLO] = { get: () => ({ waitUntil: (p: Promise<unknown>) => void recibidas.push(p) }) };
    try {
      const fn = waitUntilDeVercel();
      expect(fn).not.toBeNull();
      const p = Promise.resolve(1);
      fn!(p);
      expect(recibidas).toEqual([p]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[SIMBOLO];
    }
  });
});
