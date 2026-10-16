// PM PR-9 (restaurantes) -- privacidad: panel ARCO (owner/admin), configuracion, lado sistema de voz,
// purga por retencion y el webhook de WhatsApp con aviso + fast-path ARCO. HTTP real via app.request
// con repositorios en memoria. Cubre autenticacion, roles, cross-tenant y la base sin migrar
// (disponible:false / 503, nunca un 500).
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryPrivacidadRepository } from "@atiende/domain-restaurantes";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const PHONE = "+5219981234567";

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const privacy = new InMemoryPrivacidadRepository();
  const deps: AppDeps = { ...ctx.deps, privacidadRepo: () => privacy };
  const app = envolver(buildApp(deps));
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/privacidad`;
  async function seedConfirmed(right: "acceso" | "cancelacion" = "acceso", phone = PHONE): Promise<string> {
    const reg = await privacy.registerDataRightsRequestAsSystem({ organizationId: ctx.organizationId, customerPhone: phone, rightType: right, channel: "whatsapp", detail: "mensaje" });
    if (!reg.available) throw new Error("fixture");
    await privacy.resolveDataRightsConfirmationAsSystem(ctx.organizationId, phone, true);
    return reg.id;
  }
  return { ctx, privacy, deps, app, base, seedConfirmed };
}

describe("GET .../admin/privacidad/solicitudes", () => {
  it("exige token (401)", async () => {
    const { app, base } = await construir();
    expect((await app.request(`${base}/solicitudes`)).status).toBe(401);
  });

  it("rol staff y repartidor -> 403: los telefonos de titulares no son para todo el staff", async () => {
    const { app, base, ctx } = await construir();
    expect((await app.request(`${base}/solicitudes`, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(`${base}/solicitudes`, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
  });

  it("owner y admin listan con folio, estado, canal, base de identidad y estado de vencimiento", async () => {
    const { app, base, ctx, seedConfirmed } = await construir();
    const id = await seedConfirmed();
    for (const token of [ctx.staff.owner.token, ctx.staff.admin.token]) {
      const res = await app.request(`${base}/solicitudes`, authedGet(token));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.disponible).toBe(true);
      expect(body.plazos).toEqual({ respuestaDias: 20, ejecucionDias: 15 });
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ id, estado: "recibida", derecho: "acceso", canal: "whatsapp", identidadVerificadaPor: "whatsapp_numero", plazo: "en_plazo" });
      expect(body.items[0].folio).toHaveLength(8);
    }
  });

  it("filtros por estado y derecho; valores invalidos -> 400", async () => {
    const { app, base, ctx, seedConfirmed } = await construir();
    await seedConfirmed("acceso", "+5219990000001");
    await seedConfirmed("cancelacion", "+5219990000002");
    const only = await (await app.request(`${base}/solicitudes?derecho=cancelacion`, authedGet(ctx.staff.owner.token))).json();
    expect(only.items.map((i: { derecho: string }) => i.derecho)).toEqual(["cancelacion"]);
    expect((await app.request(`${base}/solicitudes?estado=inventado`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base}/solicitudes?derecho=inventado`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base}/solicitudes?limit=12abc`, authedGet(ctx.staff.owner.token))).status).toBe(400);
  });

  it("base sin migrar: 200 con disponible:false (nunca un 500 ni una lista vacia que parezca real)", async () => {
    const { app, base, ctx, privacy } = await construir();
    privacy.migrada = false;
    const res = await app.request(`${base}/solicitudes`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, total: 0, items: [] });
  });

  it("cross-tenant: el owner de OTRA organizacion recibe 403 en esta sucursal", async () => {
    const { app, base, ctx, seedConfirmed } = await construir();
    await seedConfirmed();
    expect((await app.request(`${base}/solicitudes`, authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
  });

  it("sin repositorio de privacidad en el despliegue: 503 explicito", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = envolver(buildApp({ ...ctx.deps }));
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/privacidad/solicitudes`, authedGet(ctx.staff.owner.token))).status).toBe(503);
  });
});

