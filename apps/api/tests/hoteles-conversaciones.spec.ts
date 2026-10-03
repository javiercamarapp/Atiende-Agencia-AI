// H-20 -- bandeja de conversaciones de WhatsApp con handoff a humano: integracion HTTP real (app.request) sobre el repositorio en
// memoria. RLS/GRANT/transiciones de las funciones SQL las cubre scripts/verify-hoteles-conversaciones contra Postgres real; el SAVEPOINT contra
// base sin migrar lo cubre packages/domain-hoteles/tests/conversaciones/savepoint.spec.ts.
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryConversacionesRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import type { HotelesWhatsAppTurnHandler } from "@atiende/domain-hoteles";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";

const NOW = new Date("2026-12-02T18:00:00Z");
const PHONE = "+5215511112222";

async function setup(opts: { migrated?: boolean } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const repo = new InMemoryConversacionesRepository({ migrated: opts.migrated ?? true, now: () => NOW });
  repo.seedCanal(ctx.propertyId);
  repo.seedNombre(ctx.staff.frontdesk.id, "Frontdesk");
  repo.seedNombre(ctx.staff.reservations.id, "Reservaciones");
  const app = buildApp({ ...ctx.deps, hotelesConversacionesRepo: (_db) => repo, hotelesConversacionesSistema: (_db) => repo.sistema() });
  const base = `/hoteles/${ctx.propertyId}/conversaciones`;
  const conv = (over: Partial<Parameters<InMemoryConversacionesRepository["seedConversacion"]>[0]> = {}) =>
    repo.seedConversacion({
      propertyId: ctx.propertyId,
      organizationId: ctx.organizationId,
      phone: PHONE,
      mensajes: [
        { role: "user", content: "Hola, mi correo es ana@example.com y mi cel 55 1234 5678, quiero late check-out" },
        { role: "assistant", content: "Con gusto, una persona le ayuda" },
      ],
      ...over,
    });
  return { ctx, repo, app, base, conv };
}
type S = Awaited<ReturnType<typeof setup>>;

const get = (s: S, path: string, token: string) => s.app.request(`${s.base}${path}`, authedJson(token));
const post = (s: S, path: string, token: string, body: unknown = {}) => s.app.request(`${s.base}${path}`, authedJson(token, body));
const json = async <T>(res: Response) => (await res.json()) as T;

interface Item {
  id: string;
  telefono: string;
  estado: "agente" | "humano" | "cerrada";
  porAtender: boolean;
  responsable: { id: string; nombre: string | null } | null;
  noLeidos: number;
  vistaPrevia: string | null;
  huesped: { id: string; nombre: string | null } | null;
  motivoTexto: string | null;
}
interface Bandeja {
  disponible: boolean;
  total: number;
  siguiente: number | null;
  items: Item[];
}
interface Detalle extends Item {
  esResponsable: boolean;
  mensajes: { rol: string; origen: string; texto: string; envio: string | null }[];
  notas: { id: string; autor: string | null; texto: string }[];
}

