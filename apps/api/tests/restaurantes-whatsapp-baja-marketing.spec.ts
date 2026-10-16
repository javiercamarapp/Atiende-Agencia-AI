// Autopiloto 2: BAJA / ALTO por el webhook de WhatsApp de restaurantes tambien REVOCA el consentimiento de marketing de ese telefono en LA
// organizacion del numero que recibio el mensaje (y mata los mensajes de campana aun pendientes: lo hace la base, probada contra Postgres real).
// Solo cuenta el mensaje COMPLETO como palabra de baja; una frase normal no revoca nada; contra la base sin migrar el webhook no se altera.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

const payload = (texto: string, id: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: [{ id, from: "5219991234567", type: "text", text: { body: texto } }] } }] }] });

async function setup(modo: "ok" | "sin_migrar" = "ok") {
  const base = await buildTestDeps();
  const revocaciones: unknown[][] = [];
  const turnos: string[] = [];
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/marketing_revocar_por_telefono/.test(sql)) {
        if (modo === "sin_migrar") throw Object.assign(new Error("function restaurantes.marketing_revocar_por_telefono(uuid, text) does not exist"), { code: "42883" });
        revocaciones.push(params ?? []);
        return { rows: [{ revocados: 1 }] as unknown as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => base.deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage(args) {
      turnos.push(args.messages[args.messages.length - 1]!.content);
      return { reply: "ok", orderId: null, propertyId: null };
    },
  };
  const app = buildApp({ ...base.deps, engine, turnHandler });
  return { ...base, app, revocaciones, turnos };
}

describe("webhook de WhatsApp de restaurantes: BAJA revoca el consentimiento de marketing", () => {
  it.each(["BAJA", "alto", "  Stop. "])("%j (mensaje completo) revoca el consentimiento del telefono en la organizacion del numero", async (texto) => {
    const s = await setup();
    const res = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload(texto, `wamid.baja-${texto.trim()}`)));
    expect(res.status).toBe(200);
    expect(s.revocaciones).toEqual([[s.organizationId, "+5219991234567"]]);
  });

  it("una frase normal que contiene la palabra NO revoca nada y llega al agente", async () => {
    const s = await setup();
    const res = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("quiero una orden de tacos, alto en picante", "wamid.frase1")));
    expect(res.status).toBe(200);
    expect(s.revocaciones).toEqual([]);
    expect(s.turnos).toHaveLength(1);
  });

  it("base sin la migracion 052: el webhook responde 200 igual (la baja de plataforma sigue su camino)", async () => {
    const s = await setup("sin_migrar");
    const res = await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload("BAJA", "wamid.baja-sin-migrar")));
    expect(res.status).toBe(200);
  });
});
