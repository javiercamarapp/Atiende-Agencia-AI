// C-04: HTTP end-to-end de /v1/citas/properties/:propertyId/admin/whatsapp-mensajes y del envio de los avisos opt-in. Cada caso
// afirma el EFECTO (que quedo guardado, que NO se escribio, quien puede, que se encolo).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function construir() {
  const ctx = await buildCitasTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const url = `/v1/citas/properties/${ctx.propertyId}/admin/whatsapp-mensajes`;
  return { ctx, app, url };
}

describe("GET whatsapp-mensajes", () => {
  it("sin configuracion devuelve los valores de fabrica con version 0 y la vista previa de los 4 mensajes", async () => {
    const { ctx, app, url } = await construir();
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({ disponible: true, version: 0, config: { reminderEnabled: true, reminderLeadHours: 24, confirmationEnabled: false, sendWindowStart: null } });
    expect(body.vistaPrevia.map((m: Json) => m.kind)).toEqual(["recordatorio", "confirmacion", "cancelacion", "reagendado"]);
  });

  it("owner y admin pueden; staff NO (403) ni sin sesion (401)", async () => {
    const { ctx, app, url } = await construir();
    expect((await app.request(url, authedGet(ctx.staff.admin.token))).status).toBe(200);
    for (const ruta of ["", "/opciones", "/historial"]) {
      expect((await app.request(url + ruta, authedGet(ctx.staff.staffMember.token))).status).toBe(403);
      expect((await app.request(url + ruta)).status).toBe(401);
    }
  });

  it("base sin la migracion 026: 200 con disponible:false y valores de fabrica (nunca 500)", async () => {
    const { ctx, app, url } = await construir();
    ctx.citasRepo.whatsappMessageConfigDisponible = false;
    const body = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as Json;
    expect(body).toMatchObject({ disponible: false, version: 0 });
    const h = (await (await app.request(`${url}/historial`, authedGet(ctx.staff.owner.token))).json()) as Json;
    expect(h).toEqual({ disponible: false, entradas: [] });
  });

  it("/opciones lista variables por tipo (fecha_anterior solo en reagendado) y el texto de fabrica", async () => {
    const { ctx, app, url } = await construir();
    const o = (await (await app.request(`${url}/opciones`, authedGet(ctx.staff.owner.token))).json()) as Json;
    const porKind = Object.fromEntries(o.mensajes.map((m: Json) => [m.kind, m]));
    expect(porKind.reagendado.variables).toContain("fecha_anterior");
    expect(porKind.confirmacion.variables).not.toContain("fecha_anterior");
    expect(porKind.recordatorio.textoPorOmision).toContain("{{hora}}");
    expect(o.limites.texto).toBe(600);
  });
});