describe("GET /conversaciones (bandeja)", () => {
  it("lista con filtros por estado y no leidas; las que esperan a una persona van primero", async () => {
    const s = await setup();
    const a = s.conv({ phone: "+5215500000001" });
    const b = s.conv({ phone: "+5215500000002", modo: "humano", noLeidos: 2 });
    const c = s.conv({ phone: "+5215500000003", modo: "humano", responsableId: s.ctx.staff.frontdesk.id });
    s.conv({ phone: "+5215500000004", modo: "cerrada" });

    const todas = await json<Bandeja>(await get(s, "", s.ctx.staff.owner.token));
    expect(todas).toMatchObject({ disponible: true, total: 4, siguiente: null });
    expect(todas.items[0]!.id).toBe(b);
    expect(todas.items[0]!.porAtender).toBe(true);

    const porAtender = await json<Bandeja>(await get(s, "?estado=por_atender", s.ctx.staff.owner.token));
    expect(porAtender.items.map((i) => i.id)).toEqual([b]);
    const humano = await json<Bandeja>(await get(s, "?estado=humano", s.ctx.staff.owner.token));
    expect(humano.items.map((i) => i.id).sort()).toEqual([b, c].sort());
    expect(humano.items.find((i) => i.id === c)!.responsable).toEqual({ id: s.ctx.staff.frontdesk.id, nombre: "Frontdesk" });
    const noLeidas = await json<Bandeja>(await get(s, "?noLeidas=1", s.ctx.staff.owner.token));
    expect(noLeidas.items.map((i) => i.id)).toEqual([b]);
    const agente = await json<Bandeja>(await get(s, "?estado=agente", s.ctx.staff.owner.token));
    expect(agente.items.map((i) => i.id)).toEqual([a]);
  });

  it("pagina con limit/offset y `siguiente`", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) s.conv({ phone: `+521550000010${i}` });
    const p1 = await json<Bandeja>(await get(s, "?limit=2", s.ctx.staff.owner.token));
    expect(p1.items).toHaveLength(2);
    expect(p1).toMatchObject({ total: 3, siguiente: 2 });
    const p2 = await json<Bandeja>(await get(s, "?limit=2&offset=2", s.ctx.staff.owner.token));
    expect(p2.items).toHaveLength(1);
    expect(p2.siguiente).toBeNull();
  });

  it("filtros invalidos responden 400", async () => {
    const s = await setup();
    for (const q of ["?estado=otro", "?noLeidas=si", "?limit=0", "?limit=101", "?offset=-1", "?huespedId=no-uuid"]) {
      expect((await get(s, q, s.ctx.staff.owner.token)).status, q).toBe(400);
    }
  });

  it("enlace desde la ficha del huesped: filtra por el telefono del huesped de ESTA property (el cliente nunca manda un telefono)", async () => {
    const s = await setup();
    s.repo.seedHuesped(s.ctx.propertyId, "5511112222", s.ctx.guestId, "Ana Torres");
    const suya = s.conv();
    s.conv({ phone: "+5215599990000" });
    const r = await json<Bandeja>(await get(s, `?huespedId=${s.ctx.guestId}`, s.ctx.staff.frontdesk.token));
    expect(r.items.map((i) => i.id)).toEqual([suya]);
    expect(r.items[0]!.huesped).toEqual({ id: s.ctx.guestId, nombre: "Ana Torres" });
    expect((await get(s, `?huespedId=${randomUUID()}`, s.ctx.staff.owner.token)).status).toBe(404);
  });

  it("minimizacion de PII por rol: owner/gm ven el telefono y el texto completos; frontdesk/reservations, enmascarado y sin correos ni numeros largos", async () => {
    const s = await setup();
    s.conv();
    const owner = await json<Bandeja>(await get(s, "", s.ctx.staff.owner.token));
    expect(owner.items[0]!.telefono).toBe(PHONE);
    expect(owner.items[0]!.vistaPrevia).toBe("Con gusto, una persona le ayuda");
    for (const rol of ["frontdesk", "reservations"] as const) {
      const r = await json<Bandeja>(await get(s, "", s.ctx.staff[rol].token));
      expect(r.items[0]!.telefono, rol).toBe("••••2222");
      expect(JSON.stringify(r), rol).not.toContain("5511112222");
    }
  });

  it("solo owner/gm/frontdesk/reservations; housekeeping, fnb y contabilidad reciben 403; sin token 401", async () => {
    const s = await setup();
    for (const rol of ["owner", "gm", "frontdesk", "reservations"] as const) expect((await get(s, "", s.ctx.staff[rol].token)).status, rol).toBe(200);
    for (const rol of ["housekeeping", "fnb", "accountant"] as const) expect((await get(s, "", s.ctx.staff[rol].token)).status, rol).toBe(403);
    expect((await s.app.request(s.base)).status).toBe(401);
  });

  it("base sin la migracion 043: disponible:false con lista vacia (no 'sin conversaciones') y las escrituras 503", async () => {
    const s = await setup({ migrated: false });
    const r = await get(s, "", s.ctx.staff.owner.token);
    expect(r.status).toBe(200);
    expect(await json<Bandeja>(r)).toMatchObject({ disponible: false, total: 0, items: [] });
    const id = randomUUID();
    expect((await get(s, `/${id}`, s.ctx.staff.owner.token)).status).toBe(503);
    expect((await post(s, `/${id}/tomar`, s.ctx.staff.owner.token)).status).toBe(503);
    expect((await post(s, `/${id}/responder`, s.ctx.staff.owner.token, { texto: "hola" })).status).toBe(503);
  });
});

