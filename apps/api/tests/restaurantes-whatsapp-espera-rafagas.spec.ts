// PM-C5 (recomendacion 17): espera de rafagas en el webhook REAL de WhatsApp de restaurantes. Con `replyDebounceSeconds` > 0 el webhook
// recibe el mensaje en una transaccion que se confirma, espera sin transaccion abierta y responde todo junto; con la espera apagada
// (lo normal) el camino es el de siempre. La espera se inyecta (`deps.esperarRafaga`) para controlarla sin dormir de verdad.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { actorHash, type WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
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

  it("si la fase B no puede confirmar, el turno que dejo tomado la fase A se SUELTA (liberarTurnoTrasFalloDeFaseB): el siguiente mensaje se contesta en vez de absorberse", async () => {
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
    // Simula el ROLLBACK real de la fase B: el repo en memoria no revierte, asi que al fallar el commit se REPONE el estado que la fase A dejo confirmado
    // (turno tomado por wamid.1). Sin liberarTurnoTrasFalloDeFaseB ese turno seguiria tomado y wamid.2 se absorberia sin respuesta.
    const motor = base.deps.engine;
    let sesiones = 0;
    const engine = Object.create(motor) as typeof motor;
    engine.withAppSession = (async (ctx: unknown, fn: unknown) => {
      sesiones += 1;
      const fallaElCommit = sesiones === 2;
      return await (motor.withAppSession as (c: unknown, f: unknown) => Promise<unknown>).call(motor, ctx, async (db: unknown) => {
        const out = await (fn as (d: unknown) => Promise<unknown>)(db);
        if (fallaElCommit) {
          await base.restaurantesRepo.claimWhatsAppConversation(base.organizationId, actorHash("+5219991234567"), "wamid.1", 45);
          throw new Error("COMMIT devolvio ROLLBACK");
        }
        return out;
      });
    }) as typeof motor.withAppSession;
    const app = buildApp({ ...base.deps, engine, turnHandler: handler, esperarRafaga: async () => undefined });

    const r1 = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    expect(r1.status).toBe(500); // Meta reintenta
    // el turno quedo libre: lo puede tomar otro mensaje (con el turno repuesto y sin liberar esto devolveria false)
    await expect(base.restaurantesRepo.claimWhatsAppConversation(base.organizationId, actorHash("+5219991234567"), "wamid.probe", 45)).resolves.toBe(true);
    await base.restaurantesRepo.finishWhatsAppMessage(base.organizationId, "wamid.probe", actorHash("+5219991234567"), "processed", null);

    sesiones = 10; // el resto de peticiones ya no simulan fallos
    const r2 = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.2", "Quiero un pedido")));
    expect(r2.status).toBe(200);
    expect(vistos.at(-1)?.at(-1)).toBe("Quiero un pedido");
    expect(textoSalida(base.restaurantesRepo).at(-1)).toBe("ok");
  });

  it("dueno muerto por timeout (fase A confirmada, fase B nunca corre): pasados 45 s el siguiente mensaje toma el turno y contesta lo absorbido", async () => {
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
    let entroEnEspera!: () => void;
    const enEspera = new Promise<void>((r) => (entroEnEspera = r));
    // la funcion del primer mensaje "muere" esperando: la espera nunca termina
    let llamadas = 0;
    const app = buildApp({
      ...base.deps,
      turnHandler: handler,
      esperarRafaga: () => {
        llamadas += 1;
        if (llamadas > 1) return Promise.resolve(); // solo la primera funcion "muere"
        entroEnEspera();
        return new Promise<void>(() => undefined);
      },
    });
    void app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    await enEspera;
    expect(vistos).toHaveLength(0);

    // antes de 45 s el turno sigue tomado: el mensaje se absorbe sin respuesta
    const absorbido = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.2", "Quiero un pedido")));
    expect(absorbido.status).toBe(200);
    expect(vistos).toHaveLength(0);

    const ahora = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(ahora + 46_000);
    try {
      const r = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.3", "y una coca")));
      expect(r.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    // el turno vencido lo tomo wamid.3, que contesta TODO lo absorbido (los 3 mensajes estan en el historial) en una sola respuesta
    expect(vistos).toEqual([["Hola", "Quiero un pedido", "y una coca"]]);
    expect(textoSalida(base.restaurantesRepo)).toEqual(["ok"]);
  });

  it("un error leyendo la config de espera manda solo ese mensaje al camino sin espera (responde como siempre, sin 500)", async () => {
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
    const esperas: number[] = [];
    const repo = base.restaurantesRepo as unknown as { findWhatsAppAgentConfig: (...a: unknown[]) => Promise<unknown> };
    const original = repo.findWhatsAppAgentConfig.bind(repo);
    repo.findWhatsAppAgentConfig = async () => {
      throw new Error("42P01 relation does not exist");
    };
    const app = buildApp({ ...base.deps, turnHandler: handler, esperarRafaga: async (ms: number) => void esperas.push(ms) });
    const r = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("wamid.1", "Hola")));
    repo.findWhatsAppAgentConfig = original;
    expect(r.status).toBe(200);
    expect(esperas).toEqual([]);
    expect(vistos).toEqual([["Hola"]]);
    expect(textoSalida(base.restaurantesRepo)).toEqual(["ok"]);
  });
});