describe("PATCH .../solicitudes/:id/estado y GET .../:id/eventos", () => {
  it("owner mueve recibida -> en_proceso -> resuelta y la bitacora lo refleja", async () => {
    const { app, base, ctx, seedConfirmed } = await construir();
    const id = await seedConfirmed();
    const a = await app.request(`${base}/solicitudes/${id}/estado`, authedJson(ctx.staff.owner.token, { estado: "en_proceso" }, "PATCH"));
    expect(await a.json()).toEqual({ id, estado: "en_proceso" });
    const b = await app.request(`${base}/solicitudes/${id}/estado`, authedJson(ctx.staff.admin.token, { estado: "resuelta", nota: "datos entregados al titular" }, "PATCH"));
    expect(b.status).toBe(200);
    const ev = await (await app.request(`${base}/solicitudes/${id}/eventos`, authedGet(ctx.staff.owner.token))).json();
    expect(ev.disponible).toBe(true);
    expect(ev.items.map((e: { actor: string; evento: string; hacia: string | null }) => `${e.actor}:${e.evento}:${e.hacia}`)).toEqual([
      "titular:registrada:pendiente_confirmacion",
      "titular:confirmada:recibida",
      "staff:cambio_estado:en_proceso",
      "staff:cambio_estado:resuelta",
    ]);
  });

  it("transicion invalida -> 409; bloqueada solo en cancelacion; rechazar exige nota (400); id no uuid (400); inexistente (404)", async () => {
    const { app, base, ctx, seedConfirmed } = await construir();
    const acceso = await seedConfirmed("acceso", "+5219990000001");
    const cancel = await seedConfirmed("cancelacion", "+5219990000002");
    const patch = (id: string, body: object) => app.request(`${base}/solicitudes/${id}/estado`, authedJson(ctx.staff.owner.token, body, "PATCH"));
    expect((await patch(acceso, { estado: "bloqueada" })).status).toBe(409);
    expect((await patch(cancel, { estado: "bloqueada" })).status).toBe(200);
    expect((await patch(acceso, { estado: "rechazada" })).status).toBe(400);
    expect((await patch(acceso, { estado: "recibida" })).status).toBe(400);
    expect((await patch("no-es-uuid", { estado: "en_proceso" })).status).toBe(400);
    expect((await patch(randomUUID(), { estado: "en_proceso" })).status).toBe(404);
    await patch(acceso, { estado: "resuelta" });
    expect((await patch(acceso, { estado: "en_proceso" })).status).toBe(409);
  });

  it("rol staff y otra organizacion no pueden cambiar estado (403) y la solicitud no cambia", async () => {
    const { app, base, ctx, seedConfirmed, privacy } = await construir();
    const id = await seedConfirmed();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.otroOrgOwner.token]) {
      const res = await app.request(`${base}/solicitudes/${id}/estado`, authedJson(token, { estado: "resuelta" }, "PATCH"));
      expect(res.status).toBe(403);
    }
    expect(privacy.requests[0]!.status).toBe("recibida");
  });

  it("base sin migrar: PATCH -> 503 y eventos -> disponible:false", async () => {
    const { app, base, ctx, privacy } = await construir();
    privacy.migrada = false;
    expect((await app.request(`${base}/solicitudes/${randomUUID()}/estado`, authedJson(ctx.staff.owner.token, { estado: "en_proceso" }, "PATCH"))).status).toBe(503);
    expect(await (await app.request(`${base}/solicitudes/${randomUUID()}/eventos`, authedGet(ctx.staff.owner.token))).json()).toEqual({ disponible: false, items: [] });
  });
});