describe("GET /conversaciones/:id (detalle)", () => {
  it("devuelve mensajes, estado y notas; PII minimizada para recepcion; no se cachea", async () => {
    const s = await setup();
    const id = s.conv();
    await post(s, `/${id}/tomar`, s.ctx.staff.frontdesk.token);
    await post(s, `/${id}/notas`, s.ctx.staff.frontdesk.token, { texto: "Llamar al 55 9999 8888 si hace falta" });

    const owner = await get(s, `/${id}`, s.ctx.staff.owner.token);
    expect(owner.status).toBe(200);
    expect(owner.headers.get("cache-control")).toBe("no-store");
    const o = await json<Detalle>(owner);
    expect(o.telefono).toBe(PHONE);
    expect(o.estado).toBe("humano");
    expect(o.esResponsable).toBe(false);
    expect(o.mensajes[0]).toMatchObject({ rol: "user", origen: "huesped" });
    expect(o.mensajes[0]!.texto).toContain("ana@example.com");
    expect(o.notas[0]).toMatchObject({ autor: "Frontdesk", texto: "Llamar al 55 9999 8888 si hace falta" });

    const f = await json<Detalle>(await get(s, `/${id}`, s.ctx.staff.frontdesk.token));
    expect(f.esResponsable).toBe(true);
    expect(f.telefono).toBe("••••2222");
    expect(f.mensajes[0]!.texto).not.toMatch(/ana@example\.com|1234 5678/);
    expect(f.mensajes[0]!.texto).toContain("[correo]");
    expect(f.notas[0]!.texto).not.toMatch(/9999 8888/);
  });

  it("404 para una conversacion inexistente, de otra property o con id mal formado; 403 para housekeeping", async () => {
    const s = await setup();
    const ajena = s.repo.seedConversacion({ propertyId: randomUUID(), phone: "+5215500009999" });
    expect((await get(s, `/${randomUUID()}`, s.ctx.staff.owner.token)).status).toBe(404);
    expect((await get(s, `/${ajena}`, s.ctx.staff.owner.token)).status).toBe(404);
    expect((await get(s, `/no-uuid`, s.ctx.staff.owner.token)).status).toBe(404);
    expect((await get(s, `/${s.conv()}`, s.ctx.staff.housekeeping.token)).status).toBe(403);
  });
});

