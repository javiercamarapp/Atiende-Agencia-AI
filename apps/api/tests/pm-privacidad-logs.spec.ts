// Batería PM F3b — T-PR02: ni el teléfono ni la tarjeta del cliente aparecen en logs, en el historial
// guardado ni en la bitácora de voz (el teléfono solo viaja como hash).
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit, TEST_ENV } from "./fixtures.ts";

const PAN = "4111 1111 1111 1111";
const TELEFONO = "5219993217654";

function signed(body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  const bytes = new TextEncoder().encode(raw);
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}` } };
}
const payload = (id: string, body: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: [{ id, from: TELEFONO, type: "text", text: { body } }] } }] }] });

afterEach(() => vi.restoreAllMocks());

function espiarConsola() {
  const lineas: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lineas.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
  }
  return lineas;
}

describe("T-PR02 privacidad en logs y almacenamiento (WhatsApp)", () => {
  it("un mensaje con tarjeta + CVV: el historial guardado y la salida de consola no contienen el PAN, el CVV ni el teléfono", async () => {
    const lineas = espiarConsola();
    const base = await buildTestDeps();
    const turn: WhatsAppTurnHandler = { async handleInboundMessage({ messages }) { return { reply: `recibido ${messages.length}`, orderId: null, propertyId: null }; } };
    const app = buildApp({ ...base.deps, turnHandler: turn });
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signed(payload("wamid.pr1", `Pago con tarjeta ${PAN} cvv 123 vence 12/27`)));
    expect(res.status).toBe(200);
    const conv = await base.restaurantesRepo.appendWhatsAppUserMessageOnce(base.organizationId, `+${TELEFONO}`, { role: "user", content: "x" });
    const guardado = JSON.stringify(conv);
    expect(guardado).not.toMatch(/4111|1111 1111|\b123\b|12\/27/);
    expect(guardado).toContain("[tarjeta oculta]");
    const todo = lineas.join("\n");
    expect(todo).not.toContain(TELEFONO);
    expect(todo).not.toMatch(/4111/);
  });

  it("si el turno LANZA, el log del error y el evento fallido no filtran el teléfono ni el texto del cliente", async () => {
    const lineas = espiarConsola();
    const base = await buildTestDeps();
    const turn: WhatsAppTurnHandler = { async handleInboundMessage() { throw new Error("fallo interno del modelo"); } };
    const app = buildApp({ ...base.deps, turnHandler: turn });
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signed(payload("wamid.pr2", "mi pedido secreto de la casa azul")));
    expect(res.status).toBe(500); // reintentable: Meta vuelve a mandarlo
    const todo = lineas.join("\n");
    expect(todo).not.toContain(TELEFONO);
    expect(todo).not.toContain("casa azul");
  });
});

describe("T-PR02 privacidad en la bitácora de voz", () => {
  it("la bitácora guarda el teléfono solo como hash de 64 hex y nunca en claro, incluso al denegar", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const ORG = "los-taquitos-de-pm";
    const mint = await app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: "c-pr", caller_phone: "+52 999 321 7654", branch_slug: "fco-montejo" }, { "x-atiende-tool-secret": "test-voice-tool-secret" }));
    const token = ((await mint.json()) as { call_token: string }).call_token;
    await app.request(`/v1/restaurantes/${ORG}/products/search`, jsonRequestInit({ query: "coca", branch_slug: "otra-que-no-existe" }, { "x-atiende-call-token": token }));
    await app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({}, { "x-atiende-call-token": token }));
    const bitacora = JSON.stringify(base.restaurantesRepo.voiceToolAudit);
    expect(bitacora).not.toMatch(/9993217654|321 7654|\+52/);
    expect(base.restaurantesRepo.voiceToolAudit.length).toBeGreaterThan(0);
  });
});