describe("GET/PUT .../admin/privacidad/configuracion", () => {
  const OK = { responsable: "Los Taquitos de PM", avisoUrl: "https://ejemplo.mx/aviso", avisoVersion: "v2", retencionConversacionesDias: 90, retencionVozDias: 15, exigirConsentimientoGrabacion: true };

  it("GET devuelve la config y los valores por defecto (sin fila: configurada:false)", async () => {
    const { app, base, ctx } = await construir();
    const body = await (await app.request(`${base}/configuracion`, authedGet(ctx.staff.owner.token))).json();
    expect(body.configuracion).toMatchObject({ configurada: false, retencionConversacionesDias: 180, retencionVozDias: 30, exigirConsentimientoGrabacion: true });
    expect(body.porDefecto.retencionConversacionesDias).toBe(180);
  });

  it("PUT guarda y GET lo devuelve; rol staff -> 403", async () => {
    const { app, base, ctx, privacy } = await construir();
    const put = await app.request(`${base}/configuracion`, authedJson(ctx.staff.owner.token, OK, "PUT"));
    expect(put.status).toBe(200);
    expect(privacy.configs.get(ctx.organizationId)).toMatchObject({ responsibleName: "Los Taquitos de PM", noticeUrl: "https://ejemplo.mx/aviso", noticeVersion: "v2", conversationRetentionDays: 90, voiceRetentionDays: 15 });
    const get = await (await app.request(`${base}/configuracion`, authedGet(ctx.staff.admin.token))).json();
    expect(get.configuracion).toMatchObject({ responsable: "Los Taquitos de PM", configurada: true });
    expect((await app.request(`${base}/configuracion`, authedJson(ctx.staff.staffSucursalA.token, OK, "PUT"))).status).toBe(403);
    expect((await app.request(`${base}/configuracion`, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
  });

  it.each([
    [{ avisoUrl: "http://inseguro.mx" }],
    [{ retencionConversacionesDias: 5 }],
    [{ retencionVozDias: 500 }],
    [{ retencionVozDias: "30" }],
    [{ avisoVersion: "v 1" }],
    [{ exigirConsentimientoGrabacion: "si" }],
  ])("PUT con valores invalidos %j -> 400 y no se guarda", async (patch) => {
    const { app, base, ctx, privacy } = await construir();
    const res = await app.request(`${base}/configuracion`, authedJson(ctx.staff.owner.token, { ...OK, ...patch }, "PUT"));
    expect(res.status).toBe(400);
    expect(privacy.configs.size).toBe(0);
  });

  it("base sin migrar: PUT -> 503", async () => {
    const { app, base, ctx, privacy } = await construir();
    privacy.migrada = false;
    expect((await app.request(`${base}/configuracion`, authedJson(ctx.staff.owner.token, OK, "PUT"))).status).toBe(503);
  });
});

describe("lado sistema: voz y purga", () => {
  const SECRET = { "x-atiende-internal-secret": "test-internal-secret" };
  const post = (body: unknown, headers: Record<string, string> = SECRET): RequestInit => {
    const raw = JSON.stringify(body);
    return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), ...headers } };
  };

  it("exigen el secreto interno (401 sin el)", async () => {
    const { app, ctx } = await construir();
    expect((await app.request("/internal/restaurantes/voz/privacidad/apertura", post({ organizationId: ctx.organizationId }, {}))).status).toBe(401);
    expect((await app.request("/internal/restaurantes/voz/arco", post({ organizationId: ctx.organizationId, callerPhone: PHONE, texto: "x" }, {}))).status).toBe(401);
    expect((await app.request(`/internal/restaurantes/voz/conversaciones/${randomUUID()}/consentimiento-grabacion`, post({ organizationId: ctx.organizationId, respuesta: "si" }, {}))).status).toBe(401);
    expect((await app.request("/internal/restaurantes/privacidad-retencion", { method: "POST" })).status).toBe(401);
  });

  it("apertura: guion con asistente virtual + aviso + pregunta de grabacion, y deja evidencia de entrega una sola vez", async () => {
    const { app, ctx, privacy } = await construir();
    const body = { organizationId: ctx.organizationId, callerPhone: PHONE };
    const first = await (await app.request("/internal/restaurantes/voz/privacidad/apertura", post(body))).json();
    expect(first.guion).toContain("asistente virtual");
    expect(first.guion).toContain("¿Autoriza que esta llamada se grabe");
    expect(first.pideConsentimientoGrabacion).toBe(true);
    expect(first.avisoEntregadoAhora).toBe(true);
    const second = await (await app.request("/internal/restaurantes/voz/privacidad/apertura", post(body))).json();
    expect(second.avisoEntregadoAhora).toBe(false);
    expect(privacy.notices.size).toBe(1);
    // el telefono no se guarda en claro: solo su hash
    expect([...privacy.notices][0]).not.toContain("998123");
  });

  it("apertura con retencion de voz 0: avisa que no se graba y no pide consentimiento", async () => {
    const { app, ctx, privacy } = await construir();
    privacy.configs.set(ctx.organizationId, { responsibleName: null, noticeUrl: null, noticeVersion: "v1", conversationRetentionDays: 180, voiceRetentionDays: 0, recordingConsentRequired: true, configurada: true });
    const res = await (await app.request("/internal/restaurantes/voz/privacidad/apertura", post({ organizationId: ctx.organizationId }))).json();
    expect(res.pideConsentimientoGrabacion).toBe(false);
    expect(res.guion).toContain("no se graba");
  });

  it("apertura con telefono invalido o organizationId no uuid -> 400", async () => {
    const { app, ctx } = await construir();
    expect((await app.request("/internal/restaurantes/voz/privacidad/apertura", post({ organizationId: ctx.organizationId, callerPhone: "12" }))).status).toBe(400);
    expect((await app.request("/internal/restaurantes/voz/privacidad/apertura", post({ organizationId: "x" }))).status).toBe(400);
  });

  it("consentimiento: 'si' otorga, 'no' niega (sin grabar), ambiguo no cambia nada y repite la pregunta", async () => {
    const { app, ctx, privacy } = await construir();
    const conv = randomUUID();
    const send = async (respuesta: string) => (await app.request(`/internal/restaurantes/voz/conversaciones/${conv}/consentimiento-grabacion`, post({ organizationId: ctx.organizationId, respuesta }))).json();
    const ambiguo = await send("quiero tres tacos");
    expect(ambiguo).toMatchObject({ consentimiento: "pendiente", grabando: false });
    expect(privacy.consents.size).toBe(0);
    const si = await send("sí, autorizo");
    expect(si).toMatchObject({ consentimiento: "otorgado", grabando: true });
    const no = await send("no, mejor no");
    expect(no).toMatchObject({ consentimiento: "negado", grabando: false });
    // tras negar no se puede volver a otorgar en la misma llamada
    const otraVez = await send("sí");
    expect(otraVez).toMatchObject({ consentimiento: "negado", grabando: false });
  });

  it("consentimiento: respuesta ausente o enorme -> 400; base sin migrar -> no_disponible sin grabar", async () => {
    const { app, ctx, privacy } = await construir();
    const url = `/internal/restaurantes/voz/conversaciones/${randomUUID()}/consentimiento-grabacion`;
    expect((await app.request(url, post({ organizationId: ctx.organizationId }))).status).toBe(400);
    expect((await app.request(url, post({ organizationId: ctx.organizationId, respuesta: "x".repeat(501) }))).status).toBe(400);
    privacy.migrada = false;
    expect(await (await app.request(url, post({ organizationId: ctx.organizationId, respuesta: "si" }))).json()).toMatchObject({ consentimiento: "no_disponible", grabando: false });
  });

  it("ARCO por voz: registra con canal voice e identidad por identificador de llamada; un texto que no es ARCO no se atiende", async () => {
    const { app, ctx, privacy } = await construir();
    const arco = await (await app.request("/internal/restaurantes/voz/arco", post({ organizationId: ctx.organizationId, callerPhone: "+52 998 123 4567", texto: "quiero que borren mis datos personales" }))).json();
    expect(arco.atendido).toBe(true);
    expect(arco.respuesta).toContain("CONFIRMO");
    expect(privacy.requests[0]).toMatchObject({ customerPhone: "+529981234567", channel: "voice", identityBasis: "llamada_identificador", rightType: "cancelacion" });
    const nada = await (await app.request("/internal/restaurantes/voz/arco", post({ organizationId: ctx.organizationId, callerPhone: PHONE, texto: "quiero tres tacos" }))).json();
    expect(nada).toEqual({ atendido: false });
  });

  it("ARCO por voz: el telefono sale del identificador de llamada, no del texto dictado", async () => {
    const { app, ctx, privacy } = await construir();
    await app.request("/internal/restaurantes/voz/arco", post({ organizationId: ctx.organizationId, callerPhone: PHONE, texto: "quiero acceso a mis datos personales, el telefono es 5551112233" }));
    expect(privacy.requests).toHaveLength(1);
    expect(privacy.requests[0]!.customerPhone).toBe(PHONE);
  });

  it("purga por retencion: devuelve los conteos; base sin migrar -> disponible:false", async () => {
    const { app, privacy } = await construir();
    privacy.purgeResult = { disponible: true, conversationsCleared: 4, voiceTurnsDeleted: 9, voiceCallsAnonymized: 2 };
    const ok = await (await app.request("/internal/restaurantes/privacidad-retencion", { method: "POST", headers: SECRET })).json();
    expect(ok).toMatchObject({ ok: true, disponible: true, conversacionesVaciadas: 4, turnosDeVozBorrados: 9, llamadasAnonimizadas: 2, lotes: 1 });
    privacy.migrada = false;
    const nada = await (await app.request("/internal/restaurantes/privacidad-retencion", { method: "GET", headers: SECRET })).json();
    expect(nada).toMatchObject({ ok: true, disponible: false, conversacionesVaciadas: 0 });
  });

  it("purga: si un lote llena su tope sigue con otro lote (acotado)", async () => {
    const { app, privacy } = await construir();
    privacy.purgeResult = { disponible: true, conversationsCleared: 500, voiceTurnsDeleted: 0, voiceCallsAnonymized: 0 };
    const res = await (await app.request("/internal/restaurantes/privacidad-retencion", { method: "POST", headers: SECRET })).json();
    expect(res.lotes).toBe(10);
    expect(res.conversacionesVaciadas).toBe(5000);
  });

  it("sin repositorio de privacidad: 503 (no 500)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = envolver(buildApp({ ...ctx.deps }));
    expect((await app.request("/internal/restaurantes/privacidad-retencion", { method: "POST", headers: SECRET })).status).toBe(503);
  });
});

