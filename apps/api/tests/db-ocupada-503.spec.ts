// P0 (PM, cuenta real): con el pool de conexiones saturado, el webhook de WhatsApp devolvia 500 tras 10 s. Ahora el motor lanza
// `DatabaseBusyError` (sobrecarga transitoria, ver packages/db/src/managed-postgres-engine.ts) y la API responde 503 con
// `Retry-After` -- Meta y los clientes reintentan; el ledger de mensajes entrantes evita duplicados.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DatabaseBusyError } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function firmado(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

describe("DatabaseBusyError -> 503 reintentable", () => {
  it("webhook de WhatsApp de restaurantes con el pool saturado: 503 + Retry-After, no 500", async () => {
    const { deps } = await buildTestDeps();
    const saturado = { ...deps.engine, withAppSession: async () => { throw new DatabaseBusyError(0, 10_000); } } as typeof deps.engine;
    const app = buildApp({ ...deps, engine: saturado });
    const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: [{ id: "wamid.busy", from: "5219990000001", type: "text", text: { body: "hola" } }] } }] }] };
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", firmado(payload));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({ code: "service_busy", message: "Servicio ocupado. Intenta de nuevo en unos segundos." });
  });

  it("cualquier otro error del motor sigue siendo 500 (no se enmascara)", async () => {
    const { deps } = await buildTestDeps();
    const roto = { ...deps.engine, withAppSession: async () => { throw new Error("connection terminated"); } } as typeof deps.engine;
    const app = buildApp({ ...deps, engine: roto });
    const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: [{ id: "wamid.roto", from: "5219990000001", type: "text", text: { body: "hola" } }] } }] }] };
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", firmado(payload));
    expect(res.status).toBe(500);
  });
});
