// Voz de citas, lado WORKER: rutas HTTP de las herramientas y el contexto de la llamada (`/v1/citas/:orgSlug/voz/...`). HTTP real via `app.request`
// sobre fixtures in-memory, sin mocks de la logica de negocio; cada caso afirma el EFECTO (que cita quedo, de quien, con que origen).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

const SECRETO = { "x-atiende-tool-secret": "test-voice-tool-secret" };
const BASE = "/v1/citas/clinica-dental-sonrisas/voz";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function llamar(app: ReturnType<typeof buildApp>, herramienta: string, cuerpo: unknown, headers: Record<string, string> = SECRETO) {
  const res = await app.request(`${BASE}/${herramienta}`, jsonRequestInit(cuerpo, headers));
  return { status: res.status, cuerpo: (await res.json()) as Json };
}

/** Proximo lunes real a las 10:00 de Merida (16:00 UTC, sin DST): dentro de la ventana 09:00-17:00 del fixture. */
function proximoLunes16Utc(): { fecha: string; inicio: string } {
  const now = new Date();
  const lunes = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  lunes.setUTCDate(lunes.getUTCDate() + (((1 - lunes.getUTCDay() + 7) % 7) || 7));
  const fecha = lunes.toISOString().slice(0, 10);
  return { fecha, inicio: `${fecha}T16:00:00.000Z` };
}

describe("autenticacion y rutas de las herramientas de voz de citas", () => {
  it("401 sin el secreto de la herramienta, en el contexto y en cualquier herramienta", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    expect((await llamar(app, "listar_servicios", {}, {})).status).toBe(401);
    expect((await llamar(app, "listar_servicios", {}, { "x-atiende-tool-secret": "otro" })).status).toBe(401);
    expect((await app.request(`${BASE}/contexto`)).status).toBe(401);
  });

  it("404 con un negocio que no existe (aun con el secreto) y con una herramienta desconocida", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    expect((await app.request("/v1/citas/no-existe/voz/listar_servicios", jsonRequestInit({}, SECRETO))).status).toBe(404);
    expect((await llamar(app, "borrar_todo", {})).status).toBe(404);
  });

  it("las 4 rutas antiguas del agente de ElevenLabs ya no existen", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    for (const ruta of ["availability", "services", "providers", "customers/appointments"]) {
      const res = await app.request(`/v1/citas/clinica-dental-sonrisas/${ruta}`, jsonRequestInit({}, SECRETO));
      expect(res.status, ruta).toBe(404);
    }
  });
});

