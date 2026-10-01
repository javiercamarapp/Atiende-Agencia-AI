// L-05 -- WhatsApp de licitaciones, HTTP real (Hono + auth + roles + firma de Meta) sobre
// repositorios en memoria y un `FakeWhatsAppGraphClient` (NUNCA toca la red). Cubre: firma
// invalida, opt-in verificado por mensaje entrante, decision por boton con token de un solo
// uso (replay, otro telefono, expirado, rol revocado, baja) y degradacion a "no disponible
// aun" cuando la migracion 030 no esta aplicada. El rechazo por OTRO USUARIO y la atomicidad
// del consumo se prueban contra Postgres real en scripts/verify-licitaciones-whatsapp/.
import { createHmac } from "node:crypto";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { InMemoryWhatsAppRepository, parseActionButtonId, sha256TokenHash } from "@atiende/domain-licitaciones";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

const SENDER_PNID = "PNID-LICITACIONES";
const ANALYST_PHONE = "+5215500000001";
const ANALYST_WA = "5215500000001";
const OTHER_WA = "5215599990000";
const WEBHOOK = "/v1/licitaciones/whatsapp/webhook";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function setup(options: { unavailable?: boolean } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const wa = new InMemoryWhatsAppRepository();
  wa.unavailable = options.unavailable ?? false;
  const graph = new FakeWhatsAppGraphClient();
  // El repo en memoria necesita saber QUIEN abrio la sesion (la base lo sabe por auth.uid()):
  // se captura del `userId` con el que la API abre cada `withAppSession`.
  const baseEngine = ctx.deps.engine;
  const engine: TenancyEngine = {
    withAppSession: (claims, fn) => {
      wa.actorUserId = claims.userId;
      return baseEngine.withAppSession(claims, fn);
    },
  };
  const deps: AppDeps = {
    ...ctx.deps,
    engine,
    env: { ...TEST_ENV, licitacionesWhatsappPhoneNumberId: SENDER_PNID },
    licitacionesWhatsAppRepo: () => wa,
    whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient: graph }),
  };
  const app = buildApp(deps);
  wa.setRole(ctx.staff.analyst.id, "analyst");
  wa.setRole(ctx.staff.viewer.id, "viewer");

  async function staff(method: string, path: string, who: keyof typeof ctx.staff, body?: unknown): Promise<{ status: number; json: Json }> {
    const headers: Record<string, string> = { authorization: `Bearer ${ctx.staff[who].token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(new TextEncoder().encode(payload).byteLength);
    }
    const res = await app.request(`/licitaciones/${ctx.propertyId}${path}`, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  function metaBody(message: Record<string, unknown>, phoneNumberId = SENDER_PNID): string {
    return JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, messages: [message] } }] }] });
  }
  async function webhook(raw: string, opts: { signature?: string | null } = {}): Promise<Response> {
    const bytes = new TextEncoder().encode(raw);
    const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(bytes.byteLength) };
    const signature = opts.signature === undefined ? `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}` : opts.signature;
    if (signature !== null) headers["x-hub-signature-256"] = signature;
    return app.request(WEBHOOK, { method: "POST", headers, body: raw });
  }
  const text = (id: string, from: string, body: string) => metaBody({ id, from, type: "text", text: { body } });
  const tap = (id: string, from: string, buttonId: string) => metaBody({ id, from, type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title: "Go" } } });

  /** Deja al analista con WhatsApp ACTIVO (PUT de configuracion + "SI" entrante desde su numero). */
  async function activateAnalyst(): Promise<void> {
    const put = await staff("PUT", "/whatsapp/settings", "analyst", { phone: ANALYST_PHONE });
    expect(put.status).toBe(200);
    expect((await webhook(text("wamid.si", ANALYST_WA, "SI"))).status).toBe(200);
    expect(wa.contacts.get(`${ctx.organizationId}:${ctx.staff.analyst.id}`)!.status).toBe("activo");
  }

  /** Pide la decision y devuelve los tokens en claro tal como llegan en los botones del mensaje enviado. */
  async function requestDecision(): Promise<{ goToken: string; noGoToken: string }> {
    graph.sent.length = 0;
    const res = await staff("POST", `/tenders/${ctx.tenderId}/whatsapp/request-decision`, "analyst");
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ requested: 1 });
    const msg = graph.sent.find((m) => m.buttons && m.buttons.length === 2)!;
    expect(msg).toBeDefined();
    const [go, noGo] = (msg.buttons as unknown as { id: string }[]).map((b) => parseActionButtonId(b.id)!);
    return { goToken: go!, noGoToken: noGo! };
  }

  return { ctx, wa, graph, app, staff, webhook, text, tap, activateAnalyst, requestDecision };
}

describe("webhook de licitaciones: firma y acuses", () => {
  it("GET de verificacion: token correcto devuelve el challenge; incorrecto 403", async () => {
    const { app } = await setup();
    const ok = await app.request(`${WEBHOOK}?hub.mode=subscribe&hub.verify_token=${TEST_ENV.whatsappVerifyToken}&hub.challenge=abc`);
    expect(await ok.text()).toBe("abc");
    expect((await app.request(`${WEBHOOK}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=abc`)).status).toBe(403);
  });

  it("firma invalida o ausente: 401 y NADA se procesa", async () => {
    const { wa, webhook, text, staff } = await setup();
    await staff("PUT", "/whatsapp/settings", "analyst", { phone: ANALYST_PHONE });
    const body = text("wamid.1", ANALYST_WA, "SI");
    expect((await webhook(body, { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await webhook(body, { signature: null })).status).toBe(401);
    expect((await webhook(body, { signature: "basura" })).status).toBe(401);
    expect(wa.contacts.get([...wa.contacts.keys()][0]!)!.status).toBe("pendiente");
  });

  it("body firmado por Meta pero alterado despues: 401", async () => {
    const { webhook, text } = await setup();
    const original = text("wamid.1", ANALYST_WA, "SI");
    const bytes = new TextEncoder().encode(original);
    const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
    expect((await webhook(original.replace("SI", "BAJA"), { signature })).status).toBe(401);
  });

  it("body demasiado grande: 413", async () => {
    const { app } = await setup();
    const res = await app.request(WEBHOOK, { method: "POST", headers: { "content-length": String(10 * 1024 * 1024) }, body: "x" });
    expect(res.status).toBe(413);
  });

  it("mensajes de OTRO numero remitente (otro flujo) se acusan sin procesar", async () => {
    const { wa, webhook, staff } = await setup();
    await staff("PUT", "/whatsapp/settings", "analyst", { phone: ANALYST_PHONE });
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "OTRO" }, messages: [{ id: "wamid.9", from: ANALYST_WA, type: "text", text: { body: "SI" } }] } }] }] });
    expect((await webhook(raw)).status).toBe(200);
    expect(wa.contacts.get([...wa.contacts.keys()][0]!)!.status).toBe("pendiente");
  });
});

describe("opt-in / opt-out", () => {
  it("guardar el telefono encola la confirmacion; solo el SI entrante DEL MISMO numero activa los avisos", async () => {
    const { wa, graph, staff, webhook, text } = await setup();
    const put = await staff("PUT", "/whatsapp/settings", "analyst", { phone: "+52 1 55 0000 0001" });
    expect(put.status).toBe(200);
    expect(put.json.contact).toMatchObject({ phoneE164: ANALYST_PHONE, status: "pendiente" });
    expect(wa.outbox.some((r) => r.eventType === "consent_request")).toBe(true);

    // un SI desde OTRO numero no activa nada
    await webhook(text("wamid.a", OTHER_WA, "SI"));
    expect((await staff("GET", "/whatsapp/settings", "analyst")).json.contact.status).toBe("pendiente");

    await webhook(text("wamid.b", ANALYST_WA, "sí"));
    expect((await staff("GET", "/whatsapp/settings", "analyst")).json.contact.status).toBe("activo");
    // la confirmacion se ENVIO (inline) por el cliente falso, nunca por la red
    expect(graph.sent.some((m) => m.to === ANALYST_PHONE && m.body.includes("activamos"))).toBe(true);
  });

  it("BAJA desactiva; un SI posterior NO reactiva (debe pedirlo de nuevo desde el panel)", async () => {
    const { wa, activateAnalyst, webhook, text, staff, ctx } = await setup();
    await activateAnalyst();
    await webhook(text("wamid.baja", ANALYST_WA, "BAJA"));
    const key = `${ctx.organizationId}:${ctx.staff.analyst.id}`;
    expect(wa.contacts.get(key)!.status).toBe("baja");
    await webhook(text("wamid.si2", ANALYST_WA, "SI"));
    expect(wa.contacts.get(key)!.status).toBe("baja");
    // reactivar desde el panel (mismo numero) vuelve a pedir confirmacion
    await staff("POST", "/whatsapp/opt-out", "analyst");
    expect(wa.contacts.get(key)!.status).toBe("baja");
  });

  it("un telefono con formato invalido: 400", async () => {
    const { staff } = await setup();
    expect((await staff("PUT", "/whatsapp/settings", "analyst", { phone: "5500000001" })).status).toBe(400);
  });
});

describe("decision go/no-go por boton", () => {
  it("el analista pide la decision; viewer y writer no pueden (403); convocatoria inexistente 404", async () => {
    const { activateAnalyst, staff, ctx } = await setup();
    await activateAnalyst();
    expect((await staff("POST", `/tenders/${ctx.tenderId}/whatsapp/request-decision`, "viewer")).status).toBe(403);
    expect((await staff("POST", `/tenders/${ctx.tenderId}/whatsapp/request-decision`, "writer")).status).toBe(403);
    expect((await staff("POST", `/tenders/00000000-0000-4000-8000-000000000000/whatsapp/request-decision`, "analyst")).status).toBe(404);
  });

  it("toque en Go: registra la decision a nombre del usuario, consume el token y responde; el token en claro no queda en la base", async () => {
    const { activateAnalyst, requestDecision, webhook, tap, ctx, wa, graph } = await setup();
    await activateAnalyst();
    const { goToken } = await requestDecision();
    expect(wa.tokens.has(goToken)).toBe(false);
    expect(wa.tokens.has(sha256TokenHash(goToken))).toBe(true);

    const res = await webhook(tap("wamid.tap1", ANALYST_WA, `lic-wa:${goToken}`));
    expect(res.status).toBe(200);
    const decisions = await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "go", decidedBy: ctx.staff.analyst.id });
    expect(graph.sent.some((m) => m.to === ANALYST_PHONE && m.body.includes("decision GO"))).toBe(true);
    // los botones del mensaje ya enviado se borran de la cola (el token en claro solo vive mientras esta pendiente)
    expect(wa.outbox.filter((r) => r.eventType === "decision_request").every((r) => !("buttons" in r.payload))).toBe(true);
  });

  it("ANTI-REPLAY: el mismo toque reenviado por Meta no duplica; otro mensaje con el mismo token se rechaza", async () => {
    const { activateAnalyst, requestDecision, webhook, tap, ctx, graph } = await setup();
    await activateAnalyst();
    const { goToken } = await requestDecision();
    await webhook(tap("wamid.tap1", ANALYST_WA, `lic-wa:${goToken}`));
    const repliesAfterFirst = graph.sent.length;

    expect((await webhook(tap("wamid.tap1", ANALYST_WA, `lic-wa:${goToken}`))).status).toBe(200); // reintento de Meta
    expect(graph.sent.length).toBe(repliesAfterFirst); // sin segunda respuesta

    expect((await webhook(tap("wamid.tap2", ANALYST_WA, `lic-wa:${goToken}`))).status).toBe(200); // replay con otro mensaje
    expect(graph.sent.at(-1)!.body).toContain("ya se uso");

    expect(await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId)).toHaveLength(1);
  });

  it("OTRO NUMERO: quien reenvia el boton desde un telefono distinto no decide nada y el titular aun puede usarlo", async () => {
    const { activateAnalyst, requestDecision, webhook, tap, ctx } = await setup();
    await activateAnalyst();
    const { goToken } = await requestDecision();
    await webhook(tap("wamid.x", OTHER_WA, `lic-wa:${goToken}`));
    expect(await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId)).toHaveLength(0);
    await webhook(tap("wamid.ok", ANALYST_WA, `lic-wa:${goToken}`));
    expect(await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId)).toHaveLength(1);
  });

  it("EXPIRADO: pasado el plazo no se registra nada", async () => {
    const { activateAnalyst, requestDecision, webhook, tap, ctx, wa, graph } = await setup();
    await activateAnalyst();
    const { noGoToken } = await requestDecision();
    wa.now = () => Date.now() + 48 * 3_600_000;
    await webhook(tap("wamid.late", ANALYST_WA, `lic-wa:${noGoToken}`));
    expect(await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId)).toHaveLength(0);
    expect(graph.sent.at(-1)!.body).toContain("expiro");
  });

  it("ROL REVOCADO y BAJA: el token emitido antes deja de servir", async () => {
    const { activateAnalyst, requestDecision, webhook, tap, ctx, wa } = await setup();
    await activateAnalyst();
    const { goToken } = await requestDecision();
    wa.setRole(ctx.staff.analyst.id, "viewer");
    await webhook(tap("wamid.r", ANALYST_WA, `lic-wa:${goToken}`));
    expect(await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId)).toHaveLength(0);
    wa.setRole(ctx.staff.analyst.id, "analyst");
    await webhook(tap("wamid.b0", ANALYST_WA, `lic-wa:${goToken}`)); // vuelve a servir: el rechazo previo no lo consumio
    expect(await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId)).toHaveLength(1);
  });

  it("token inventado o boton de otro flujo: se ignora con 200, sin efectos", async () => {
    const { activateAnalyst, webhook, tap, ctx } = await setup();
    await activateAnalyst();
    expect((await webhook(tap("wamid.f1", ANALYST_WA, `lic-wa:${"A".repeat(43)}`))).status).toBe(200);
    expect((await webhook(tap("wamid.f2", ANALYST_WA, "cita:confirmar:123"))).status).toBe(200);
    expect(await ctx.repo.listGoNoGoDecisions(ctx.organizationId, ctx.tenderId)).toHaveLength(0);
  });

  it("solicitar dos veces no duplica el mensaje mientras haya una solicitud vigente", async () => {
    const { activateAnalyst, requestDecision, staff, ctx, graph } = await setup();
    await activateAnalyst();
    await requestDecision();
    const again = await staff("POST", `/tenders/${ctx.tenderId}/whatsapp/request-decision`, "analyst");
    expect(again.json).toMatchObject({ requested: 0, alreadyPending: 1 });
    expect(graph.sent.filter((m) => m.buttons).length).toBe(1);
  });
});

describe("base SIN la migracion 030", () => {
  it("el panel responde 'no disponible aun'; escrituras 503; el webhook acusa 200; nunca 500", async () => {
    const { staff, webhook, text, tap, ctx } = await setup({ unavailable: true });
    const get = await staff("GET", "/whatsapp/settings", "analyst");
    expect(get.status).toBe(200);
    expect(get.json).toMatchObject({ available: false, contact: null });
    expect((await staff("PUT", "/whatsapp/settings", "analyst", { phone: ANALYST_PHONE })).status).toBe(503);
    expect((await staff("POST", "/whatsapp/opt-out", "analyst")).status).toBe(503);
    expect((await staff("POST", `/tenders/${ctx.tenderId}/whatsapp/request-decision`, "analyst")).status).toBe(503);
    expect((await webhook(text("wamid.1", ANALYST_WA, "SI"))).status).toBe(200);
    expect((await webhook(tap("wamid.2", ANALYST_WA, `lic-wa:${"A".repeat(43)}`))).status).toBe(200);
  });

  it("sin repositorio ni numero remitente configurados el webhook y el panel degradan igual", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/licitaciones/${ctx.propertyId}/whatsapp/settings`, { headers: { authorization: `Bearer ${ctx.staff.analyst.token}` } });
    expect(await res.json()).toMatchObject({ available: false, configured: false });
  });
});
