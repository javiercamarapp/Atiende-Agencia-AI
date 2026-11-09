// H-P3-03 -- mensajes automaticos al huesped de hoteles: integracion HTTP real (app.request) sobre los repositorios en memoria. Cubre roles,
// cross-tenant, las decisiones del hold que encolan el aviso, el cron (secreto, idempotencia), la base sin migrar (no-op honesto, nunca un 500)
// y el estado honesto "sin credencial de Meta". RLS/GRANT/triggers, la derivacion del estado real y la concurrencia en la base los cubre
// scripts/verify-hoteles-mensajes-huesped contra Postgres real; el SAVEPOINT lo cubre packages/domain-hoteles/tests/mensajes-huesped/postgres-savepoint.spec.ts.
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryMensajeriaConfigRepository, InMemoryMensajesHuespedRepository, InMemoryReservasAgenteRepository, type CandidatoMensajeHuesped, type EventoMensajeHuesped } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";
import { jsonRequestInit, TEST_ENV } from "./fixtures.ts";

const NOW = new Date("2031-06-01T18:00:00Z");
const SECRET = "secreto-de-esta-property";
const PHONE = "+5219991110001";
const TOTAL = 357_000;
const CRON = "/internal/hoteles/mensajes-huesped";
const CRON_HEADERS = { "x-atiende-internal-secret": "test-internal-secret" };

const EVENTO_POR_ESTADO: Record<string, EventoMensajeHuesped | undefined> = { aprobado: "hold.aprobado", rechazado: "hold.rechazado", confirmado: "hold.confirmado", expirado: "hold.vencido" };

interface Opciones {
  readonly migrado?: boolean;
  readonly conMeta?: boolean;
  readonly puedeAdministrarPlantillas?: boolean;
}

async function setup(opts: Opciones = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  await ctx.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, SECRET, true);
  const reservas = new InMemoryReservasAgenteRepository();
  reservas.clock = () => NOW;
  const doble = randomUUID();
  reservas.seedProperty(ctx.propertyId, { organizationId: ctx.organizationId });
  reservas.seedRoomType(ctx.propertyId, doble, "Doble", 2);
  reservas.seedInventory(ctx.propertyId, doble, "2031-06-01", "2031-07-15", 2, 150_000);
  reservas.setPolicy(ctx.propertyId, { holdsEnabled: true });

  const mensajes = new InMemoryMensajesHuespedRepository({ migrado: opts.migrado, puedeAdministrarPlantillas: opts.puedeAdministrarPlantillas });
  // La base DERIVA los candidatos del estado real del hold; el doble lo imita leyendo los holds en memoria.
  mensajes.derivador = () =>
    reservas.allHolds().flatMap((h): CandidatoMensajeHuesped[] => {
      const evento = EVENTO_POR_ESTADO[h.status];
      if (!evento) return [];
      return [
        {
          evento, refTipo: "hold", refId: h.id, organizationId: ctx.organizationId, propertyId: ctx.propertyId, propiedadNombre: "Hotel de Prueba", orgSlug: "hotel-de-prueba", zonaHoraria: "America/Mexico_City",
          huespedNombre: h.guestName, telefono: h.contactPhone, correo: null, llegada: h.checkInDate, salida: h.checkOutDate, totalCentavos: h.totalCents, venceEn: h.expiresAt, disparoEn: NOW.toISOString(),
          phoneNumberId: "10000000000001", whatsappHabilitado: true, ultimaEntradaEn: null, ventanaInicio: "08:00:00", ventanaFin: "21:00:00", resenaUrl: null, horasAntes: null,
        },
      ];
    });
  const env = { ...ctx.deps.env, whatsappAccessToken: opts.conMeta === false ? null : "token-de-prueba" };
  const canal = new InMemoryMensajeriaConfigRepository();
  await canal.saveWhatsAppChannel(ctx.propertyId, { phoneNumberId: "10000000000001", enabled: true });
  const app = buildApp({ ...ctx.deps, env, hotelesReservasAgenteRepo: () => reservas, hotelesMensajesHuespedRepo: () => mensajes, hotelesMensajeriaConfigRepo: () => canal });

  const voz = (tool: string, body: unknown) => app.request(`/v1/hoteles/${ctx.propertyId}/voz/reservas/${tool}`, jsonRequestInit(body, { "x-atiende-tool-secret": SECRET }));
  const staff = (role: keyof HotelesTestContext["staff"], method: string, path: string, body?: unknown, base = "mensajes-huesped") => {
    reservas.actor = { userId: ctx.staff[role].id, role: role === "owner" || role === "gm" || role === "frontdesk" || role === "reservations" ? role : "housekeeping" };
    return app.request(`/hoteles/${ctx.propertyId}/${base}${path}`, { ...authedJson(ctx.staff[role].token, body), method });
  };
  const crearHold = async (telefono = PHONE): Promise<string> => {
    reservas.actor = { userId: null, role: null }; // el agente (voz/WhatsApp) corre en sesion de sistema
    const body = { tipo_habitacion_id: doble, fecha_llegada: "2031-06-12", fecha_salida: "2031-06-14", huespedes: 2, total_cotizado_centavos: TOTAL, telefono };
    return ((await (await voz("crear_pre_reserva", body)).json()) as { pre_reserva_id: string }).pre_reserva_id;
  };
  return { ctx, app, mensajes, reservas, staff, voz, crearHold, doble };
}

