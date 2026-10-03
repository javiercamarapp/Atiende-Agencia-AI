// PL-31: HTTP end-to-end de /v1/citas/properties/:propertyId/admin/whatsapp-plantillas. Cada caso afirma el EFECTO (que quedo guardado, que NO se
// escribio, quien puede, y que el catalogo guardado cambia de verdad como sale el aviso).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function construir(opts: { readonly migrada?: boolean } = {}) {
  const ctx = await buildCitasTestContext(buildApp);
  if (opts.migrada !== false) ctx.citasRepo.habilitarPlantillasYVentanaWhatsapp();
  const app = buildApp(ctx.deps);
  const url = `/v1/citas/properties/${ctx.propertyId}/admin/whatsapp-plantillas`;
  return { ctx, app, url };
}

const CUERPO = { nombre: "recordatorio_cita_24h", idioma: "es_MX", variables: ["nombre", "fecha", "hora"], estado: "aprobada" };

describe("GET whatsapp-plantillas", () => {
  it("lista los 3 eventos de citas con sus variables y sin plantilla guardada", async () => {
    const { ctx, app, url } = await construir();
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.disponible).toBe(true);
    expect(body.estados).toEqual(["borrador", "enviada", "aprobada", "rechazada"]);
    expect(body.eventos.map((e: Json) => e.evento)).toEqual(["appointment.reminder_24h", "waitlist.slot_offered", "waitlist.slot_available_broadcast"]);
    expect(body.eventos.every((e: Json) => e.plantilla === null)).toBe(true);
    expect(body.eventos[1].variables).toEqual(["nombre", "negocio"]);
  });

  it("owner y admin pueden; staff NO (403) ni sin sesion (401)", async () => {
    const { ctx, app, url } = await construir();
    expect((await app.request(url, authedGet(ctx.staff.admin.token))).status).toBe(200);
    expect((await app.request(url, authedGet(ctx.staff.staffMember.token))).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
  });

  it("base sin la migracion 0048: 200 con disponible:false (nunca 500)", async () => {
    const { ctx, app, url } = await construir({ migrada: false });
    const body = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as Json;
    expect(body.disponible).toBe(false);
    expect(body.eventos).toHaveLength(3);
  });
});

describe("PUT / DELETE whatsapp-plantillas/:evento", () => {
  it("guarda la plantilla, se ve en el GET, y cambia de verdad como sale el recordatorio (con template)", async () => {
    const { ctx, app, url } = await construir();
    const put = await app.request(`${url}/appointment.reminder_24h`, authedJson(ctx.staff.owner.token, CUERPO, "PUT" as never));
    expect(put.status).toBe(200);
    expect(((await put.json()) as Json).plantilla).toMatchObject({ evento: "appointment.reminder_24h", nombre: "recordatorio_cita_24h", estado: "aprobada", variables: ["nombre", "fecha", "hora"] });
    const lista = (await (await app.request(url, authedGet(ctx.staff.admin.token))).json()) as Json;
    expect(lista.eventos[0].plantilla.nombre).toBe("recordatorio_cita_24h");
    expect(await ctx.citasRepo.resolveWhatsappTemplate(ctx.organizationId, "appointment.reminder_24h")).toEqual({ name: "recordatorio_cita_24h", language: "es_MX", variables: ["nombre", "fecha", "hora"] });
  });

  it("una plantilla en borrador NO se usa para enviar (solo la aprobada)", async () => {
    const { ctx, app, url } = await construir();
    await app.request(`${url}/appointment.reminder_24h`, authedJson(ctx.staff.owner.token, { ...CUERPO, estado: "borrador" }, "PUT" as never));
    expect(await ctx.citasRepo.resolveWhatsappTemplate(ctx.organizationId, "appointment.reminder_24h")).toBeNull();
  });

  it("rechaza (400, sin escribir): nombre con mayusculas, idioma invalido, variable que el evento no calcula, estado desconocido, mas de 10 variables", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    const malos = [
      { ...CUERPO, nombre: "Recordatorio Cita" },
      { ...CUERPO, idioma: "espanol" },
      { ...CUERPO, variables: ["nombre", "doctor"] },
      { ...CUERPO, estado: "publicada" },
      { ...CUERPO, variables: Array.from({ length: 11 }, () => "nombre") },
      "no es un objeto",
    ];
    for (const cuerpo of malos) expect((await app.request(`${url}/appointment.reminder_24h`, authedJson(t, cuerpo, "PUT" as never))).status, JSON.stringify(cuerpo)).toBe(400);
    expect((await ctx.citasRepo.listWhatsappTemplates(ctx.organizationId)).items).toHaveLength(0);
  });

  it("un evento desconocido responde 404 y no escribe", async () => {
    const { ctx, app, url } = await construir();
    expect((await app.request(`${url}/evento.inventado`, authedJson(ctx.staff.owner.token, CUERPO, "PUT" as never))).status).toBe(404);
    expect((await ctx.citasRepo.listWhatsappTemplates(ctx.organizationId)).items).toHaveLength(0);
  });

  it("solo owner/admin escriben: staff 403 y sin sesion 401, y no se escribe nada", async () => {
    const { ctx, app, url } = await construir();
    expect((await app.request(`${url}/appointment.reminder_24h`, authedJson(ctx.staff.staffMember.token, CUERPO, "PUT" as never))).status).toBe(403);
    expect((await app.request(`${url}/appointment.reminder_24h`, { method: "DELETE" })).status).toBe(401);
    expect((await ctx.citasRepo.listWhatsappTemplates(ctx.organizationId)).items).toHaveLength(0);
  });

  it("eliminar descarta la plantilla (el aviso vuelve a sin_plantilla) y repetirlo responde 404", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    await app.request(`${url}/appointment.reminder_24h`, authedJson(t, CUERPO, "PUT" as never));
    expect((await app.request(`${url}/appointment.reminder_24h`, authedJson(t, undefined, "DELETE"))).status).toBe(200);
    expect(await ctx.citasRepo.resolveWhatsappTemplate(ctx.organizationId, "appointment.reminder_24h")).toBeNull();
    expect((await app.request(`${url}/appointment.reminder_24h`, authedJson(t, undefined, "DELETE"))).status).toBe(404);
  });

  it("base sin la migracion 0048: PUT y DELETE responden 503 y no cambian nada", async () => {
    const { ctx, app, url } = await construir({ migrada: false });
    expect((await app.request(`${url}/appointment.reminder_24h`, authedJson(ctx.staff.owner.token, CUERPO, "PUT" as never))).status).toBe(503);
    expect((await app.request(`${url}/appointment.reminder_24h`, authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(503);
  });

  it("la plantilla de otro evento no se mezcla: guardar la de la lista de espera no aprueba la del recordatorio", async () => {
    const { ctx, app, url } = await construir();
    expect(await ctx.citasRepo.resolveWhatsappTemplate(ctx.organizationId, "appointment.reminder_24h")).toBeNull();
    await app.request(`${url}/waitlist.slot_offered`, authedJson(ctx.staff.owner.token, { nombre: "hueco_lista_espera", variables: ["nombre", "negocio"], estado: "aprobada" }, "PUT" as never));
    expect((await ctx.citasRepo.resolveWhatsappTemplate(ctx.organizationId, "waitlist.slot_offered"))?.name).toBe("hueco_lista_espera");
    expect(await ctx.citasRepo.resolveWhatsappTemplate(ctx.organizationId, "appointment.reminder_24h")).toBeNull();
  });
});
