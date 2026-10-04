// Batería PM F3b — seguridad y abuso del webhook de WhatsApp de restaurantes (HTTP real con app.request):
// firma, cabeceras falsas, cuerpos malformados/enormes, multimedia inesperada y lotes de Meta que mezclan números.
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

const URL_WEBHOOK = "/v1/restaurantes/whatsapp/webhook";

function signRaw(raw: string, secret = TEST_ENV.whatsappAppSecret): RequestInit {
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}
const signed = (body: unknown, extraHeaders: Record<string, string> = {}): RequestInit => {
  const init = signRaw(JSON.stringify(body));
  return { ...init, headers: { ...(init.headers as Record<string, string>), ...extraHeaders } };
};

const msg = (id: string, over: Record<string, unknown> = {}) => ({ id, from: "5219991234567", type: "text", text: { body: "Hola, quiero un pedido" }, ...over });
const payload = (phoneNumberId: string, messages: unknown[]) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages } }] }] });

async function setup() {
  const base = await buildTestDeps();
  const seen: Array<{ organizationId: string; propertyId: string | null | undefined; phone: string; last: string }> = [];
  const recording: WhatsAppTurnHandler = {
    async handleInboundMessage(args) {
      seen.push({ organizationId: args.organizationId, propertyId: args.propertyId, phone: args.phone, last: args.messages.at(-1)?.content ?? "" });
      return { reply: "ok", orderId: null, propertyId: null };
    },
  };
  const app = buildApp({ ...base.deps, turnHandler: recording });
  return { ...base, app, seen };
}