describe("tomar / devolver / cerrar", () => {
  it("tomar concurrente: uno gana (201) y el otro recibe 409 ya_tomada; el responsable queda con el primero", async () => {
    const s = await setup();
    const id = s.conv({ modo: "humano" });
    const [a, b] = await Promise.all([post(s, `/${id}/tomar`, s.ctx.staff.frontdesk.token), post(s, `/${id}/tomar`, s.ctx.staff.reservations.token)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const perdedor = a.status === 409 ? a : b;
    expect(await json<{ code: string }>(perdedor)).toMatchObject({ code: "ya_tomada" });
    const ganador = a.status === 201 ? s.ctx.staff.frontdesk.id : s.ctx.staff.reservations.id;
    expect(s.repo.estado(id)).toMatchObject({ modo: "humano", responsableId: ganador });
  });

  it("tomar es idempotente para el mismo usuario; reasignar solo owner/gm", async () => {
    const s = await setup();
    const id = s.conv();
    expect((await post(s, `/${id}/tomar`, s.ctx.staff.frontdesk.token)).status).toBe(201);
    expect((await post(s, `/${id}/tomar`, s.ctx.staff.frontdesk.token)).status).toBe(201);
    expect((await post(s, `/${id}/tomar`, s.ctx.staff.reservations.token, { reasignar: true })).status).toBe(403);
    expect((await post(s, `/${id}/tomar`, s.ctx.staff.gm.token, { reasignar: true })).status).toBe(201);
    expect(s.repo.estado(id)!.responsableId).toBe(s.ctx.staff.gm.id);
    expect((await post(s, `/${id}/tomar`, s.ctx.staff.owner.token, { reasignar: "si" })).status).toBe(400);
  });

  it("una conversacion cerrada no se toma (409 cerrada)", async () => {
    const s = await setup();
    const id = s.conv({ modo: "cerrada" });
    const r = await post(s, `/${id}/tomar`, s.ctx.staff.owner.token);
    expect(r.status).toBe(409);
    expect(await json<{ code: string }>(r)).toMatchObject({ code: "cerrada" });
  });

  it("devolver al agente: el responsable o owner/gm; otro rol 403; sin humano 409", async () => {
    const s = await setup();
    const id = s.conv({ modo: "humano", responsableId: s.ctx.staff.frontdesk.id });
    expect((await post(s, `/${id}/devolver-al-agente`, s.ctx.staff.reservations.token)).status).toBe(403);
    const ok = await post(s, `/${id}/devolver-al-agente`, s.ctx.staff.frontdesk.token);
    expect(ok.status).toBe(200);
    expect(await json<{ estado: string }>(ok)).toMatchObject({ estado: "agente" });
    expect(s.repo.estado(id)).toMatchObject({ modo: "agente", responsableId: null });
    expect((await post(s, `/${id}/devolver-al-agente`, s.ctx.staff.frontdesk.token)).status).toBe(409);
    const otra = s.conv({ phone: "+5215500000077", modo: "humano", responsableId: s.ctx.staff.frontdesk.id });
    expect((await post(s, `/${otra}/devolver-al-agente`, s.ctx.staff.gm.token)).status).toBe(200);
  });

  it("cerrar: limpia responsable y no leidos; ya cerrada 409; de otra persona solo owner/gm", async () => {
    const s = await setup();
    const id = s.conv({ modo: "humano", responsableId: s.ctx.staff.frontdesk.id, noLeidos: 3 });
    expect((await post(s, `/${id}/cerrar`, s.ctx.staff.reservations.token)).status).toBe(403);
    expect((await post(s, `/${id}/cerrar`, s.ctx.staff.frontdesk.token)).status).toBe(200);
    expect(s.repo.estado(id)).toMatchObject({ modo: "cerrada", responsableId: null, noLeidos: 0 });
    expect((await post(s, `/${id}/cerrar`, s.ctx.staff.frontdesk.token)).status).toBe(409);
  });

  it("leer pone los no leidos en cero", async () => {
    const s = await setup();
    const id = s.conv({ noLeidos: 4 });
    const r = await post(s, `/${id}/leer`, s.ctx.staff.reservations.token);
    expect(r.status).toBe(200);
    expect(s.repo.estado(id)!.noLeidos).toBe(0);
  });
});

describe("notas y respuestas", () => {
  it("notas: recorta, valida longitud y rechaza numeros de tarjeta", async () => {
    const s = await setup();
    const id = s.conv();
    expect((await post(s, `/${id}/notas`, s.ctx.staff.frontdesk.token, { texto: "  Pidio piso alto  " })).status).toBe(201);
    expect((await post(s, `/${id}/notas`, s.ctx.staff.frontdesk.token, { texto: "   " })).status).toBe(400);
    expect((await post(s, `/${id}/notas`, s.ctx.staff.frontdesk.token, { texto: "x".repeat(1001) })).status).toBe(400);
    expect((await post(s, `/${id}/notas`, s.ctx.staff.frontdesk.token, { texto: "Tarjeta 4111 1111 1111 1111" })).status).toBe(400);
    expect((await post(s, `/${id}/notas`, s.ctx.staff.frontdesk.token, {})).status).toBe(400);
    const d = await json<Detalle>(await get(s, `/${id}`, s.ctx.staff.owner.token));
    expect(d.notas.map((n) => n.texto)).toEqual(["Pidio piso alto"]);
  });

  it("responder: solo el responsable con la conversacion en humano; encola en el outbox (pendiente_envio) y el detalle lo dice", async () => {
    const s = await setup();
    const id = s.conv({ modo: "humano" });
    expect((await post(s, `/${id}/responder`, s.ctx.staff.frontdesk.token, { texto: "Hola" })).status).toBe(409); // en humano pero sin responsable: no_eres_responsable
    await post(s, `/${id}/tomar`, s.ctx.staff.frontdesk.token);
    expect((await post(s, `/${id}/responder`, s.ctx.staff.reservations.token, { texto: "Hola" })).status).toBe(409);
    const r = await post(s, `/${id}/responder`, s.ctx.staff.frontdesk.token, { texto: "  Claro, el late check-out es a las 3 pm  " });
    expect(r.status).toBe(201);
    expect(await json<{ encolado: boolean; envio: string }>(r)).toMatchObject({ encolado: true, envio: "pendiente_envio" });
    expect(s.repo.outbox).toHaveLength(1);
    expect(s.repo.outbox[0]).toMatchObject({ to: PHONE, body: "Claro, el late check-out es a las 3 pm", status: "pending" });
    const d = await json<Detalle>(await get(s, `/${id}`, s.ctx.staff.frontdesk.token));
    const ultimo = d.mensajes[d.mensajes.length - 1]!;
    expect(ultimo).toMatchObject({ rol: "assistant", origen: "personal", texto: "Claro, el late check-out es a las 3 pm", envio: "pendiente_envio" });
    // el outbox lo drena el despachador existente: al enviarse, el detalle lo refleja
    s.repo.outbox[0]!.status = "sent";
    const d2 = await json<Detalle>(await get(s, `/${id}`, s.ctx.staff.frontdesk.token));
    expect(d2.mensajes[d2.mensajes.length - 1]!.envio).toBe("enviado");
  });

  it("responder: texto invalido 400, ventana de 24 h y canal sin configurar 409 con su codigo", async () => {
    const s = await setup();
    const id = s.conv({ modo: "humano", responsableId: s.ctx.staff.frontdesk.id });
    const tk = s.ctx.staff.frontdesk.token;
    expect((await post(s, `/${id}/responder`, tk, { texto: "" })).status).toBe(400);
    expect((await post(s, `/${id}/responder`, tk, { texto: "Mi tarjeta 4111111111111111" })).status).toBe(400);
    s.repo.quitarCanal(s.ctx.propertyId);
    const sinCanal = await post(s, `/${id}/responder`, tk, { texto: "Hola" });
    expect(sinCanal.status).toBe(409);
    expect(await json<{ code: string }>(sinCanal)).toMatchObject({ code: "canal_no_configurado" });
    s.repo.seedCanal(s.ctx.propertyId);
    const vieja = s.conv({ phone: "+5215500000088", modo: "humano", responsableId: s.ctx.staff.frontdesk.id, ultimoEntranteEn: new Date(NOW.getTime() - 25 * 3600_000) });
    const ventana = await post(s, `/${vieja}/responder`, tk, { texto: "Hola" });
    expect(ventana.status).toBe(409);
    expect(await json<{ code: string }>(ventana)).toMatchObject({ code: "ventana_24h" });
    expect(s.repo.outbox).toHaveLength(0);
  });
});

// ---- Punta a punta por el webhook REAL: el agente calla en humano y el handoff del agente pasa la conversacion a humano ------------
const WA_ID = "5219991230000";
function webhook(messageId: string, body: string): [string, RequestInit] {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "9876543210" }, messages: [{ id: messageId, from: WA_ID, type: "text", text: { body } }] } }] }] });
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return ["/v1/hoteles/whatsapp/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } }];
}