describe("POST /v1/restaurantes/whatsapp/webhook con privacidad", () => {
  function signed(body: unknown): RequestInit {
    const raw = JSON.stringify(body);
    const bytes = new TextEncoder().encode(raw);
    const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
    return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
  }
  const payload = (id: string, text: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: [{ id, from: "5219991234567", type: "text", text: { body: text } }] } }] }] });

  it("el primer mensaje sale con el aviso; una solicitud ARCO no llega al agente", async () => {
    const base = await buildTestDeps();
    const privacy = new InMemoryPrivacidadRepository();
    let turns = 0;
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turns += 1;
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    const app = buildApp({ ...base.deps, turnHandler: handler, privacidadRepo: () => privacy });
    const first = await app.request("/v1/restaurantes/whatsapp/webhook", signed(payload("wamid.p1", "hola")));
    expect(first.status).toBe(200);
    expect(turns).toBe(1);
    expect(privacy.notices.size).toBe(1);

    const arco = await app.request("/v1/restaurantes/whatsapp/webhook", signed(payload("wamid.p2", "quiero acceso a mis datos personales")));
    expect(arco.status).toBe(200);
    expect(turns).toBe(1);
    expect(privacy.requests).toHaveLength(1);
    expect(privacy.requests[0]).toMatchObject({ customerPhone: "+5219991234567", rightType: "acceso" });
  });

  it("sin privacidadRepo (despliegue anterior) el webhook funciona como antes", async () => {
    const base = await buildTestDeps();
    let turns = 0;
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turns += 1;
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    const app = buildApp({ ...base.deps, turnHandler: handler });
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signed(payload("wamid.q1", "quiero acceso a mis datos personales")));
    expect(res.status).toBe(200);
    expect(turns).toBe(1);
  });
});

