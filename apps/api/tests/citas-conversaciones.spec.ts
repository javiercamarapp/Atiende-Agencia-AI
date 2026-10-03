// C-11 -- bandeja de conversaciones de WhatsApp de citas con handoff a humano (HTTP real via app.request; repositorio de conversaciones y de citas
// en memoria). Cada caso afirma el EFECTO: que se guardo, que NO salio hacia el cliente, quien puede y que ve cada rol. Las reglas de RLS/GRANT las
// verifica scripts/verify-citas-conversaciones-handoff/ contra Postgres real; el envio real de WhatsApp NO se ejecuta nunca (solo se encola).
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate, type WhatsAppTurnHandler } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const PHONE = "+5219981234567";
const WA_ID = "5219981234567";

async function construir(opts: { sinRepo?: boolean } = {}) {
  const ctx = await buildCitasTestContext(buildApp);
  const store = new InMemoryConversacionesRepository({ actorUserId: ctx.staff.owner.id, nombres: { [ctx.staff.owner.id]: "Owner", [ctx.staff.staffMember.id]: "Staff", [ctx.staff.admin.id]: "Admin" } });
  let actor = ctx.staff.owner.id;
  let esAdmin = true;
  let llamadasAlAgente = 0;
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      llamadasAlAgente += 1;
      return { reply: "Claro, ¿en qué te ayudo?", appointmentId: null, propertyId: null };
    },
  };
  const gate = new InMemoryHandoffAgentGate(store);
  const deps: AppDeps = {
    ...ctx.deps,
    citasTurnHandler: turnHandler,
    ...(opts.sinRepo ? {} : { citasConversacionesRepo: () => store.comoActor(actor, esAdmin), citasHandoffGate: () => gate }),
  };
  const conv = randomUUID();
  store.conversaciones.push({
    id: conv, organizationId: ctx.organizationId, propertyId: null, telefono: PHONE, mensajes: [{ rol: "cliente", texto: "Hola, quiero mover mi cita" }], actividadAt: new Date().toISOString(),
    citaId: randomUUID(), citaInicio: new Date(Date.now() + 86_400_000).toISOString(), citaEstado: "confirmed",
  });
  store.organizacionesConNumero.add(ctx.organizationId);
  const app = envolver(buildApp(deps));
  const base = `/v1/citas/properties/${ctx.propertyId}/admin`;
  const como = (u: { id: string }, administrador: boolean) => {
    actor = u.id;
    esAdmin = administrador;
  };
  const webhook = (id: string, body: string) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: [{ id, from: WA_ID, type: "text", text: { body } }] } }] }] });
    const bytes = new TextEncoder().encode(raw);
    const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
    return app.request("/v1/citas/whatsapp/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } });
  };
  return { ctx, store, app, base, conv, como, webhook, llamadas: () => llamadasAlAgente, gate };
}

