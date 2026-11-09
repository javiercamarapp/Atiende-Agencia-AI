// Webhook de restaurantes con credenciales de Meta por organizacion (migracion 0090): la app propia de PM firma con SU secreto,
// tiene SU verify token y solo puede hablar por SUS numeros; la app de plataforma sigue igual para los demas.
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PuertoNotasDeVoz, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { aadCredencialMeta, crearCifradorCredencialesMeta, crearResolutorCredencialesMeta, hashVerifyToken, type FilaCredencialSistema } from "../src/whatsapp-credenciales/index.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

const cifrador = crearCifradorCredencialesMeta(randomBytes(32), 1);
const PM_SECRETO = "secreto-app-pm";
const PM_VERIFY = "verify-token-de-pm-123";

function postFirmado(body: unknown, secreto: string | null): RequestInit {
  const raw = JSON.stringify(body);
  const bytes = new TextEncoder().encode(raw);
  const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(bytes.byteLength) };
  if (secreto) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secreto).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers };
}

const texto = (pn: string, id: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pn }, messages: [{ id, from: "5219991234567", type: "text", text: { body: "Hola, quiero pedir" } }] } }] }] });
const audio = (pn: string, id: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pn }, messages: [{ id, from: "5219991234567", type: "audio", audio: { id: "media-1", voice: true } }] } }] }] });

async function setup() {
  const base = await buildTestDeps();
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "5550001");
  const fila: FilaCredencialSistema = {
    id: "cred-pm",
    organization_id: base.organizationId,
    app_id: "100001",
    waba_id: "200001",
    app_secret_cifrado: cifrador.cifrar(PM_SECRETO, aadCredencialMeta("cred-pm", base.organizationId, "app_secret")),
    access_token_cifrado: cifrador.cifrar("token-pm", aadCredencialMeta("cred-pm", base.organizationId, "access_token")),
    verify_token_hash: hashVerifyToken(PM_VERIFY),
    phone_number_ids: ["5550001"],
  };
  const resolutor = crearResolutorCredencialesMeta({ leer: async () => [fila], cifrador });
  const vistos: string[] = [];
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage(args) {
      vistos.push(args.messages[args.messages.length - 1]!.content);
      return { reply: "ok", orderId: null, propertyId: null };
    },
  };
  const descargas: string[] = [];
  const puerto = (quien: string): PuertoNotasDeVoz => ({
    async descargar() {
      descargas.push(quien);
      throw new Error("sin red en pruebas");
    },
    async transcribir() {
      return { texto: "" };
    },
  });
  const tokensDePuerto: string[] = [];
  const app = buildApp({
    ...base.deps,
    turnHandler,
    whatsappMeta: { cifrador, resolutor },
    notasDeVoz: puerto("plataforma"),
    notasDeVozConToken: (token: string) => {
      tokensDePuerto.push(token);
      return puerto("pm");
    },
  });
  return { app, vistos, descargas, tokensDePuerto };
}

describe("POST /v1/restaurantes/whatsapp/webhook — app propia de la organizacion", () => {
  it("un mensaje firmado con el secreto de la app de PM para SU numero se procesa", async () => {
    const { app, vistos } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", postFirmado(texto("5550001", "wamid.pm1"), PM_SECRETO));
    expect(res.status).toBe(200);
    expect(vistos).toEqual(["Hola, quiero pedir"]);
  });

  it("la app de PM no puede hablar por un numero que no es suyo (se acusa sin procesar)", async () => {
    const { app, vistos } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", postFirmado(texto("1234567890", "wamid.pm2"), PM_SECRETO));
    expect(res.status).toBe(200);
    expect(vistos).toEqual([]);
  });

  it("la app de plataforma no puede hablar por un numero que tiene app propia", async () => {
    const { app, vistos } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", postFirmado(texto("5550001", "wamid.pm3"), TEST_ENV.whatsappAppSecret));
    expect(res.status).toBe(200);
    expect(vistos).toEqual([]);
  });

  it("la app de plataforma sigue procesando sus numeros de siempre", async () => {
    const { app, vistos } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", postFirmado(texto("1234567890", "wamid.pm4"), TEST_ENV.whatsappAppSecret));
    expect(res.status).toBe(200);
    expect(vistos).toHaveLength(1);
  });

  it("sin firma o con un secreto desconocido: 401, como antes", async () => {
    const { app, vistos } = await setup();
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", postFirmado(texto("5550001", "wamid.pm5"), null))).status).toBe(401);
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", postFirmado(texto("5550001", "wamid.pm6"), "otro-secreto"))).status).toBe(401);
    expect(vistos).toEqual([]);
  });

  it("una nota de voz del numero de PM usa el puerto con el token de PM, nunca el de plataforma", async () => {
    const { app, descargas, tokensDePuerto } = await setup();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", postFirmado(audio("5550001", "wamid.pm7"), PM_SECRETO));
    expect(res.status).toBe(200);
    expect(tokensDePuerto).toEqual(["token-pm"]);
    expect(descargas).not.toContain("plataforma");
  });
});

describe("GET /v1/restaurantes/whatsapp/webhook — verify token por app", () => {
  const url = (token: string) => `/v1/restaurantes/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=reto-123`;

  it("acepta el verify token de plataforma y el de la app de PM; rechaza cualquier otro", async () => {
    const { app } = await setup();
    const plat = await app.request(url(TEST_ENV.whatsappVerifyToken));
    expect(plat.status).toBe(200);
    expect(await plat.text()).toBe("reto-123");
    const pm = await app.request(url(PM_VERIFY));
    expect(pm.status).toBe(200);
    expect(await pm.text()).toBe("reto-123");
    expect((await app.request(url("verify-token-de-pm-124"))).status).toBe(403);
  });
});