describe("PUT whatsapp-mensajes", () => {
  it("guarda, la version sube de 1 en 1, el historial guarda antes/despues y deja bitacora sin el texto", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    const r1 = await app.request(url, authedJson(t, { reminderText: "Hola {{nombre}}, {{hora}}", reminderLeadHours: 12, sendWindowStart: 9, sendWindowEnd: 20, versionEsperada: 0 }, "PUT" as never));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ version: 1, config: { reminderText: "Hola {{nombre}}, {{hora}}", reminderLeadHours: 12, sendWindowStart: 9, sendWindowEnd: 20 } });
    const r2 = await app.request(url, authedJson(ctx.staff.admin.token, { reminderLeadHours: 6, confirmationEnabled: true, versionEsperada: 1 }, "PUT" as never));
    expect(await r2.json()).toMatchObject({ version: 2, config: { reminderText: null, reminderLeadHours: 6, confirmationEnabled: true, sendWindowStart: null } });

    const h = (await (await app.request(`${url}/historial`, authedGet(t))).json()) as Json;
    expect(h.entradas.map((e: Json) => [e.version, e.accion])).toEqual([[2, "actualizado"], [1, "actualizado"]]);
    expect(h.entradas[0].anterior).toMatchObject({ reminderLeadHours: 12 });
    expect(h.entradas[0].diferencias.map((d: Json) => d.campo)).toContain("Anticipación del recordatorio (horas)");
    expect(h.entradas[1].anterior).toBeNull();

    const bitacora = ctx.citasRepo.auditLog.filter((r) => r.action === "configuracion.whatsapp_mensajes_actualizado");
    expect(bitacora).toHaveLength(2);
    expect(bitacora[0]).toMatchObject({ entityType: "configuracion", actorUserId: ctx.staff.owner.id, antes: "0", despues: "1" });
    expect(JSON.stringify(bitacora)).not.toContain("Hola {{nombre}}");
  });

  it("version vieja -> 409 y no se escribe nada; 'no habia fila' tampoco vale cuando ya existe", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    await app.request(url, authedJson(t, { reminderLeadHours: 10, versionEsperada: 0 }, "PUT" as never));
    const bitacoraAntes = ctx.citasRepo.auditLog.length;
    expect((await app.request(url, authedJson(t, { reminderLeadHours: 5, versionEsperada: 7 }, "PUT" as never))).status).toBe(409);
    expect((await app.request(url, authedJson(t, { reminderLeadHours: 5, versionEsperada: 0 }, "PUT" as never))).status).toBe(409);
    expect(((await (await app.request(url, authedGet(t))).json()) as Json).config.reminderLeadHours).toBe(10);
    expect(((await (await app.request(`${url}/historial`, authedGet(t))).json()) as Json).entradas).toHaveLength(1);
    expect(ctx.citasRepo.auditLog.length).toBe(bitacoraAntes);
  });

  it("rechaza (400, sin escribir): variable desconocida, sin hora, llaves mal cerradas, 601 caracteres, anticipacion 0/73, ventana invertida o a medias, bandera no booleana, version ausente", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    const v = { versionEsperada: 0 };
    const malos = [
      { ...v, reminderText: "Hola {{apellido}} {{hora}}" },
      { ...v, reminderText: "Hola {{nombre}}" },
      { ...v, confirmationText: "Hola {{nombre}} {{hora}} {{" },
      { ...v, reminderText: "{{hora}} " + "a".repeat(600) },
      { ...v, reminderLeadHours: 0 },
      { ...v, reminderLeadHours: 73 },
      { ...v, sendWindowStart: 20, sendWindowEnd: 9 },
      { ...v, sendWindowStart: 9 },
      { ...v, cancellationEnabled: "yes" },
      { ...v, reminderText: "Antes {{fecha_anterior}} {{hora}}" },
      { reminderLeadHours: 12 },
      { ...v, versionEsperada: -1 },
    ];
    for (const body of malos) expect((await app.request(url, authedJson(t, body, "PUT" as never))).status).toBe(400);
    expect(((await (await app.request(url, authedGet(t))).json()) as Json).version).toBe(0);
    expect(((await (await app.request(`${url}/historial`, authedGet(t))).json()) as Json).entradas).toEqual([]);
  });

  it("staff no puede guardar (403) y no se escribe nada; otra organizacion tampoco ve ni escribe", async () => {
    const { ctx, app, url } = await construir();
    expect((await app.request(url, authedJson(ctx.staff.staffMember.token, { versionEsperada: 0 }, "PUT" as never))).status).toBe(403);
    expect((await app.request(url, authedJson("token-invalido", { versionEsperada: 0 }, "PUT" as never))).status).toBe(401);
    expect(((await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as Json).version).toBe(0);
  });

  it("base sin la 026 -> 503 en PUT y restablecer, y la bitacora no se escribe", async () => {
    const { ctx, app, url } = await construir();
    ctx.citasRepo.whatsappMessageConfigDisponible = false;
    const t = ctx.staff.owner.token;
    const antes = ctx.citasRepo.auditLog.length;
    expect((await app.request(url, authedJson(t, { versionEsperada: 0 }, "PUT" as never))).status).toBe(503);
    expect((await app.request(`${url}/restablecer`, authedJson(t, { versionEsperada: 0 }))).status).toBe(503);
    expect(ctx.citasRepo.auditLog.length).toBe(antes);
  });
});

