// Productores de notificaciones in-app de rentas: el cron de sync iCal emite (uno por property y dia, solo conteos) feeds con error,
// reservas nuevas y conflictos de calendario; un borrador de mensaje a huesped (siempre pendiente de aprobacion) emite un aviso por
// borrador. Una emision que falla (base sin 0039) no cambia la respuesta de negocio.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const URL_BOOKING = "https://admin.booking.com/hotel/hoteladmin/ical.html?t=unidad-1";
const ics = (uid: string, ini: string, fin: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${ini}`, `DTEND;VALUE=DATE:${fin}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const cron = (app: ReturnType<typeof buildApp>) => app.request("/internal/rentas/ical-sync", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

async function contexto(opciones: { alEmitir?: () => number } = {}) {
  const ctx = await buildRentasTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps, opciones);
  const app = buildApp(deps);
  const configurar = (canal: string, url: string) => app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/${canal}/ical-sync`, authedJson(ctx.staff.adminGestora.token, { url }));
  return { ctx, app, emisiones, configurar };
}

describe("rentas.reserva.nueva_ical", () => {
  it("una reserva nueva importada del canal emite UN aviso con el conteo, a admin_gestora y operadores, con clave property + dia", async () => {
    const { ctx, app, emisiones, configurar } = await contexto();
    await configurar("airbnb", URL_AIRBNB);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("n-1@airbnb.com", "20261001", "20261004") });
    expect((await cron(app)).status).toBe(200);
    const nuevas = emisiones.filter((e) => e.evento === "rentas.reserva.nueva_ical");
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      categoria: "operacion",
      cuerpo: "Nuevas: 1.",
      enlace: "/rentas/{orgSlug}/calendario",
      roles: ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"],
    });
    expect(nuevas[0]!.dedupeKey).toMatch(new RegExp(`^rentas\\.reserva\\.nueva_ical:${ctx.propertyId}:\\d{4}-\\d{2}-\\d{2}$`));
    expect(emisiones.some((e) => e.evento === "rentas.ical.sync_fallido" || e.evento === "rentas.conflicto.detectado")).toBe(false);
  });

  it("un ciclo sin eventos nuevos (feed vacio) no emite nada", async () => {
    const { ctx, app, emisiones, configurar } = await contexto();
    await configurar("airbnb", URL_AIRBNB);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "vacio" });
    expect((await cron(app)).status).toBe(200);
    expect(emisiones).toHaveLength(0);
  });
});

describe("rentas.ical.sync_fallido", () => {
  it("un feed inaccesible emite UN aviso critico con el conteo de feeds con error; el cron responde 200 con ok:false", async () => {
    const { ctx, app, emisiones, configurar } = await contexto();
    await configurar("airbnb", URL_AIRBNB);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "inaccesible" });
    const res = await cron(app);
    expect(res.status).toBe(200);
    const fallos = emisiones.filter((e) => e.evento === "rentas.ical.sync_fallido");
    expect(fallos).toHaveLength(1);
    expect(fallos[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, severidad: "critica", categoria: "salud", cuerpo: "Calendarios con error: 1.", enlace: "/rentas/{orgSlug}/monitor-sync", roles: ["admin_gestora", "operador:acceso_total"] });
  });

  it("una emision que falla (base sin migrar) no cambia la respuesta del cron", async () => {
    const { ctx, app, configurar } = await contexto({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    await configurar("airbnb", URL_AIRBNB);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("n-2@airbnb.com", "20261101", "20261104") });
    const res = await cron(app);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean; resultados: { eventosAplicados: number }[] }).resultados[0]!.eventosAplicados).toBe(1);
  });
});

describe("rentas.conflicto.detectado", () => {
  it("una reserva de otro canal que traslapa con una ya confirmada emite el aviso critico con el conteo de conflictos", async () => {
    const { ctx, app, emisiones, configurar } = await contexto();
    await configurar("airbnb", URL_AIRBNB);
    await configurar("booking", URL_BOOKING);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("c-1@airbnb.com", "20261201", "20261205") });
    ctx.rentasIcalFeedPort.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("c-1@booking.com", "20261203", "20261207") });
    const res = await cron(app);
    expect(res.status).toBe(200);
    const conflictos = emisiones.filter((e) => e.evento === "rentas.conflicto.detectado");
    expect(conflictos).toHaveLength(1);
    expect(conflictos[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, severidad: "critica", cuerpo: "Conflictos: 1.", enlace: "/rentas/{orgSlug}/calendario", roles: ["admin_gestora", "operador:acceso_total"] });
  });
});

describe("rentas.aprobacion.pendiente", () => {
  async function conversacion(app: ReturnType<typeof buildApp>, ctx: Awaited<ReturnType<typeof contexto>>["ctx"]) {
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/conversaciones`, authedJson(ctx.staff.adminGestora.token, { canal: "airbnb", propiedadNombre: "Casa Sol" }));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  it("generar un borrador (siempre pendiente de aprobacion) emite UN aviso por borrador, sin el texto del huesped ni del borrador", async () => {
    const { ctx, app, emisiones } = await contexto();
    const conv = await conversacion(app, ctx);
    const res = await app.request(`/rentas/${ctx.propertyId}/conversaciones/${conv.id}/borradores`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(201);
    const borrador = (await res.json()) as { id: string; texto: string };
    const mias = emisiones.filter((e) => e.evento === "rentas.aprobacion.pendiente");
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      categoria: "aprobaciones",
      enlace: "/rentas/{orgSlug}/aprobaciones",
      dedupeKey: `rentas.aprobacion.pendiente:${borrador.id}`,
      roles: ["admin_gestora", "operador:calendario_mensajeria"],
    });
    expect(JSON.stringify(mias[0])).not.toContain(borrador.texto.slice(0, 20));
  });

  it("una emision que falla (base sin migrar) no cambia el 201 del borrador", async () => {
    const { ctx, app } = await contexto({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const conv = await conversacion(app, ctx);
    expect((await app.request(`/rentas/${ctx.propertyId}/conversaciones/${conv.id}/borradores`, authedJson(ctx.staff.adminGestora.token, {}))).status).toBe(201);
  });
});

