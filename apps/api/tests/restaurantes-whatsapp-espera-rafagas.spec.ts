// PM-C5 (recomendacion 17): espera de rafagas en el webhook REAL de WhatsApp de restaurantes. Con `replyDebounceSeconds` > 0 el webhook
// recibe el mensaje en una transaccion que se confirma, espera sin transaccion abierta y responde todo junto; con la espera apagada
// (lo normal) el camino es el de siempre. La espera se inyecta (`deps.esperarRafaga`) para controlarla sin dormir de verdad.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

function payload(messageId: string, texto: string, from = "5219991234567") {
  return { entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-t7" }, messages: [{ id: messageId, from, type: "text", text: { body: texto } }] } }] }] };
}

const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;

async function setup(esperaSegundos: number | null) {
  const base = await buildTestDeps();
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
  await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, { ...PM, ...(esperaSegundos === null ? {} : { replyDebounceSeconds: esperaSegundos }) });
  const vistos: string[][] = [];
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage({ messages }) {
      vistos.push(messages.map((m) => `${m.role}:${m.content}`));
      return { reply: `respuesta ${vistos.length}`, orderId: null, propertyId: null };
    },
  };
  const esperas: number[] = [];
  let liberar!: () => void;
  const compuerta = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  const enEspera = new Promise<void>((resolve) => {
    (base as { avisarEspera?: () => void }).avisarEspera = resolve;
  });
  const app = buildApp({
    ...base.deps,
    turnHandler: handler,
    esperarRafaga: async (ms: number) => {
      esperas.push(ms);
      (base as { avisarEspera?: () => void }).avisarEspera?.();
      await compuerta;
    },
  });
  return { ...base, app, vistos, esperas, liberar, enEspera };
}

const textoSalida = (repo: Awaited<ReturnType<typeof setup>>["restaurantesRepo"]) => repo.getOutbox().map((o) => (o.payload as { body: string }).body);