describe("bandeja y detalle", () => {
  it("exige token (401)", async () => {
    const { app, base } = await construir();
    expect((await app.request(`${base}/conversaciones`)).status).toBe(401);
  });

  it("lista la conversacion con estado 'agente', la cita vinculada y el telefono ENMASCARADO", async () => {
    const { ctx, app, base } = await construir();
    for (const t of [ctx.staff.owner.token, ctx.staff.admin.token, ctx.staff.staffMember.token]) {
      const r = await app.request(`${base}/conversaciones`, authedGet(t));
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ disponible: true, total: 1, nextOffset: null });
      expect(body.items[0]).toMatchObject({ estado: "agente", telefono: "***4567", vistaPrevia: "Hola, quiero mover mi cita", crisis: false, cita: { estado: "confirmed" } });
      expect(JSON.stringify(body)).not.toContain("5219981234567");
    }
  });

  it("una cita en crisis aparece MARCADA y primera en la bandeja", async () => {
    const { ctx, app, base, store } = await construir();
    store.conversaciones.push({ id: randomUUID(), organizationId: ctx.organizationId, propertyId: null, telefono: "+5219990000001", mensajes: [{ rol: "cliente", texto: "otra" }], actividadAt: new Date(Date.now() + 5000).toISOString() });
    store.telefonosEnCrisis.add(PHONE);
    const body = await (await app.request(`${base}/conversaciones`, authedGet(ctx.staff.staffMember.token))).json();
    expect(body.items.map((i: { crisis: boolean }) => i.crisis)).toEqual([true, false]);
    expect(body.items[0]).toMatchObject({ telefono: "***4567" });
  });

  it("otra organizacion no entra (403) y no ve nada; id mal formado 404; filtros invalidos 400", async () => {
    const { ctx, app, base, conv } = await construir();
    const otraOrg = randomUUID();
    ctx.citasRepo.seedOrganization({ id: otraOrg, slug: "otra-clinica-conv", name: "Otra", defaultTimezone: "America/Mexico_City" });
    ctx.coreRepo.addOrganization({ id: otraOrg, slug: "otra-clinica-conv", name: "Otra", vertical: "citas" });
    const otroId = randomUUID();
    const password = "correcto-caballo-batería";
    ctx.coreRepo.addStaff({ id: otroId, email: "dueno@otra-conv.mx", fullName: "Dueño Otra", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    ctx.coreRepo.addMembership({ userId: otroId, organizationId: otraOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    ctx.engine.seedMembership({ userId: otroId, organizationId: otraOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dueno@otra-conv.mx", password }) });
    const otroToken = ((await login.json()) as { token: string }).token;
    expect((await app.request(`${base}/conversaciones`, authedGet(otroToken))).status).toBe(403);
    expect((await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(otroToken, {}, "POST"))).status).toBe(403);

    expect((await app.request(`${base}/conversaciones/no-es-uuid`, authedGet(ctx.staff.owner.token))).status).toBe(404);
    for (const q of ["estado=inventado", "limit=0", "limit=101", "offset=-1"]) {
      expect((await app.request(`${base}/conversaciones?${q}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    }
  });

  it("detalle: mensajes, toma y notas; una conversacion inexistente es 404", async () => {
    const { ctx, app, base, conv } = await construir();
    const d = await (await app.request(`${base}/conversaciones/${conv}`, authedGet(ctx.staff.owner.token))).json();
    expect(d).toMatchObject({ conversationId: conv, telefono: "***4567", handoff: null, notas: [] });
    expect(d.mensajes[0]).toMatchObject({ rol: "cliente", texto: "Hola, quiero mover mi cita" });
    expect((await app.request(`${base}/conversaciones/${randomUUID()}`, authedGet(ctx.staff.owner.token))).status).toBe(404);
  });
});

describe("tomar / devolver / cerrar / notas / responder", () => {
  it("flujo completo: tomar -> nota -> responder -> devolver; la respuesta solo se ENCOLA (sin envio real)", async () => {
    const { ctx, app, base, conv, store, como } = await construir();
    como(ctx.staff.staffMember, false);
    const tomar = await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.staffMember.token, {}, "POST"));
    expect(tomar.status).toBe(201);
    const { handoffId } = await tomar.json();
    expect(store.handoffs[0]).toMatchObject({ estado: "tomada", tomadaPor: ctx.staff.staffMember.id });

    expect((await app.request(`${base}/handoffs/${handoffId}/notas`, authedJson(ctx.staff.staffMember.token, { texto: "Quiere factura" }, "POST"))).status).toBe(201);
    const resp = await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.staffMember.token, { texto: "Ya le atiendo" }, "POST"));
    expect(resp.status).toBe(201);
    expect(await resp.json()).toMatchObject({ encolado: true });
    expect(store.outbox).toEqual([expect.objectContaining({ organizationId: ctx.organizationId, to: PHONE, body: "Ya le atiendo" })]);

    const bandeja = await (await app.request(`${base}/conversaciones`, authedGet(ctx.staff.staffMember.token))).json();
    expect(bandeja.items[0]).toMatchObject({ estado: "tomada", handoffId, tomadaPor: ctx.staff.staffMember.id, tomadaPorNombre: "Staff", esMia: true });
    expect(bandeja.puedeGestionar).toBe(false); // staff: no devuelve ni cierra la toma de otra persona
    const comoOwner = await (await app.request(`${base}/conversaciones`, authedGet(ctx.staff.owner.token))).json();
    expect(comoOwner.puedeGestionar).toBe(true);
    expect(comoOwner.items[0]).toMatchObject({ estado: "tomada", esMia: false });
    const detalle = await (await app.request(`${base}/conversaciones/${conv}`, authedGet(ctx.staff.staffMember.token))).json();
    expect(detalle.notas.map((n: { texto: string }) => n.texto)).toEqual(["Quiere factura"]);
    expect(detalle.mensajes.at(-1)).toEqual({ rol: "humano", texto: "Ya le atiendo" });
    expect(detalle).toMatchObject({ puedeGestionar: false, handoff: { esMia: true, estado: "tomada" } });

    const dev = await app.request(`${base}/handoffs/${handoffId}/devolver`, authedJson(ctx.staff.staffMember.token, {}, "POST"));
    expect(await dev.json()).toMatchObject({ estado: "devuelta", cambio: true });
    expect(store.handoffs[0]!.estado).toBe("devuelta");
  });

  it("la segunda persona recibe 409 y la primera toma sigue intacta; notas vacias o de mas de 2000 caracteres 400", async () => {
    const { ctx, app, base, conv, store, como } = await construir();
    como(ctx.staff.staffMember, false);
    const { handoffId } = await (await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.staffMember.token, {}, "POST"))).json();
    como(ctx.staff.owner, false);
    expect((await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(409);
    expect(store.handoffs[0]!.tomadaPor).toBe(ctx.staff.staffMember.id);
    expect((await app.request(`${base}/handoffs/${handoffId}/notas`, authedJson(ctx.staff.owner.token, { texto: "   " }, "POST"))).status).toBe(400);
    expect((await app.request(`${base}/handoffs/${handoffId}/notas`, authedJson(ctx.staff.owner.token, { texto: "x".repeat(2001) }, "POST"))).status).toBe(400);
    expect(store.notas).toHaveLength(0);
  });

  it("responder: sin ser quien tomo -> 403; sin numero de WhatsApp -> 409; vacio o de mas de 1000 -> 400; nada se encola en esos casos", async () => {
    const { ctx, app, base, conv, store, como } = await construir();
    como(ctx.staff.staffMember, false);
    const { handoffId } = await (await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.staffMember.token, {}, "POST"))).json();
    como(ctx.staff.admin, true);
    expect((await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.admin.token, { texto: "hola" }, "POST"))).status).toBe(403);
    como(ctx.staff.staffMember, false);
    expect((await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.staffMember.token, { texto: "  " }, "POST"))).status).toBe(400);
    expect((await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.staffMember.token, { texto: "x".repeat(1001) }, "POST"))).status).toBe(400);
    store.organizacionesConNumero.clear();
    expect((await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.staffMember.token, { texto: "hola" }, "POST"))).status).toBe(409);
    expect(store.outbox).toHaveLength(0);
  });

  it("un administrador puede cerrar una toma ajena; un staff que no la tomo, no (403); devolver dos veces es idempotente", async () => {
    const { ctx, app, base, conv, como } = await construir();
    como(ctx.staff.owner, false);
    const { handoffId } = await (await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.owner.token, {}, "POST"))).json();
    como(ctx.staff.staffMember, false);
    expect((await app.request(`${base}/handoffs/${handoffId}/cerrar`, authedJson(ctx.staff.staffMember.token, {}, "POST"))).status).toBe(403);
    como(ctx.staff.admin, true);
    expect(await (await app.request(`${base}/handoffs/${handoffId}/cerrar`, authedJson(ctx.staff.admin.token, {}, "POST"))).json()).toMatchObject({ estado: "cerrada", cambio: true });
    expect(await (await app.request(`${base}/handoffs/${handoffId}/cerrar`, authedJson(ctx.staff.admin.token, {}, "POST"))).json()).toMatchObject({ cambio: false });
  });

  it("identificadores mal formados: 404 sin tocar nada", async () => {
    const { ctx, app, base, store } = await construir();
    expect((await app.request(`${base}/handoffs/no-uuid/devolver`, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(404);
    expect((await app.request(`${base}/conversaciones/no-uuid/tomar`, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(404);
    expect(store.handoffs).toHaveLength(0);
  });
});

describe("webhook de WhatsApp con handoff (agente silenciado)", () => {
  it("tomar -> el siguiente mensaje entrante NO genera respuesta del agente; devolver -> el agente vuelve a responder", async () => {
    const { ctx, app, base, conv, webhook, llamadas, como, store } = await construir();
    expect((await webhook("wamid.c11-1", "Hola")).status).toBe(200);
    expect(llamadas()).toBe(1);
    const antes = (await ctx.citasRepo.claimMessagingOutboxBatch(50, 60)).length;
    expect(antes).toBe(1);

    como(ctx.staff.staffMember, false);
    const { handoffId } = await (await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.staffMember.token, {}, "POST"))).json();
    expect((await webhook("wamid.c11-2", "¿Hay alguien?")).status).toBe(200);
    expect(llamadas()).toBe(1); // el LLM no se invoco
    expect(await ctx.citasRepo.claimMessagingOutboxBatch(50, 60)).toHaveLength(0); // nada hacia el cliente
    expect(store.handoffs[0]!.ultimoClienteAt).not.toBeNull();

    await app.request(`${base}/handoffs/${handoffId}/devolver`, authedJson(ctx.staff.staffMember.token, {}, "POST"));
    expect((await webhook("wamid.c11-3", "Gracias")).status).toBe(200);
    expect(llamadas()).toBe(2);
    expect(await ctx.citasRepo.claimMessagingOutboxBatch(50, 60)).toHaveLength(1);
  });
});

describe("despliegue o base sin migrar", () => {
  it("sin citasConversacionesRepo en el despliegue: 503 honesto y el webhook responde como siempre", async () => {
    const { ctx, app, base, conv, webhook, llamadas } = await construir({ sinRepo: true });
    expect((await app.request(`${base}/conversaciones`, authedGet(ctx.staff.owner.token))).status).toBe(503);
    expect((await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(503);
    expect((await webhook("wamid.c11-sin-1", "Hola")).status).toBe(200);
    expect(llamadas()).toBe(1);
  });

  it("base sin la migracion 031: la bandeja responde 200 con disponible:false y lista vacia (no un 500); las escrituras 503", async () => {
    const { ctx, app, base, conv, store } = await construir();
    store.disponible = false;
    const r = await app.request(`${base}/conversaciones`, authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ disponible: false, total: 0, items: [] });
    expect((await app.request(`${base}/conversaciones/${conv}`, authedGet(ctx.staff.owner.token))).status).toBe(503);
    expect((await app.request(`${base}/conversaciones/${conv}/tomar`, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(503);
  });
});