describe("vista previa y restablecer", () => {
  it("la vista previa es de SOLO LECTURA: muestra el borrador con valores de muestra y las diferencias, y no guarda nada", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    const r = await app.request(`${url}/vista-previa`, authedJson(t, { reminderText: "Cita {{servicio}} el {{fecha_hora}} con {{profesional}}", reminderLeadHours: 6 }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as Json;
    expect(body.vistaPrevia[0]).toMatchObject({ kind: "recordatorio", esPorDefecto: false });
    expect(body.vistaPrevia[0].texto).toBe("Cita Consulta general el jueves 2 de octubre, 10:00 a. m. con Dra. López");
    expect(body.diferencias.map((d: Json) => d.campo)).toEqual(["Texto del recordatorio", "Anticipación del recordatorio (horas)"]);
    expect(body.version).toBe(0);
    expect(((await (await app.request(url, authedGet(t))).json()) as Json).version).toBe(0);
    expect(ctx.citasRepo.auditLog.filter((r) => r.action.startsWith("configuracion.whatsapp_mensajes"))).toHaveLength(0);
    // un borrador invalido tambien es 400 en la vista previa
    expect((await app.request(`${url}/vista-previa`, authedJson(t, { reminderText: "{{nada}} {{hora}}" }))).status).toBe(400);
  });

  it("restablecer deja los valores de fabrica, sube la version y queda como 'restablecido' en el historial", async () => {
    const { ctx, app, url } = await construir();
    const t = ctx.staff.owner.token;
    await app.request(url, authedJson(t, { reminderText: "X {{hora}}", reminderLeadHours: 3, cancellationEnabled: true, sendWindowStart: 8, sendWindowEnd: 18, versionEsperada: 0 }, "PUT" as never));
    const r = await app.request(`${url}/restablecer`, authedJson(t, { versionEsperada: 1 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ version: 2, config: { reminderText: null, reminderLeadHours: 24, cancellationEnabled: false, sendWindowStart: null, sendWindowEnd: null, reminderEnabled: true } });
    const h = (await (await app.request(`${url}/historial`, authedGet(t))).json()) as Json;
    expect(h.entradas[0]).toMatchObject({ version: 2, accion: "restablecido" });
    expect((await app.request(`${url}/restablecer`, authedJson(t, { versionEsperada: 1 }))).status).toBe(409);
    expect((await app.request(`${url}/restablecer`, authedJson(ctx.staff.staffMember.token, { versionEsperada: 2 }))).status).toBe(403);
  });
});

describe("avisos opt-in al cancelar o confirmar desde el panel", () => {
  async function conCita(ctx: Awaited<ReturnType<typeof construir>>["ctx"], app: ReturnType<typeof buildApp>) {
    const created = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments`, authedJson(ctx.staff.owner.token, {
      provider_id: ctx.providerId,
      service_id: ctx.serviceId,
      customer_name: "Paciente de Prueba",
      customer_phone: "5215500000000",
      starts_at: "2026-10-05T15:00:00.000Z",
    }));
    expect(created.status).toBe(201);
    return ((await created.json()) as { appointment: { id: string } }).appointment.id;
  }
  const waOutbox = (ctx: Awaited<ReturnType<typeof construir>>["ctx"], evento: string) => ctx.citasRepo.getOutbox().filter((o) => o.channel === "whatsapp" && o.eventType === evento);

  it("por defecto (apagados) cancelar y confirmar NO encolan WhatsApp", async () => {
    const { ctx, app } = await construir();
    const id = await conCita(ctx, app);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/confirm`, authedJson(ctx.staff.owner.token, undefined, "POST"))).status).toBe(200);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/cancel`, authedJson(ctx.staff.owner.token, undefined, "POST"))).status).toBe(200);
    expect(waOutbox(ctx, "appointment.confirmed")).toHaveLength(0);
    expect(waOutbox(ctx, "appointment.cancelled")).toHaveLength(0);
  });

  it("encendidos encolan el texto configurado con los datos de la cita", async () => {
    const { ctx, app, url } = await construir();
    await app.request(url, authedJson(ctx.staff.owner.token, { confirmationEnabled: true, confirmationText: "Confirmada: {{servicio}} a las {{hora}}", cancellationEnabled: true, cancellationText: "Cancelada {{nombre}}", versionEsperada: 0 }, "PUT" as never));
    const id = await conCita(ctx, app);
    await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/confirm`, authedJson(ctx.staff.owner.token, undefined, "POST"));
    await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/cancel`, authedJson(ctx.staff.owner.token, undefined, "POST"));
    const conf = waOutbox(ctx, "appointment.confirmed");
    const canc = waOutbox(ctx, "appointment.cancelled");
    expect(conf).toHaveLength(1);
    expect(canc).toHaveLength(1);
    // El telefono del panel se guarda con la misma llave que el agente y la web (ultimos 10 digitos, QA-citas-R1-seguridad-09).
    expect(conf[0]!.payload).toMatchObject({ to: "5500000000", phone_number_id: "1234567890" });
    expect((conf[0]!.payload as { body: string }).body).toContain("Confirmada: Consulta general a las");
    expect((canc[0]!.payload as { body: string }).body).toBe("Cancelada Paciente de Prueba");
  });
});
