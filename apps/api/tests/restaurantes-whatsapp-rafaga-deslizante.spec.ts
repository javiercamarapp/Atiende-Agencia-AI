// Espera de rafagas DESLIZANTE en el turno asincrono (cerebro v2 / `WHATSAPP_TURNO_ASINCRONO`). Con el acuse a Meta en la fase A, la espera ya no protege
// el 200: solo sirve para juntar los mensajes seguidos del cliente. En vez de esperar SIEMPRE los segundos configurados (PM: 6 s, que se suman a toda
// respuesta), se espera una ventana de silencio corta (`WHATSAPP_RAFAGA_SILENCIO_MS`, 2.5 s por omision) y se vuelve a esperar SOLO si en esa ventana llego
// otro mensaje del mismo telefono, sin pasar nunca del tope configurado. El camino sincrono (organizaciones sin cerebro v2) no cambia.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { silencioRafagaAsincronaMs } from "../src/en-segundo-plano.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

const payload = (messageId: string, texto: string, from = "5219991234567") => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-t7" }, messages: [{ id: messageId, from, type: "text", text: { body: texto } }] } }] }] });
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;

/** `alEsperar(n)` corre DENTRO de la n-esima espera (0-based): ahi el test manda los mensajes que «llegan durante» esa ventana. */
async function setup(opts: { asincrono: boolean; esperaSegundos: number; silencioMs?: number; alEsperar?: (n: number, app: ReturnType<typeof buildApp>) => Promise<void> }) {
  const base = await buildTestDeps();
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
  await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, { ...PM, replyDebounceSeconds: opts.esperaSegundos });
  const vistos: string[][] = [];
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage({ messages }) {
      vistos.push(messages.filter((m) => m.role === "user").map((m) => m.content));
      return { reply: `respuesta ${vistos.length}`, orderId: null, propertyId: null };
    },
  };
  const esperas: number[] = [];
  const app: ReturnType<typeof buildApp> = buildApp({
    ...base.deps,
    turnHandler: handler,
    relojMs: () => 1_000,
    turnoAsincrono: async () => opts.asincrono,
    ...(opts.silencioMs !== undefined ? { silencioRafagaMs: opts.silencioMs } : {}),
    esperarRafaga: async (ms: number) => {
      const n = esperas.length;
      esperas.push(ms);
      await opts.alEsperar?.(n, app);
    },
  });
  return { ...base, app, vistos, esperas };
}

const enviar = (app: ReturnType<typeof buildApp>, id: string, texto: string) => app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload(id, texto)));

afterEach(() => vi.unstubAllEnvs());

describe("espera de rafagas deslizante (turno asincrono)", () => {
  it("un mensaje solo: espera UNA ventana de silencio (2.5 s), no los 6 s configurados", async () => {
    const s = await setup({ asincrono: true, esperaSegundos: 6 });
    expect((await enviar(s.app, "wamid.1", "Hola")).status).toBe(200);
    expect(s.esperas).toEqual([2_500]);
    expect(s.vistos).toEqual([["Hola"]]);
  });

  it("rafaga rapida: un mensaje llega durante la ventana -> se espera otra ventana y UNA sola respuesta ve los dos", async () => {
    const s = await setup({
      asincrono: true,
      esperaSegundos: 6,
      alEsperar: async (n, app) => {
        if (n === 0) expect((await enviar(app, "wamid.2", "Quiero 1/4 de bistec")).status).toBe(200);
      },
    });
    expect((await enviar(s.app, "wamid.1", "Hola")).status).toBe(200);
    expect(s.esperas).toEqual([2_500, 2_500]);
    expect(s.vistos).toEqual([["Hola", "Quiero 1/4 de bistec"]]);
  });

  it("la suma de ventanas nunca pasa de la espera configurada (6 s)", async () => {
    const s = await setup({
      asincrono: true,
      esperaSegundos: 6,
      alEsperar: async (n, app) => {
        await enviar(app, `wamid.x${n}`, `mensaje ${n}`);
      },
    });
    expect((await enviar(s.app, "wamid.1", "Hola")).status).toBe(200);
    expect(s.esperas).toEqual([2_500, 2_500, 1_000]);
    expect(s.esperas.reduce((a, b) => a + b, 0)).toBe(6_000);
  });

  it("la ventana es configurable (deps / WHATSAPP_RAFAGA_SILENCIO_MS) y nunca excede la espera configurada", async () => {
    const s = await setup({ asincrono: true, esperaSegundos: 6, silencioMs: 2_000 });
    await enviar(s.app, "wamid.1", "Hola");
    expect(s.esperas).toEqual([2_000]);
    const t = await setup({ asincrono: true, esperaSegundos: 1, silencioMs: 2_000 });
    await enviar(t.app, "wamid.1", "Hola");
    expect(t.esperas).toEqual([1_000]);
  });

  it("con la espera configurada en 0 no espera nada, igual que antes", async () => {
    const s = await setup({ asincrono: true, esperaSegundos: 0 });
    await enviar(s.app, "wamid.1", "Hola");
    expect(s.esperas).toEqual([]);
    expect(s.vistos).toEqual([["Hola"]]);
  });

  it("el camino SINCRONO (sin cerebro v2) conserva la espera fija configurada", async () => {
    const s = await setup({ asincrono: false, esperaSegundos: 6 });
    await enviar(s.app, "wamid.1", "Hola");
    expect(s.esperas).toEqual([6_000]);
  });
});

describe("silencioRafagaAsincronaMs (WHATSAPP_RAFAGA_SILENCIO_MS)", () => {
  it("2500 por omision; acepta 500-10000 ms; invalido o fuera de rango = 2500", () => {
    expect(silencioRafagaAsincronaMs({})).toBe(2_500);
    expect(silencioRafagaAsincronaMs({ WHATSAPP_RAFAGA_SILENCIO_MS: "2000" })).toBe(2_000);
    expect(silencioRafagaAsincronaMs({ WHATSAPP_RAFAGA_SILENCIO_MS: "abc" })).toBe(2_500);
    expect(silencioRafagaAsincronaMs({ WHATSAPP_RAFAGA_SILENCIO_MS: "100" })).toBe(2_500);
    expect(silencioRafagaAsincronaMs({ WHATSAPP_RAFAGA_SILENCIO_MS: "60000" })).toBe(2_500);
  });
});