describe("roles y validacion: /hoteles/:propertyId/mensajes-huesped", () => {
  it("lectura: owner/gm/frontdesk/reservations/accountant ven; housekeeping y fnb 403; sin token 401", async () => {
    const s = await setup();
    for (const role of ["owner", "gm", "frontdesk", "reservations", "accountant"] as const) expect((await s.staff(role, "GET", "")).status, role).toBe(200);
    for (const role of ["housekeeping", "fnb"] as const) expect((await s.staff(role, "GET", "")).status, role).toBe(403);
    expect((await s.app.request(`/hoteles/${s.ctx.propertyId}/mensajes-huesped`)).status).toBe(401);
  });

  it("configurar: owner y gm si; frontdesk, reservations, accountant y housekeeping 403", async () => {
    const s = await setup();
    for (const role of ["owner", "gm"] as const) expect((await s.staff(role, "PUT", "/pre_llegada", { activo: true, horasAntes: 48 })).status, role).toBe(200);
    for (const role of ["frontdesk", "reservations", "accountant", "housekeeping"] as const) expect((await s.staff(role, "PUT", "/pre_llegada", { activo: true })).status, role).toBe(403);
  });

  it("valida el evento, el booleano, las horas (1 a 336) y el enlace de resena (https y solo de post_estancia)", async () => {
    const s = await setup();
    expect((await s.staff("owner", "PUT", "/inventado", { activo: true })).status).toBe(404);
    expect((await s.staff("owner", "PUT", "/pre_llegada", { activo: "si" })).status).toBe(400);
    expect((await s.staff("owner", "PUT", "/pre_llegada", { activo: true, horasAntes: 0 })).status).toBe(400);
    expect((await s.staff("owner", "PUT", "/pre_llegada", { activo: true, horasAntes: 400 })).status).toBe(400);
    expect((await s.staff("owner", "PUT", "/hold.aprobado", { activo: true, horasAntes: 10 })).status).toBe(400);
    expect((await s.staff("owner", "PUT", "/post_estancia", { activo: true, resenaUrl: "http://inseguro.example.com" })).status).toBe(400);
    expect((await s.staff("owner", "PUT", "/pre_llegada", { activo: true, resenaUrl: "https://ok.example.com" })).status).toBe(400);
    const ok = await s.staff("owner", "PUT", "/post_estancia", { activo: true, resenaUrl: "https://g.page/r/ejemplo/review" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ evento: "post_estancia", activo: true, resenaUrl: "https://g.page/r/ejemplo/review", configurada: true });
  });

  it("GET devuelve los 8 eventos con sus valores por omision y refleja lo guardado", async () => {
    const s = await setup();
    await s.staff("gm", "PUT", "/pre_llegada", { activo: true, horasAntes: 72 });
    const body = (await (await s.staff("frontdesk", "GET", "")).json()) as { disponible: boolean; eventos: Array<{ evento: string; activo: boolean; horasAntes: number | null; configurada: boolean; transaccional: boolean }>; puedeConfigurar: boolean };
    expect(body.disponible).toBe(true);
    expect(body.puedeConfigurar).toBe(false);
    expect(body.eventos.map((e) => e.evento)).toEqual(["hold.aprobado", "hold.rechazado", "hold.confirmado", "hold.vencido", "reserva.confirmada", "pre_llegada", "post_estancia", "lista_espera.ofrecida"]);
    expect(body.eventos.find((e) => e.evento === "pre_llegada")).toMatchObject({ activo: true, horasAntes: 72, configurada: true });
    expect(body.eventos.find((e) => e.evento === "hold.aprobado")).toMatchObject({ activo: true, configurada: false, transaccional: true });
    expect(body.eventos.find((e) => e.evento === "post_estancia")).toMatchObject({ activo: false, configurada: false, transaccional: false });
  });

  it("cross-tenant: un usuario de otro hotel no ve ni configura esta propiedad", async () => {
    const s = await setup();
    const otra = await buildHotelesTestContext(buildApp);
    const intento = (path: string, init: RequestInit) => s.app.request(`/hoteles/${s.ctx.propertyId}/mensajes-huesped${path}`, init);
    // El token del owner de OTRO hotel (otra organizacion) contra la propiedad de este.
    const lectura = await intento("", authedJson(otra.staff.owner.token));
    expect([401, 403, 404]).toContain(lectura.status);
    expect(lectura.status).not.toBe(200);
    const escritura = await intento("/pre_llegada", { ...authedJson(otra.staff.owner.token, { activo: true }), method: "PUT" });
    expect(escritura.status).not.toBe(200);
    expect(s.mensajes.configs.size).toBe(0);
  });
});