describe("herramientas de consulta (sin telefono)", () => {
  it("listar_servicios y listar_proveedores devuelven lo real y nada inventado; el filtro por servicio inexistente da lista vacia", async () => {
    const { deps, serviceId, providerId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const servicios = await llamar(app, "listar_servicios", {});
    expect(servicios.status).toBe(200);
    expect(JSON.stringify(servicios.cuerpo)).toContain(serviceId);
    const proveedores = await llamar(app, "listar_proveedores", { service_id: serviceId });
    expect(JSON.stringify(proveedores.cuerpo)).toContain(providerId);
    const vacio = await llamar(app, "listar_proveedores", { service_id: randomUUID() });
    expect(vacio.status).toBe(200);
    expect(JSON.stringify(vacio.cuerpo)).not.toContain(providerId);
  });

  it("consultar_disponibilidad calcula horarios en el servidor; una fecha mal formada no llega al motor (200 con error para el modelo, nunca un 500)", async () => {
    const { deps, serviceId, providerId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const { fecha } = proximoLunes16Utc();
    const ok = await llamar(app, "consultar_disponibilidad", { provider_id: providerId, service_id: serviceId, date: fecha });
    expect(ok.status).toBe(200);
    expect(ok.cuerpo.slots.length).toBeGreaterThan(0);
    const mala = await llamar(app, "consultar_disponibilidad", { provider_id: providerId, service_id: serviceId, date: "mañana" });
    expect(mala.status).toBe(200);
    expect(typeof mala.cuerpo.error).toBe("string");
  });

  it("un llamante anonimo (sin telefono) no puede buscar, agendar ni cancelar: error con requiere_humano y NO se crea nada", async () => {
    const { deps, citasRepo, serviceId, providerId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const { inicio } = proximoLunes16Utc();
    const busca = await llamar(app, "buscar_mis_citas", {});
    expect(busca.cuerpo).toMatchObject({ error: "llamante_anonimo", requiere_humano: true });
    const crea = await llamar(app, "crear_cita", { provider_id: providerId, service_id: serviceId, customer_name: "Anónimo", starts_at: inicio });
    expect(crea.cuerpo).toMatchObject({ error: "llamante_anonimo", requiere_humano: true });
    expect((await citasRepo.listAppointmentsInRange(deps.env ? (await citasRepo.findOrganizationBySlug("clinica-dental-sonrisas"))!.id : "", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", undefined, 50))).toHaveLength(0);
  });

  it("un telefono que no es un numero es un 400, no se adivina", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    expect((await llamar(app, "buscar_mis_citas", { telefono: "abc" })).status).toBe(400);
    expect((await llamar(app, "buscar_mis_citas", { telefono: 5512345678 })).status).toBe(400);
  });
});

describe("agenda por voz: la cita es del numero de la llamada", () => {
  it("crear_cita queda con origen voice y a nombre del numero de la llamada; buscar_mis_citas de OTRO numero no la ve, aunque el modelo mande el telefono ajeno como argumento", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const org = (await ctx.citasRepo.findOrganizationBySlug("clinica-dental-sonrisas"))!;
    const { inicio } = proximoLunes16Utc();

    const crea = await llamar(app, "crear_cita", { telefono: "+52 999 111 1111", llamada_id: "llamada-1", provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Cliente A", starts_at: inicio });
    expect(crea.status).toBe(200);
    expect(crea.cuerpo.appointment).toBeTruthy();
    const citas = await ctx.citasRepo.listAppointmentsInRange(org.id, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", undefined, 50);
    expect(citas).toHaveLength(1);
    expect(citas[0]!.source).toBe("voice");

    const propia = await llamar(app, "buscar_mis_citas", { telefono: "9991111111" });
    expect(propia.cuerpo.appointments).toHaveLength(1);
    // Otro numero, y el modelo intenta pedir el de A por argumento: el telefono que cuenta es solo el de la llamada.
    const ajena = await llamar(app, "buscar_mis_citas", { telefono: "9992222222", customer_phone: "9991111111", phone: "9991111111" });
    expect(ajena.status).toBe(200);
    expect(ajena.cuerpo.appointments).toHaveLength(0);
  });
});

describe("derivar_a_humano", () => {
  it("sin motivo es 400", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    expect((await llamar(app, "derivar_a_humano", { telefono: "9991111111" })).status).toBe(400);
  });

  it("sin telefono de avisos configurado NO promete callback (aviso_enviado false); con el se encola UN aviso por llamada, aunque se repita", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const sin = await llamar(app, "derivar_a_humano", { telefono: "9991111111", llamada_id: "l-1", motivo: "Quiere hablar con una persona" });
    expect(sin.cuerpo).toMatchObject({ derivado: true, aviso_enviado: false, crisis: false });

    ctx.citasRepo.seedTenantConfig({ organizationId: ctx.organizationId, rubro: "dentista", defaultTimezone: "America/Merida", ownerNotificationPhone: "+5219990001111" });
    const con = await llamar(app, "derivar_a_humano", { telefono: "9991111111", llamada_id: "l-2", motivo: "Quiere hablar con una persona", resumen: "Pidió precio especial" });
    expect(con.cuerpo).toMatchObject({ derivado: true, aviso_enviado: true, crisis: false });
    await llamar(app, "derivar_a_humano", { telefono: "9991111111", llamada_id: "l-2", motivo: "Quiere hablar con una persona" });
    const avisos = ctx.citasRepo.getOutbox().filter((o) => o.eventType === "voz.callback");
    expect(avisos).toHaveLength(1);
    expect(JSON.stringify(avisos[0]!.payload)).toContain("9991111111");
  });

  it("CRISIS en un rubro de salud: registra la escalacion real (canal voice, sin transcripcion) y avisa al dueño; en un rubro que no es de salud el motivo `crisis` no abre ninguna", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.citasRepo.seedTenantConfig({ organizationId: ctx.organizationId, rubro: "psicologo", defaultTimezone: "America/Merida", ownerNotificationPhone: "+5219990001111" });
    const crisis = await llamar(app, "derivar_a_humano", { telefono: "9993334444", llamada_id: "l-3", motivo: "crisis", resumen: "palabra_clave:quiero morirme" });
    expect(crisis.cuerpo).toMatchObject({ derivado: true, crisis: true, aviso_enviado: true });
    const esc = ctx.citasRepo.getEmergencyEscalations();
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ channel: "voice", customerPhone: "9993334444", keywordMatched: "quiero morirme", messageExcerpt: "" });
    expect(ctx.citasRepo.getOutbox().some((o) => o.eventType === "crisis.escalated")).toBe(true);

    ctx.citasRepo.seedTenantConfig({ organizationId: ctx.organizationId, rubro: "otro", defaultTimezone: "America/Merida", ownerNotificationPhone: "+5219990001111" });
    const noSalud = await llamar(app, "derivar_a_humano", { telefono: "9993334444", llamada_id: "l-4", motivo: "crisis", resumen: "palabra_clave:quiero morirme" });
    expect(noSalud.cuerpo.crisis).toBe(false);
    expect(ctx.citasRepo.getEmergencyEscalations()).toHaveLength(1);
  });

  it("el texto libre que mande el modelo en `resumen` NO se guarda como palabra clave ni llega al aviso del dueño: solo la lista fija o el texto fijo", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.citasRepo.seedTenantConfig({ organizationId: ctx.organizationId, rubro: "psicologo", defaultTimezone: "America/Merida", ownerNotificationPhone: "+5219990001111" });
    const libre = "palabra_clave:me siento muy mal y le conte a la asistente que mi pareja me lastima";
    const r = await llamar(app, "derivar_a_humano", { telefono: "9995556666", llamada_id: "l-5", motivo: "crisis", resumen: libre });
    expect(r.cuerpo).toMatchObject({ crisis: true });
    const esc = ctx.citasRepo.getEmergencyEscalations();
    expect(esc).toHaveLength(1);
    expect(esc[0]?.keywordMatched).toBe("señal de crisis en la llamada");
    expect(JSON.stringify(esc)).not.toContain("pareja");
    expect(JSON.stringify(ctx.citasRepo.getOutbox())).not.toContain("pareja");
  });
});

describe("GET /v1/citas/:orgSlug/voz/contexto", () => {
  it("devuelve el prompt con el nombre del negocio, hoy en la zona del negocio, los pregrabados y si el rubro exige la guardia de crisis", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.citasRepo.seedTenantConfig({ organizationId: ctx.organizationId, rubro: "psicologo", defaultTimezone: "America/Merida", ownerNotificationPhone: null });
    const res = await app.request(`${BASE}/contexto`, { method: "GET", headers: SECRETO });
    expect(res.status).toBe(200);
    const c = (await res.json()) as Json;
    expect(c.negocio).toBe("Clínica Dental Sonrisas");
    expect(c.timezone).toBe("America/Merida");
    expect(c.hoy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.guardiaCrisis).toBe(true);
    expect(c.instruccion).toContain("Clínica Dental Sonrisas");
    expect(c.instruccion).toContain("asistente automático");
    expect(c.pregrabados.saludo_respaldo).toContain("Clínica Dental Sonrisas");

    ctx.citasRepo.seedTenantConfig({ organizationId: ctx.organizationId, rubro: "otro", defaultTimezone: "America/Merida", ownerNotificationPhone: null });
    const otro = (await (await app.request(`${BASE}/contexto`, { method: "GET", headers: SECRETO })).json()) as Json;
    expect(otro.guardiaCrisis).toBe(false);
  });

  it("404 con un negocio inexistente", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    expect((await app.request("/v1/citas/no-existe/voz/contexto", { method: "GET", headers: SECRETO })).status).toBe(404);
  });
});