describe("webhook de WhatsApp de restaurantes con espera de rafagas", () => {
  it("dos mensajes seguidos del mismo telefono: UNA respuesta, que ve los dos, tras esperar el tiempo configurado", async () => {
    const { app, vistos, esperas, liberar, enEspera, restaurantesRepo } = await setup(6);
    const primero = app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    await enEspera; // el primer webhook ya recibio su mensaje y esta esperando (sin transaccion abierta)
    const segundo = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.2", "Quiero 1/4 de bistec con tortilla de maiz")));
    expect(segundo.status).toBe(200);
    expect(vistos).toHaveLength(0); // nadie ha contestado todavia: se esta esperando
    liberar();
    const r1 = await primero;
    expect(r1.status).toBe(200);
    expect(esperas).toEqual([6000]);
    expect(vistos).toEqual([["user:Hola", "user:Quiero 1/4 de bistec con tortilla de maiz"]]);
    expect(textoSalida(restaurantesRepo)).toEqual(["respuesta 1"]);
  });

  it("con la espera apagada (config sin valor) no espera y contesta cada mensaje por su cuenta, como siempre", async () => {
    const { app, vistos, esperas, restaurantesRepo } = await setup(null);
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")))).status).toBe(200);
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.2", "Quiero un pedido")))).status).toBe(200);
    expect(esperas).toEqual([]);
    expect(vistos).toEqual([["user:Hola"], ["user:Hola", "assistant:respuesta 1", "user:Quiero un pedido"]]);
    expect(textoSalida(restaurantesRepo)).toEqual(["respuesta 1", "respuesta 2"]);
  });

  it("con la espera en 0 tampoco espera", async () => {
    const { app, esperas, vistos } = await setup(0);
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")))).status).toBe(200);
    expect(esperas).toEqual([]);
    expect(vistos).toHaveLength(1);
  });

  it("Meta reenvia el mismo mensaje (al menos una vez): no se contesta dos veces", async () => {
    const { app, vistos, liberar, enEspera, restaurantesRepo } = await setup(6);
    const primero = app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    await enEspera;
    const repetido = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(repetido.status).toBe(200);
    liberar();
    await primero;
    expect(vistos).toEqual([["user:Hola"]]);
    expect(textoSalida(restaurantesRepo)).toEqual(["respuesta 1"]);
  });

  it("dos telefonos distintos no se mezclan: cada uno espera y se contesta por separado", async () => {
    const { app, vistos, liberar, enEspera } = await setup(6);
    const a = app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.a1", "Hola desde A", "5219991111111")));
    await enEspera;
    const b = app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.b1", "Hola desde B", "5219992222222")));
    liberar();
    await Promise.all([a, b]);
    expect(vistos.map((v) => v.join("|")).sort()).toEqual(["user:Hola desde A", "user:Hola desde B"]);
  });

  it("un fallo real del turno responde 500 (Meta reintenta) y no deja respuesta a medias", async () => {
    const base = await buildTestDeps();
    base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
    await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, { ...PM, replyDebounceSeconds: 3 });
    const roto: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        throw new Error("proveedor caido");
      },
    };
    const app = buildApp({ ...base.deps, turnHandler: roto, esperarRafaga: async () => undefined });
    const r = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ ok: false });
    expect(base.restaurantesRepo.getOutbox()).toHaveLength(0);
  });

  it("sin tiempo para esperar (la funcion ya consumio su presupuesto) responde enseguida, sin esperar", async () => {
    const base = await buildTestDeps();
    base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
    await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, { ...PM, replyDebounceSeconds: 10 });
    const esperas: number[] = [];
    const vistos: string[][] = [];
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ messages }) {
        vistos.push(messages.map((m) => m.content));
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    const relojes = [0, 20_000]; // inicio y momento de decidir la espera: ya pasaron 20 s de 30
    const app = buildApp({ ...base.deps, turnHandler: handler, esperarRafaga: async (ms: number) => void esperas.push(ms), relojMs: () => relojes.shift() ?? 20_000 });
    const r = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r.status).toBe(200);
    expect(esperas).toEqual([]);
    expect(vistos).toEqual([["Hola"]]);
    expect(textoSalida(base.restaurantesRepo)).toEqual(["ok"]);
  });

  it("la espera se recorta a lo que deja el presupuesto de la funcion (nunca pasa de 15 s menos lo ya transcurrido)", async () => {
    const base = await buildTestDeps();
    base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
    await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, { ...PM, replyDebounceSeconds: 10 });
    const esperas: number[] = [];
    const relojes = [0, 8_000];
    const app = buildApp({ ...base.deps, esperarRafaga: async (ms: number) => void esperas.push(ms), relojMs: () => relojes.shift() ?? 8_000 });
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")))).status).toBe(200);
    expect(esperas).toEqual([7_000]);
  });

  it("si la fase B no puede confirmar, el turno confirmado por la fase A se SUELTA: el mensaje queda 'failed' (Meta reintenta) y el siguiente mensaje del telefono se contesta en vez de absorberse sin respuesta", async () => {
    const base = await buildTestDeps();
    base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
    await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, { ...PM, replyDebounceSeconds: 5 });
    const vistos: string[][] = [];
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ messages }) {
        vistos.push(messages.map((m) => m.content));
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    // Simula el fallo detectable: la fase B (segunda sesion de cada peticion con espera) corre y su COMMIT falla, con lo que se revierte entera.
    const motor = base.deps.engine;
    let sesiones = 0;
    const engine = Object.create(motor) as typeof motor;
    engine.withAppSession = (async (ctx: unknown, fn: unknown) => {
      sesiones += 1;
      const fallaElCommit = sesiones === 2;
      const resultado = await (motor.withAppSession as (c: unknown, f: unknown) => Promise<unknown>).call(motor, ctx, async (db: unknown) => {
        const out = await (fn as (d: unknown) => Promise<unknown>)(db);
        if (fallaElCommit) throw new Error("COMMIT devolvio ROLLBACK");
        return out;
      });
      return resultado;
    }) as typeof motor.withAppSession;
    const app = buildApp({ ...base.deps, engine, turnHandler: handler, esperarRafaga: async () => undefined });

    const r1 = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r1.status).toBe(500); // Meta reintenta
    // (el repo en memoria no revierte datos con la transaccion falsa: lo que se prueba es la liberacion del turno)

    // El telefono vuelve a escribir: sin la liberacion, el turno de wamid.1 seguiria tomado y este mensaje se absorberia sin respuesta.
    sesiones = 10; // el resto de peticiones ya no simulan fallos
    const r2 = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.2", "Quiero un pedido")));
    expect(r2.status).toBe(200);
    expect(vistos.at(-1)?.at(-1)).toBe("Quiero un pedido"); // el turno se tomo y se contesto (no se absorbio)
    expect(textoSalida(base.restaurantesRepo).at(-1)).toBe("ok");
  });
});