async function setupWebhook(handoff: boolean) {
  const ctx = await buildHotelesTestContext(buildApp);
  const repo = new InMemoryConversacionesRepository({ now: () => new Date() });
  repo.seedCanal(ctx.propertyId);
  ctx.hotelesRepo.seedWhatsAppChannel(ctx.propertyId, ctx.organizationId, "9876543210");
  const handleInboundMessage = vi.fn(async () => ({ reply: "Hola, soy el asistente.", fnbOrderId: null, ...(handoff ? { handoff: { motivo: "agente_derivo" } } : {}) }));
  const hotelesTurnHandler: HotelesWhatsAppTurnHandler = { handleInboundMessage };
  const app = buildApp({ ...ctx.deps, hotelesTurnHandler, hotelesConversacionesRepo: (_db) => repo, hotelesConversacionesSistema: (_db) => repo.sistema() });
  const id = repo.seedConversacion({ propertyId: ctx.propertyId, organizationId: ctx.organizationId, phone: `+${WA_ID}`, mensajes: [{ role: "user", content: "Hola" }], ultimoEntranteEn: null });
  return { ctx, repo, app, id, handleInboundMessage };
}

describe("webhook de WhatsApp con el estado de la conversacion (punta a punta por HTTP)", () => {
  it("agente silenciado en humano: el mensaje se guarda, el agente NO corre, NO se encola respuesta y la bandeja lo muestra como no leido", async () => {
    const w = await setupWebhook(false);
    await w.repo.tomar({ userId: w.ctx.staff.frontdesk.id, role: "frontdesk" }, w.ctx.propertyId, w.id, false);
    const res = await w.app.request(...webhook("wamid.humano-1", "Necesito mi factura"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(w.handleInboundMessage).not.toHaveBeenCalled();
    expect(await w.ctx.hotelesRepo.claimMessagingOutboxBatch(50, 60)).toHaveLength(0);
    expect(w.repo.estado(w.id)).toMatchObject({ modo: "humano", noLeidos: 1, responsableId: w.ctx.staff.frontdesk.id });
    const bandeja = await json<Bandeja>(await w.app.request(`/hoteles/${w.ctx.propertyId}/conversaciones`, authedJson(w.ctx.staff.frontdesk.token)));
    expect(bandeja.items[0]).toMatchObject({ id: w.id, estado: "humano", noLeidos: 1 });
  });

  it("handoff del agente: la respuesta de ese turno se envia, la conversacion queda por atender, se notifica UNA vez y el siguiente mensaje ya no lo atiende el agente", async () => {
    const w = await setupWebhook(true);
    const res = await w.app.request(...webhook("wamid.handoff-1", "Quiero negociar un precio para un grupo"));
    expect(res.status).toBe(200);
    expect(w.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(await w.ctx.hotelesRepo.claimMessagingOutboxBatch(50, 60)).toHaveLength(1);
    expect(w.repo.estado(w.id)).toMatchObject({ modo: "humano", responsableId: null, handoffN: 1, motivo: "agente_derivo" });
    expect(w.repo.notificaciones).toEqual([{ evento: "hoteles.conversacion.handoff", organizationId: w.ctx.organizationId, propertyId: w.ctx.propertyId, clave: `${w.id}:1` }]);
    const bandeja = await json<Bandeja>(await w.app.request(`/hoteles/${w.ctx.propertyId}/conversaciones?estado=por_atender`, authedJson(w.ctx.staff.reservations.token)));
    expect(bandeja.items.map((i) => i.id)).toEqual([w.id]);
    expect(bandeja.items[0]!.porAtender).toBe(true);
    await w.app.request(...webhook("wamid.handoff-2", "¿Hay alguien?"));
    expect(w.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(w.repo.notificaciones).toHaveLength(1);
  });

  it("devuelta al agente, vuelve a responder; cerrada, se reabre con el agente al escribir el huesped", async () => {
    const w = await setupWebhook(false);
    const actor = { userId: w.ctx.staff.frontdesk.id, role: "frontdesk" } as const;
    await w.repo.tomar(actor, w.ctx.propertyId, w.id, false);
    await w.repo.devolver(actor, w.ctx.propertyId, w.id);
    await w.app.request(...webhook("wamid.vuelve-1", "gracias"));
    expect(w.handleInboundMessage).toHaveBeenCalledTimes(1);
    await w.repo.cerrar(actor, w.ctx.propertyId, w.id);
    await w.app.request(...webhook("wamid.vuelve-2", "una duda mas"));
    expect(w.handleInboundMessage).toHaveBeenCalledTimes(2);
    expect(w.repo.estado(w.id)!.modo).toBe("agente");
  });

  it("base sin la migracion 043: el webhook responde como siempre (el agente atiende), nunca 500", async () => {
    const w = await setupWebhook(false);
    w.repo.migrated = false;
    const res = await w.app.request(...webhook("wamid.sin-migrar-1", "hola"));
    expect(res.status).toBe(200);
    expect(w.handleInboundMessage).toHaveBeenCalledTimes(1);
  });
});