describe("las decisiones del hold encolan el aviso al huesped", () => {
  it("aprobar un hold: despues del commit el aviso queda en el outbox (WhatsApp, transaccional) y la bitacora lo registra", async () => {
    const s = await setup();
    await s.staff("owner", "PUT", "/hold.aprobado/plantilla", { nombre: "hotel_hold_aprobado", variables: ["nombre", "hotel"], estado: "aprobada" });
    const holdId = await s.crearHold();
    expect(s.mensajes.outbox).toHaveLength(0);
    const res = await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "Huesped conocido" }, "reservas-agente");
    expect(res.status).toBe(200);
    expect(s.mensajes.outbox).toHaveLength(1);
    expect(s.mensajes.outbox[0]).toMatchObject({ evento: "hold.aprobado", refId: holdId, canal: "whatsapp", eventType: "mh.hold.aprobado" });
    expect(s.mensajes.envios).toHaveLength(1);
    const historial = (await (await s.staff("frontdesk", "GET", "/historial")).json()) as { envios: Array<{ evento: string; estado: string; canal: string | null; envio: string | null }> };
    expect(historial.envios[0]).toMatchObject({ evento: "hold.aprobado", estado: "encolado", canal: "whatsapp", envio: "pending" });
  });

  it("sin plantilla aprobada ni correo del hold, el aviso queda NO ENVIADO por sin_plantilla (no se manda un texto que Meta rechazaria)", async () => {
    const s = await setup();
    const holdId = await s.crearHold();
    await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    expect(s.mensajes.outbox).toHaveLength(0);
    expect(s.mensajes.envios[0]).toMatchObject({ evento: "hold.aprobado", canal: null, motivo: "sin_plantilla" });
  });

  it("con plantilla HSM aprobada en el catalogo el aviso sale por WhatsApp con plantilla; rechazar avisa hold.rechazado", async () => {
    const s = await setup();
    const owner = await s.staff("owner", "PUT", "/hold.aprobado/plantilla", { nombre: "hotel_hold_aprobado", idioma: "es_MX", variables: ["nombre", "hotel", "llegada"], estado: "aprobada" });
    expect(owner.status).toBe(200);
    const aprobado = await s.crearHold();
    expect((await s.staff("reservations", "POST", `/holds/${aprobado}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente")).status).toBe(200);
    const aprobadoMsg = s.mensajes.outbox.find((m) => m.refId === aprobado)!;
    expect(aprobadoMsg).toMatchObject({ canal: "whatsapp", evento: "hold.aprobado" });
    expect(aprobadoMsg.payload).toMatchObject({ to: PHONE, transaccional: true, template: { name: "hotel_hold_aprobado", language: "es_MX" } });

    const rechazado = await s.crearHold("+5219991110002");
    await s.staff("reservations", "POST", `/holds/${rechazado}/decidir`, { decision: "rechazar", motivo: "Sin cupo real" }, "reservas-agente");
    expect(s.mensajes.envios.find((e) => e.refId === rechazado)).toMatchObject({ evento: "hold.rechazado" });
  });

  it("confirmar un hold aprobado avisa hold.confirmado ademas de hold.aprobado (la marca es por referencia y evento)", async () => {
    const s = await setup();
    const holdId = await s.crearHold();
    await s.staff("gm", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    const confirmar = await s.staff("gm", "POST", `/holds/${holdId}/confirmar`, undefined, "reservas-agente");
    expect(confirmar.status).toBe(200);
    expect(s.mensajes.envios.map((e) => e.evento).sort()).toEqual(["hold.aprobado", "hold.confirmado"]);
  });

  it("un evento apagado por gerencia no se avisa (hold.aprobado activo=false)", async () => {
    const s = await setup();
    await s.staff("owner", "PUT", "/hold.aprobado", { activo: false });
    const holdId = await s.crearHold();
    await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    expect(s.mensajes.envios).toHaveLength(0);
  });

  it("sin credencial de Meta en la plataforma el aviso NO sale por WhatsApp: queda no enviado con su motivo (sin correo del hold)", async () => {
    const s = await setup({ conMeta: false });
    const holdId = await s.crearHold();
    await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    expect(s.mensajes.outbox).toHaveLength(0);
    expect(s.mensajes.envios[0]).toMatchObject({ evento: "hold.aprobado", canal: null, motivo: "whatsapp_no_disponible" });
  });

  it("la decision del staff NO falla ni se revierte si los mensajes no estan disponibles (base sin la migracion 046)", async () => {
    const s = await setup({ migrado: false });
    const holdId = await s.crearHold();
    const res = await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hold: { estado: string } }).hold.estado).toBe("aprobado");
    expect(s.mensajes.envios).toHaveLength(0);
  });
});

describe("cron /internal/hoteles/mensajes-huesped", () => {
  it("sin secreto 401; con secreto procesa los holds ya decididos y una segunda corrida no duplica nada (idempotencia)", async () => {
    const s = await setup();
    expect((await s.app.request(CRON, { method: "GET" })).status).toBe(401);
    expect((await s.app.request(CRON, { method: "GET", headers: { authorization: "Bearer incorrecto" } })).status).toBe(401);
    await s.staff("owner", "PUT", "/hold.aprobado/plantilla", { nombre: "hotel_hold_aprobado", variables: ["nombre", "hotel"], estado: "aprobada" });
    const holdId = await s.crearHold();
    // La decision del staff dispara la corrida acotada (post-commit): vaciamos para probar el cron solo.
    await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    s.mensajes.envios.length = 0;
    s.mensajes.outbox.length = 0;
    const primera = await s.app.request(CRON, { method: "GET", headers: CRON_HEADERS });
    expect(primera.status).toBe(200);
    expect(await primera.json()).toMatchObject({ ok: true, disponible: true, candidatos: 1, encolados: 1 });
    const segunda = await s.app.request(CRON, { method: "POST", headers: CRON_HEADERS });
    expect(await segunda.json()).toMatchObject({ ok: true, candidatos: 0, encolados: 0 });
    expect(s.mensajes.outbox).toHaveLength(1);
  });

  it("el cron holds-vencidos (unico cron de hoteles a */15 con cupo en vercel.json) encadena el ciclo de mensajes y lo reporta", async () => {
    const s = await setup();
    await s.staff("owner", "PUT", "/hold.aprobado/plantilla", { nombre: "hotel_hold_aprobado", variables: ["nombre", "hotel"], estado: "aprobada" });
    const holdId = await s.crearHold();
    await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    s.mensajes.outbox.length = 0;
    const res = await s.app.request("/internal/hoteles/holds-vencidos", { method: "GET", headers: CRON_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mensajes_huesped: { disponible: true, errores: 0 } });
  });

  it("base sin migrar: responde 200 disponible:false y no toca nada", async () => {
    const s = await setup({ migrado: false });
    const res = await s.app.request(CRON, { method: "GET", headers: CRON_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: false, candidatos: 0, encolados: 0 });
  });
});

describe("historial, estado honesto de WhatsApp y plantillas", () => {
  it("GET con la plataforma sin credencial de Meta: explica que se enviara por correo; con credencial y canal activo, listo", async () => {
    const sin = await setup({ conMeta: false });
    const a = (await (await sin.staff("owner", "GET", "")).json()) as { whatsapp: { canalConfigurado: boolean; credencialMeta: boolean; listo: boolean; aviso: string | null } };
    expect(a.whatsapp).toMatchObject({ canalConfigurado: true, credencialMeta: false, listo: false, aviso: "requiere credencial de WhatsApp (Meta); se enviará por correo" });
    const con = await setup();
    const b = (await (await con.staff("owner", "GET", "")).json()) as { whatsapp: { listo: boolean; aviso: string | null } };
    expect(b.whatsapp).toMatchObject({ listo: true, aviso: null });
  });

  it("historial: lista los envios con estado, canal y el motivo cuando no salio; limite validado; housekeeping 403", async () => {
    const s = await setup({ conMeta: false });
    const holdId = await s.crearHold();
    await s.staff("reservations", "POST", `/holds/${holdId}/decidir`, { decision: "aprobar", motivo: "ok" }, "reservas-agente");
    const res = await s.staff("frontdesk", "GET", "/historial");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; envios: Array<{ evento: string; estado: string; motivo: string | null; motivoTexto: string | null }> };
    expect(body.envios[0]).toMatchObject({ evento: "hold.aprobado", estado: "no_enviado", motivo: "whatsapp_no_disponible" });
    expect(body.envios[0]!.motivoTexto).toMatch(/WhatsApp no está disponible/);
    expect((await s.staff("frontdesk", "GET", "/historial?limite=0")).status).toBe(400);
    expect((await s.staff("frontdesk", "GET", "/historial?limite=abc")).status).toBe(400);
    expect((await s.staff("housekeeping", "GET", "/historial")).status).toBe(403);
  });

  it("historial y config sin la migracion 046: disponible:false (estado honesto) y las escrituras 503", async () => {
    const s = await setup({ migrado: false });
    expect(await (await s.staff("owner", "GET", "/historial")).json()).toMatchObject({ disponible: false, envios: [] });
    expect(await (await s.staff("owner", "GET", "")).json()).toMatchObject({ disponible: false });
    expect((await s.staff("owner", "PUT", "/pre_llegada", { activo: true })).status).toBe(503);
  });

  it("plantillas: owner/gm registran y quitan; variable que el evento no sabe llenar 400; sin permiso de la organizacion 403; evento sin plantilla 404", async () => {
    const s = await setup();
    expect((await s.staff("gm", "PUT", "/pre_llegada/plantilla", { nombre: "hotel_pre_llegada", variables: ["nombre", "enlace_aviso"], estado: "aprobada" })).status).toBe(200);
    expect((await s.staff("gm", "PUT", "/pre_llegada/plantilla", { nombre: "hotel_pre_llegada", variables: ["total"], estado: "aprobada" })).status).toBe(400);
    expect((await s.staff("gm", "PUT", "/pre_llegada/plantilla", { nombre: "Nombre Mal", variables: [], estado: "aprobada" })).status).toBe(400);
    expect((await s.staff("frontdesk", "PUT", "/pre_llegada/plantilla", { nombre: "x", variables: [], estado: "borrador" })).status).toBe(403);
    const lista = (await (await s.staff("owner", "GET", "")).json()) as { eventos: Array<{ evento: string; plantilla: { nombre: string; estado: string } | null }> };
    expect(lista.eventos.find((e) => e.evento === "pre_llegada")!.plantilla).toMatchObject({ nombre: "hotel_pre_llegada", estado: "aprobada" });
    expect((await s.staff("owner", "DELETE", "/pre_llegada/plantilla")).status).toBe(200);
    expect((await s.staff("owner", "DELETE", "/pre_llegada/plantilla")).status).toBe(404);
    expect((await s.staff("owner", "DELETE", "/inventado/plantilla")).status).toBe(404);
    const sinPermiso = await setup({ puedeAdministrarPlantillas: false });
    expect((await sinPermiso.staff("gm", "PUT", "/pre_llegada/plantilla", { nombre: "x", variables: [], estado: "borrador" })).status).toBe(403);
  });
});

describe("primer contacto por WhatsApp: el aviso de privacidad lo pone el codigo", () => {
  function firmado(messageId: string, texto: string): RequestInit {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "9876543210" }, messages: [{ id: messageId, from: "5219991230000", type: "text", text: { body: texto } }] } }] }] });
    const bytes = new TextEncoder().encode(raw);
    const firma = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
    return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": firma } };
  }

  it("el PRIMER mensaje de la conversacion sale con la linea de IA y el enlace /hoteles/:orgSlug/aviso; el segundo ya no", async () => {
    const s = await setup();
    s.ctx.hotelesRepo.seedWhatsAppChannel(s.ctx.propertyId, s.ctx.organizationId, "9876543210");
    s.mensajes.slugs.set(s.ctx.propertyId, "hotel-de-prueba");
    expect((await s.app.request("/v1/hoteles/whatsapp/webhook", firmado("wamid.pc-1", "Hola, buenas tardes"))).status).toBe(200);
    expect((await s.app.request("/v1/hoteles/whatsapp/webhook", firmado("wamid.pc-2", "Quiero informacion"))).status).toBe(200);
    const salida = (await s.ctx.hotelesRepo.claimMessagingOutboxBatch(10, 60)).map((m) => (m.payload as { body: string }).body);
    expect(salida).toHaveLength(2);
    const enlace = `Aviso de privacidad: ${TEST_ENV.appBaseUrl}/hoteles/hotel-de-prueba/aviso`;
    expect(salida.filter((b) => b.includes(enlace))).toHaveLength(1);
    expect(salida.filter((b) => b.includes("inteligencia artificial"))).toHaveLength(1);
  });

  it("sin la migracion 046 (no se puede resolver el slug) el primer mensaje igual sale, con la linea de IA y sin enlace", async () => {
    const s = await setup({ migrado: false });
    s.ctx.hotelesRepo.seedWhatsAppChannel(s.ctx.propertyId, s.ctx.organizationId, "9876543210");
    expect((await s.app.request("/v1/hoteles/whatsapp/webhook", firmado("wamid.pc-3", "Hola"))).status).toBe(200);
    const [salida] = (await s.ctx.hotelesRepo.claimMessagingOutboxBatch(10, 60)).map((m) => (m.payload as { body: string }).body);
    expect(salida).toContain("inteligencia artificial");
    expect(salida).not.toContain("Aviso de privacidad");
  });
});