describe("T-AB09 firma del webhook", () => {
  it("sin firma, con firma de otro secreto, de otro cuerpo, mal formada o vacía: 401 y NADA se procesa", async () => {
    const { app, seen } = await setup();
    const body = payload("1234567890", [msg("wamid.f1")]);
    const raw = JSON.stringify(body);
    const ok = signRaw(raw);
    const sinFirma: RequestInit = { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length) } };
    const otroSecreto = signRaw(raw, "otro-secreto-de-meta");
    const otroCuerpo = { ...signRaw(JSON.stringify(payload("1234567890", [msg("wamid.f1b")]))), body: raw };
    const sinPrefijo = { ...ok, headers: { ...(ok.headers as Record<string, string>), "x-hub-signature-256": ((ok.headers as Record<string, string>)["x-hub-signature-256"] as string).replace("sha256=", "") } };
    const vacia = { ...ok, headers: { ...(ok.headers as Record<string, string>), "x-hub-signature-256": "" } };
    const corta = { ...ok, headers: { ...(ok.headers as Record<string, string>), "x-hub-signature-256": "sha256=abcd" } };
    for (const init of [sinFirma, otroSecreto, otroCuerpo, sinPrefijo, vacia, corta]) {
      expect((await app.request(URL_WEBHOOK, init)).status).toBe(401);
    }
    expect(seen).toHaveLength(0);
    expect((await app.request(URL_WEBHOOK, ok)).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("el handshake GET con verify_token vacío, ausente o casi igual responde 403", async () => {
    const { app } = await setup();
    for (const q of ["", "&hub.verify_token=", `&hub.verify_token=${TEST_ENV.whatsappVerifyToken}x`, `&hub.verify_token=${TEST_ENV.whatsappVerifyToken.slice(1)}`]) {
      expect((await app.request(`${URL_WEBHOOK}?hub.mode=subscribe&hub.challenge=abc${q}`)).status).toBe(403);
    }
    expect((await app.request(`${URL_WEBHOOK}?hub.mode=unsubscribe&hub.challenge=abc&hub.verify_token=${TEST_ENV.whatsappVerifyToken}`)).status).toBe(403);
  });
});

describe("T-AB10 abuso por volumen y cabeceras falsas", () => {
  it("rotar el primer salto de X-Forwarded-For / X-Real-IP no evade el límite (cuenta el último salto, que pone la plataforma)", async () => {
    const { app } = await setup();
    let ultimo = 0;
    for (let i = 0; i < 121; i += 1) {
      const res = await app.request(URL_WEBHOOK, signed(payload("1234567890", [msg("wamid.r1")]), { "x-forwarded-for": `10.0.${i % 250}.${i % 200}, 203.0.113.9`, "x-real-ip": `10.9.9.${i % 250}`, "cf-connecting-ip": `10.7.7.${i % 250}` }));
      ultimo = res.status;
    }
    expect(ultimo).toBe(429);
  });
});

describe("T-AB11 cuerpos malformados y enormes", () => {
  it("JSON inválido pero bien firmado: 400; cuerpo vacío firmado: 400", async () => {
    const { app, seen } = await setup();
    expect((await app.request(URL_WEBHOOK, signRaw("{no es json"))).status).toBe(400);
    expect((await app.request(URL_WEBHOOK, signRaw(""))).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("content-length declarado o real mayor a 256 KB: 413 sin leer más ni procesar", async () => {
    const { app, seen } = await setup();
    const enorme = signRaw(JSON.stringify(payload("1234567890", [msg("wamid.big", { text: { body: "a".repeat(300_000) } })])));
    expect((await app.request(URL_WEBHOOK, enorme)).status).toBe(413);
    const miente = signRaw("{}");
    expect((await app.request(URL_WEBHOOK, { ...miente, headers: { ...(miente.headers as Record<string, string>), "content-length": "999999999" } })).status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("estructuras raras bien firmadas se acusan 200 sin lanzar ni procesar: entry no arreglo, changes null, messages objeto, from no numérico, id gigante, texto de 4097 chars (mas que el limite de Meta)", async () => {
    const { app, seen } = await setup();
    const casos: unknown[] = [
      { entry: "x" },
      { entry: [null, 7, "x", {}] },
      { entry: [{ changes: null }] },
      { entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: { id: "x" } } }] }] },
      payload("1234567890", [msg("wamid.n1", { from: "abc'; DROP TABLE x;--" })]),
      payload("1234567890", [msg("a".repeat(300))]),
      payload("1234567890", [msg("wamid.n2", { text: { body: "z".repeat(4097) } })]),
      payload("1234567890", [msg("wamid.n3", { text: { body: "   " } })]),
      payload("1234567890", [null, 5, "x"]),
      [],
      null,
    ];
    for (const caso of casos) {
      const res = await app.request(URL_WEBHOOK, signRaw(JSON.stringify(caso)));
      expect(res.status, JSON.stringify(caso).slice(0, 80)).toBeLessThan(500);
    }
    expect(seen).toHaveLength(0);
  });

  it("multimedia inesperada (audio, imagen, ubicación, sticker, reacción) se acusa 200 y no dispara turno de LLM", async () => {
    const { app, seen } = await setup();
    const res = await app.request(
      URL_WEBHOOK,
      signed(
        payload("1234567890", [
          { id: "wamid.au", from: "5219991234567", type: "audio", audio: { id: "m1", voice: true } },
          { id: "wamid.im", from: "5219991234567", type: "image", image: { id: "m2" } },
          { id: "wamid.lo", from: "5219991234567", type: "location", location: { latitude: 21, longitude: -89 } },
          { id: "wamid.st", from: "5219991234567", type: "sticker", sticker: { id: "m3" } },
          { id: "wamid.re", from: "5219991234567", type: "reaction", reaction: { emoji: "👍" } },
        ]),
      ),
    );
    expect(res.status).toBe(200);
    expect(seen.filter((s) => s.last.includes("wamid"))).toHaveLength(0);
  });
});

describe("T-AB12 aislamiento entre números dentro de un mismo lote firmado", () => {
  it("un lote con dos números (changes) de ORGANIZACIONES distintas procesa cada mensaje con SU organización, nunca con la del primer cambio", async () => {
    const { app, seen, restaurantesRepo, organizationId } = await setup();
    const orgB = randomUUID();
    restaurantesRepo.seedOrganization({ id: orgB, slug: "restaurante-b", name: "Restaurante B" });
    restaurantesRepo.seedWhatsAppChannel(orgB, "pn-org-b");
    const lote = {
      entry: [
        {
          changes: [
            { value: { metadata: { phone_number_id: "1234567890" }, messages: [msg("wamid.A1", { text: { body: "para A" } })] } },
            { value: { metadata: { phone_number_id: "pn-org-b" }, messages: [msg("wamid.B1", { from: "5219990001111", text: { body: "para B" } })] } },
          ],
        },
      ],
    };
    const res = await app.request(URL_WEBHOOK, signed(lote));
    expect(res.status).toBe(200);
    const paraB = seen.find((s) => s.last === "para B");
    const paraA = seen.find((s) => s.last === "para A");
    expect(paraA?.organizationId).toBe(organizationId);
    expect(paraB?.organizationId).toBe(orgB);
  });

  it("un lote con el número de la sucursal A y el de la sucursal B conserva la sucursal de cada mensaje", async () => {
    const { app, seen, restaurantesRepo, organizationId, propertyId } = await setup();
    const propertyB = randomUUID();
    restaurantesRepo.seedBranch({ propertyId: propertyB, organizationId, name: "Otra", slug: "otra", status: "active", phone: null, address: null, lat: null, lng: null });
    restaurantesRepo.seedWhatsAppBranchChannel(organizationId, propertyId, "pn-a");
    restaurantesRepo.seedWhatsAppBranchChannel(organizationId, propertyB, "pn-b");
    const lote = {
      entry: [
        {
          changes: [
            { value: { metadata: { phone_number_id: "pn-a" }, messages: [msg("wamid.SA", { text: { body: "en A" } })] } },
            { value: { metadata: { phone_number_id: "pn-b" }, messages: [msg("wamid.SB", { from: "5219990002222", text: { body: "en B" } })] } },
          ],
        },
      ],
    };
    await app.request(URL_WEBHOOK, signed(lote));
    expect(seen.find((s) => s.last === "en A")?.propertyId).toBe(propertyId);
    expect(seen.find((s) => s.last === "en B")?.propertyId).toBe(propertyB);
  });

  it("un cambio con número DESCONOCIDO dentro de un lote no arrastra sus mensajes a otra organización", async () => {
    const { app, seen } = await setup();
    const lote = {
      entry: [
        {
          changes: [
            { value: { metadata: { phone_number_id: "pn-desconocido" }, messages: [msg("wamid.U1", { text: { body: "huérfano" } })] } },
            { value: { metadata: { phone_number_id: "1234567890" }, messages: [msg("wamid.U2", { from: "5219990003333", text: { body: "legítimo" } })] } },
          ],
        },
      ],
    };
    const res = await app.request(URL_WEBHOOK, signed(lote));
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.last)).toEqual(["legítimo"]);
  });
});