describe("rentas.aprobacion.urgente", () => {
  async function conversacion(app: ReturnType<typeof buildApp>, ctx: Awaited<ReturnType<typeof contexto>>["ctx"]) {
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/conversaciones`, authedJson(ctx.staff.adminGestora.token, { canal: "airbnb", propiedadNombre: "Casa Sol" }));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }
  async function generar(app: ReturnType<typeof buildApp>, ctx: Awaited<ReturnType<typeof contexto>>["ctx"], conversacionId: string, textoHuesped: string) {
    const msg = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/conversaciones/${conversacionId}/mensajes`, authedJson(ctx.staff.adminGestora.token, { texto: textoHuesped }));
    const { id } = (await msg.json()) as { id: string };
    const res = await app.request(`/rentas/${ctx.propertyId}/conversaciones/${conversacionId}/borradores`, authedJson(ctx.staff.adminGestora.token, { mensajeEntranteId: id }));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; texto: string };
  }

  it("un borrador escalado emite UN aviso critico urgente (con enlace a la conversacion, sin PII) EN LUGAR del pendiente", async () => {
    const { ctx, app, emisiones } = await contexto();
    const conv = await conversacion(app, ctx);
    const borrador = await generar(app, ctx, conv.id, "Esto es una emergencia, hay una fuga de gas");
    const urgentes = emisiones.filter((e) => e.evento === "rentas.aprobacion.urgente");
    expect(urgentes).toHaveLength(1);
    expect(urgentes[0]).toMatchObject({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      severidad: "critica",
      categoria: "aprobaciones",
      enlace: `/rentas/{orgSlug}/aprobaciones/${conv.id}`,
      dedupeKey: `rentas.aprobacion.urgente:${borrador.id}`,
      roles: ["admin_gestora", "operador:calendario_mensajeria"],
    });
    expect(JSON.stringify(urgentes[0])).not.toContain("fuga");
    expect(JSON.stringify(urgentes[0])).not.toContain(borrador.texto.slice(0, 20));
    expect(emisiones.filter((e) => e.evento === "rentas.aprobacion.pendiente")).toHaveLength(0);
  });

  it("un borrador rutinario emite solo el pendiente, y dos borradores escalados emiten un urgente cada uno (clave por borrador)", async () => {
    const { ctx, app, emisiones } = await contexto();
    const conv = await conversacion(app, ctx);
    await generar(app, ctx, conv.id, "¿Cuál es la clave del wifi?");
    expect(emisiones.filter((e) => e.evento === "rentas.aprobacion.pendiente")).toHaveLength(1);
    expect(emisiones.filter((e) => e.evento === "rentas.aprobacion.urgente")).toHaveLength(0);
    const a = await generar(app, ctx, conv.id, "Quiero un reembolso");
    const b = await generar(app, ctx, conv.id, "Quiero un reembolso otra vez");
    const urgentes = emisiones.filter((e) => e.evento === "rentas.aprobacion.urgente");
    expect(urgentes.map((e) => e.dedupeKey)).toEqual([`rentas.aprobacion.urgente:${a.id}`, `rentas.aprobacion.urgente:${b.id}`]);
    expect(emisiones.filter((e) => e.evento === "rentas.aprobacion.pendiente")).toHaveLength(1);
  });

  it("una emision que falla (base sin migrar) no cambia el 201 del borrador escalado", async () => {
    const { ctx, app } = await contexto({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const conv = await conversacion(app, ctx);
    await generar(app, ctx, conv.id, "Hay una emergencia");
  });
});
