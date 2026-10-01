// H-02 -- privacidad de hoteles: aviso, consentimientos, ARCO, bloqueo previo a la purga, retencion legal,
// acceso excepcional e incidentes. Integracion HTTP real (app.request) sobre los repositorios en memoria
// (privacidad coordinada con la boveda). RLS/GRANT/funciones SQL las cubre scripts/verify-hoteles-privacidad-arco
// contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson, type HotelesTestContext } from "./hoteles-fixtures.ts";

const post = (token: string, body: unknown): RequestInit => authedJson(token, body);
const put = (token: string, body: unknown): RequestInit => ({ ...authedJson(token, body), method: "PUT" });
const get = (token: string): RequestInit => authedJson(token);

async function setup() {
  const ctx = await buildHotelesTestContext(buildApp);
  return { ctx, app: buildApp(ctx.deps) };
}
type App = ReturnType<typeof buildApp>;
const base = (ctx: HotelesTestContext) => `/hoteles/${ctx.propertyId}/privacidad`;

const NOTICE = {
  version: "v1",
  textoSimplificado: "Usamos tus datos para identificarte, cumplir el registro de huespedes y facturar.",
  finalidadesObligatorias: ["identificar al huesped", "facturacion"],
  finalidadesOpcionales: ["promociones"],
  urlIntegral: "https://hotel.example.com/aviso",
};

async function publish(app: App, ctx: HotelesTestContext, patch: Record<string, unknown> = {}) {
  const res = await app.request(`${base(ctx)}/avisos`, post(ctx.staff.owner.token, { ...NOTICE, ...patch }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { avisoId: string }).avisoId;
}
function consentBody(avisoId: string, patch: Record<string, unknown> = {}) {
  return { avisoId, finalidadesObligatorias: ["identificar al huesped", "facturacion"], finalidadesOpcionales: [], canal: "tableta", metodo: "casilla_electronica", ...patch };
}
function captureBody(ctx: HotelesTestContext, extra: Record<string, unknown> = {}) {
  return { guestId: ctx.guestId, reservationId: ctx.reservationId, documentType: "pasaporte", nationality: "USA", fullName: "Ana Torres", documentNumber: "G-1234 5678", ...extra };
}
async function capture(app: App, ctx: HotelesTestContext, extra: Record<string, unknown> = {}) {
  const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, extra)));
  expect(res.status).toBe(201);
  return (await res.json()) as { identidad: { id: string }; consentimiento: { estado: string; versionAviso?: string } | null };
}

describe("GET /privacidad/info", () => {
  it("front-of-house recibe el aviso de NO-asesoria-legal, la lista 'un abogado debe confirmar' y los plazos; housekeeping 403; sin token 401", async () => {
    const { ctx, app } = await setup();
    const res = await app.request(`${base(ctx)}/info`, get(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avisoLegal: string; unAbogadoDebeConfirmar: string[]; plazos: { arcoRespuestaDias: number; arcoEjecucionDias: number; ventanaBloqueoDias: { minimo: number; maximo: number; porDefecto: number } } };
    expect(body.avisoLegal).toMatch(/NO es asesoria legal/);
    expect(body.unAbogadoDebeConfirmar.length).toBeGreaterThanOrEqual(8);
    expect(body.plazos).toMatchObject({ arcoRespuestaDias: 20, arcoEjecucionDias: 15, ventanaBloqueoDias: { minimo: 3, maximo: 30, porDefecto: 7 } });
    expect((await app.request(`${base(ctx)}/info`, get(ctx.staff.housekeeping.token))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/info`, { method: "GET" })).status).toBe(401);
  });
});

describe("ventana de bloqueo (configuracion)", () => {
  it("default 7; owner/gm la fijan entre 3 y 30; fuera de rango 400; frontdesk 403; queda en la bitacora", async () => {
    const { ctx, app } = await setup();
    expect(await (await app.request(`${base(ctx)}/configuracion`, get(ctx.staff.owner.token))).json()).toMatchObject({ disponible: true, ventanaBloqueoDias: 7, esDefault: true });
    expect((await app.request(`${base(ctx)}/configuracion`, put(ctx.staff.gm.token, { dias: 14 }))).status).toBe(200);
    expect(await (await app.request(`${base(ctx)}/configuracion`, get(ctx.staff.owner.token))).json()).toMatchObject({ ventanaBloqueoDias: 14, esDefault: false, actualizadoPor: ctx.staff.gm.id });
    for (const dias of [2, 31, 7.5, "7"]) expect((await app.request(`${base(ctx)}/configuracion`, put(ctx.staff.owner.token, { dias }))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/configuracion`, put(ctx.staff.frontdesk.token, { dias: 10 }))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/configuracion`, get(ctx.staff.frontdesk.token))).status).toBe(403);
    const log = (await (await app.request(`${base(ctx)}/bitacora?tipo=configuracion`, get(ctx.staff.owner.token))).json()) as { items: { accion: string; nota: string }[] };
    expect(log.items[0]).toMatchObject({ accion: "ventana_bloqueo", nota: "de 7 a 14 dias" });
  });

  it("el bloqueo manual y el barrido usan la ventana configurada", async () => {
    const { ctx, app } = await setup();
    await app.request(`${base(ctx)}/configuracion`, put(ctx.staff.owner.token, { dias: 21 }));
    const { identidad } = await capture(app, ctx);
    const res = await app.request(`${base(ctx)}/identidades/${identidad.id}/bloquear`, post(ctx.staff.gm.token, { motivo: "Bloqueo preventivo por solicitud del titular" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identidad: { estado: "bloqueada", motivoBloqueo: "manual", ventanaBloqueoDias: 21 } });
  });
});

describe("aviso de privacidad versionado", () => {
  it("owner publica; frontdesk 403 al publicar pero lee; una sola vigente; version repetida 409; entradas invalidas 400", async () => {
    const { ctx, app } = await setup();
    const v1 = await publish(app, ctx);
    expect((await app.request(`${base(ctx)}/avisos`, post(ctx.staff.frontdesk.token, { ...NOTICE, version: "v9" }))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/avisos`, post(ctx.staff.owner.token, NOTICE))).status).toBe(409);
    const v2 = await publish(app, ctx, { version: "v2" });
    const list = (await (await app.request(`${base(ctx)}/avisos`, get(ctx.staff.frontdesk.token))).json()) as { items: { id: string; vigente: boolean }[] };
    expect(list.items.filter((n) => n.vigente).map((n) => n.id)).toEqual([v2]);
    expect(list.items.map((n) => n.id)).toContain(v1);
    for (const bad of [{ finalidadesObligatorias: [] }, { urlIntegral: "http://x.example.com/aviso" }, { textoSimplificado: "corto" }, { finalidadesOpcionales: ["facturacion"] }]) {
      expect((await app.request(`${base(ctx)}/avisos`, post(ctx.staff.owner.token, { ...NOTICE, version: "v3", ...bad }))).status).toBe(400);
    }
  });
});

describe("ledger de consentimientos ligado a la captura de identidad", () => {
  it("captura con consentimiento: queda ligado a la identidad con la version del aviso, canal y quien capturo; el ledger lo lista", async () => {
    const { ctx, app } = await setup();
    const avisoId = await publish(app, ctx);
    const out = await capture(app, ctx, { consentimiento: consentBody(avisoId, { finalidadesOpcionales: ["promociones"], metodo: "firma_electronica", datosSensibles: true }) });
    expect(out.consentimiento).toMatchObject({ estado: "registrado", versionAviso: "v1", canal: "tableta", metodo: "firma_electronica", datosSensibles: true, capturadoPor: ctx.staff.frontdesk.id, identidadId: out.identidad.id });
    const list = (await (await app.request(`${base(ctx)}/consentimientos?identidadId=${out.identidad.id}`, get(ctx.staff.reservations.token))).json()) as { items: { versionAviso: string; finalidadesOpcionales: string[] }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ versionAviso: "v1", finalidadesOpcionales: ["promociones"] });
    // Housekeeping no ve el ledger.
    expect((await app.request(`${base(ctx)}/consentimientos`, get(ctx.staff.housekeeping.token))).status).toBe(403);
  });

  it("captura SIN consentimiento sigue funcionando como antes (consentimiento: null)", async () => {
    const { ctx, app } = await setup();
    expect((await capture(app, ctx)).consentimiento).toBeNull();
  });

  it("consentimiento invalido se rechaza ANTES de capturar (nada queda guardado): finalidades obligatorias incompletas, opcional ajena, sensible sin firma, aviso inexistente", async () => {
    const { ctx, app } = await setup();
    const avisoId = await publish(app, ctx);
    const attempts: Record<string, unknown>[] = [
      consentBody(avisoId, { finalidadesObligatorias: ["identificar al huesped"] }),
      consentBody(avisoId, { finalidadesOpcionales: ["venta de datos"] }),
      consentBody(avisoId, { datosSensibles: true }),
      consentBody(randomUUID()),
    ];
    for (const consentimiento of attempts) {
      const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, { consentimiento })));
      expect(res.status).toBe(400);
    }
    expect((await ctx.identidadRepo.listIdentities(ctx.propertyId, { limit: 10 })).items).toHaveLength(0);
  });

  it("consentimiento suelto, revocacion una sola vez y huella en la bitacora", async () => {
    const { ctx, app } = await setup();
    const avisoId = await publish(app, ctx);
    const created = await app.request(`${base(ctx)}/consentimientos`, post(ctx.staff.frontdesk.token, { ...consentBody(avisoId), huespedId: ctx.guestId }));
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { consentimiento: { id: string } }).consentimiento.id;
    expect((await app.request(`${base(ctx)}/consentimientos/${id}/revocar`, post(ctx.staff.reservations.token, { motivo: "corto" }))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/consentimientos/${id}/revocar`, post(ctx.staff.reservations.token, { motivo: "El titular retira su consentimiento" }))).status).toBe(200);
    expect((await app.request(`${base(ctx)}/consentimientos/${id}/revocar`, post(ctx.staff.reservations.token, { motivo: "Segunda revocacion de prueba" }))).status).toBe(409);
    const log = (await (await app.request(`${base(ctx)}/bitacora?tipo=consentimiento`, get(ctx.staff.gm.token))).json()) as { items: { accion: string }[] };
    expect(log.items.map((e) => e.accion)).toContain("consentimiento_revocado");
  });
});

describe("solicitudes ARCO", () => {
  async function abrir(app: App, ctx: HotelesTestContext, patch: Record<string, unknown> = {}) {
    const res = await app.request(`${base(ctx)}/arco`, post(ctx.staff.owner.token, { derecho: "rectificacion", solicitante: "Juan Perez", canal: "correo", huespedId: ctx.guestId, ...patch }));
    expect(res.status).toBe(201);
    return (await res.json()) as { solicitudId: string; solicitud: { folio: string; estado: string; recibidaEn: string; respuestaLimite: string; plazo: { fase: string; diasRestantes: number; estado: string }; prorrogaDisponible: { disponible: boolean; dias: number } } };
  }

  it("owner abre: folio, respuesta = recepcion + 20 dias, plazo en curso y prorroga disponible; frontdesk 403 en lectura y escritura", async () => {
    const { ctx, app } = await setup();
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const recibida = daysAgo(30);
    const { solicitud } = await abrir(app, ctx, { recibidaEn: recibida });
    expect(solicitud).toMatchObject({ estado: "recibida", recibidaEn: recibida, respuestaLimite: addDays(recibida, 20), plazo: { fase: "respuesta" }, prorrogaDisponible: { disponible: true, dias: 20 } });
    expect(solicitud.folio).toBe(`ARCO-${recibida.replace(/-/g, "")}-${solicitud.folio.slice(-6)}`);
    expect((await app.request(`${base(ctx)}/arco`, get(ctx.staff.frontdesk.token))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/arco`, post(ctx.staff.frontdesk.token, { derecho: "acceso", solicitante: "Juan Perez", canal: "correo" }))).status).toBe(403);
    const list = (await (await app.request(`${base(ctx)}/arco`, get(ctx.staff.gm.token))).json()) as { items: { plazo: { estado: string; diasRestantes: number } }[] };
    // 30 dias desde la recepcion = ~10 de retraso sobre el plazo de 20 (la fecha de negocio puede ir 1 dia detras de UTC).
    expect(list.items[0]!.plazo.estado).toBe("vencida");
    expect(list.items[0]!.plazo.diasRestantes).toBeGreaterThanOrEqual(-11);
    expect(list.items[0]!.plazo.diasRestantes).toBeLessThanOrEqual(-9);
    const fresh = await abrir(app, ctx);
    expect(fresh.solicitud.plazo).toMatchObject({ estado: "en_plazo", diasRestantes: 20 });
  });

  it("flujo recibida -> procedente (ejecucion en 15 dias) -> ejecutada; transicion invalida 409; nota corta 400; solicitud inexistente 404", async () => {
    const { ctx, app } = await setup();
    const { solicitudId } = await abrir(app, ctx);
    const url = `${base(ctx)}/arco/${solicitudId}/avanzar`;
    expect((await app.request(url, post(ctx.staff.gm.token, { estado: "ejecutada", nota: "Intento de saltar la procedencia" }))).status).toBe(409);
    expect((await app.request(url, post(ctx.staff.gm.token, { estado: "procedente", nota: "corto" }))).status).toBe(400);
    const ok = await app.request(url, post(ctx.staff.gm.token, { estado: "procedente", nota: "Procede la rectificacion solicitada" }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { resultado: string; solicitud: { estado: string; ejecucionLimite: string; plazo: { fase: string } } };
    expect(body).toMatchObject({ resultado: "procedente", solicitud: { estado: "procedente", plazo: { fase: "ejecucion" } } });
    expect(body.solicitud.ejecucionLimite).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await app.request(url, post(ctx.staff.gm.token, { estado: "ejecutada", nota: "Se corrigieron los datos del titular" }))).status).toBe(200);
    expect((await app.request(`${base(ctx)}/arco/${randomUUID()}/avanzar`, post(ctx.staff.gm.token, { estado: "procedente", nota: "Solicitud que no existe en la base" }))).status).toBe(404);
  });

  it("prorroga unica con motivo: la segunda es 409; motivo corto 400; frontdesk 403", async () => {
    const { ctx, app } = await setup();
    const { solicitudId } = await abrir(app, ctx);
    const url = `${base(ctx)}/arco/${solicitudId}/prorroga`;
    expect((await app.request(url, post(ctx.staff.owner.token, { motivo: "corto" }))).status).toBe(400);
    expect((await app.request(url, post(ctx.staff.frontdesk.token, { motivo: "Frontdesk no puede prorrogar solicitudes" }))).status).toBe(403);
    const ok = await app.request(url, post(ctx.staff.owner.token, { motivo: "Se requiere recabar informacion de varias areas" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ solicitud: { prorroga: { fase: "respuesta" }, prorrogaDisponible: { disponible: false } } });
    expect((await app.request(url, post(ctx.staff.owner.token, { motivo: "Segunda prorroga que no esta permitida" }))).status).toBe(409);
  });

  it("una CANCELACION procedente BLOQUEA la identidad ligada (sin purgar de golpe)", async () => {
    const { ctx, app } = await setup();
    const { identidad } = await capture(app, ctx);
    const { solicitudId } = await abrir(app, ctx, { derecho: "cancelacion", identidadId: identidad.id });
    const res = await app.request(`${base(ctx)}/arco/${solicitudId}/avanzar`, post(ctx.staff.gm.token, { estado: "procedente", nota: "Procede la cancelacion de los datos del titular" }));
    expect(res.status).toBe(200);
    expect(await ctx.identidadRepo.findIdentity(ctx.propertyId, identidad.id)).toMatchObject({ status: "bloqueada", blockReason: "arco" });
    expect(ctx.identidadRepo.storedEnvelope(identidad.id)).not.toBeNull();
  });

  it("validacion de la solicitud: derecho/canal invalidos, fecha futura o de mas de 365 dias, huesped no UUID -> 400", async () => {
    const { ctx, app } = await setup();
    for (const bad of [{ derecho: "borrado" }, { canal: "paloma" }, { recibidaEn: "2999-01-01" }, { recibidaEn: "2000-01-01" }, { huespedId: "x" }, { solicitante: "x" }]) {
      expect((await app.request(`${base(ctx)}/arco`, post(ctx.staff.owner.token, { derecho: "acceso", solicitante: "Juan Perez", canal: "correo", ...bad }))).status).toBe(400);
    }
  });
});

describe("incidentes / vulneraciones", () => {
  const incidente = { tipo: "divulgacion", severidad: "alta", titulo: "Correo enviado al huesped equivocado", descripcion: "Se envio por error una confirmacion con datos personales.", riesgoSignificativo: true, afectados: 1 };

  it("front-of-house REPORTA pero no lee; owner/gm leen con el recordatorio del art. 19 (solo informativo)", async () => {
    const { ctx, app } = await setup();
    const res = await app.request(`${base(ctx)}/incidentes`, post(ctx.staff.frontdesk.token, incidente));
    expect(res.status).toBe(201);
    expect((await app.request(`${base(ctx)}/incidentes`, get(ctx.staff.frontdesk.token))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/incidentes`, post(ctx.staff.housekeeping.token, incidente))).status).toBe(403);
    const list = (await (await app.request(`${base(ctx)}/incidentes`, get(ctx.staff.owner.token))).json()) as { items: { folio: string; estado: string; recordatorio: { requerido: boolean; vencido: boolean; mensaje: string } }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ estado: "detectada", recordatorio: { requerido: true, vencido: true } });
    expect(list.items[0]!.folio).toMatch(/^INC-/);
    expect(list.items[0]!.recordatorio.mensaje).toMatch(/NO envia/);
  });

  it("contener -> registrar notificacion (el recordatorio desaparece) -> cerrar; repetir 409; accion invalida 400; incidente inexistente 404", async () => {
    const { ctx, app } = await setup();
    const { incidenteId } = (await (await app.request(`${base(ctx)}/incidentes`, post(ctx.staff.frontdesk.token, incidente))).json()) as { incidenteId: string };
    const url = `${base(ctx)}/incidentes/${incidenteId}/accion`;
    expect((await app.request(url, post(ctx.staff.owner.token, { accion: "contener", nota: "Se recupero el correo y se cambiaron credenciales" }))).status).toBe(200);
    expect((await app.request(url, post(ctx.staff.owner.token, { accion: "contener" }))).status).toBe(409);
    // Cerrar sin notificar con riesgo significativo exige el motivo de no notificar.
    expect((await app.request(url, post(ctx.staff.owner.token, { accion: "cerrar", nota: "Se cierra el incidente tras la revision" }))).status).toBe(409);
    const notif = await app.request(url, post(ctx.staff.owner.token, { accion: "registrar_notificacion", canal: "correo electronico", constancia: "Constancia de envio 0007" }));
    expect(notif.status).toBe(200);
    expect(await notif.json()).toMatchObject({ incidente: { notificacion: { canal: "correo electronico", constancia: "Constancia de envio 0007" }, recordatorio: { requerido: false, mensaje: null } } });
    const closed = await app.request(url, post(ctx.staff.owner.token, { accion: "cerrar", nota: "Se cierra con el titular notificado" }));
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ incidente: { estado: "cerrada" } });
    expect((await app.request(url, post(ctx.staff.owner.token, { accion: "contener" }))).status).toBe(409);
    expect((await app.request(url, post(ctx.staff.owner.token, { accion: "borrar" }))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/incidentes/${randomUUID()}/accion`, post(ctx.staff.owner.token, { accion: "contener" }))).status).toBe(404);
    expect((await app.request(url, post(ctx.staff.frontdesk.token, { accion: "contener" }))).status).toBe(403);
  });

  it("validacion: deteccion futura, tipo/severidad fuera de catalogo, descripcion corta -> 400", async () => {
    const { ctx, app } = await setup();
    for (const bad of [{ detectadoEn: "2999-01-01T00:00:00Z" }, { tipo: "virus" }, { severidad: "critica" }, { descripcion: "corta" }, { riesgoSignificativo: "si" }]) {
      expect((await app.request(`${base(ctx)}/incidentes`, post(ctx.staff.frontdesk.token, { ...incidente, ...bad }))).status).toBe(400);
    }
  });
});

describe("retencion legal (legal hold) por incidente", () => {
  it("aplicar con folio + motivo + autorizacion; impide la purga mientras dure; liberar (nota obligatoria) la permite", async () => {
    const { ctx, app } = await setup();
    const { identidad } = await capture(app, ctx);
    await ctx.identidadRepo.sweepRetention(ctx.propertyId, "2099-01-01"); // bloquea (retencion vencida)
    const placed = await app.request(`${base(ctx)}/identidades/${identidad.id}/retencion`, post(ctx.staff.owner.token, { folio: "FGR-2026-0042", motivo: "Carpeta de investigacion abierta por el incidente", autorizacion: "Oficio FGR/2026/0042, direccion juridica" }));
    expect(placed.status).toBe(201);
    const retencionId = ((await placed.json()) as { retencionId: string }).retencionId;
    expect((await ctx.identidadRepo.sweepRetention(ctx.propertyId, "2100-01-01")).purged).toBe(0);
    const list = (await (await app.request(`${base(ctx)}/retenciones?estado=activa`, get(ctx.staff.gm.token))).json()) as { items: { folio: string; revision: string }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ folio: "FGR-2026-0042", revision: "vigente" });
    expect((await app.request(`${base(ctx)}/retenciones/${retencionId}/liberar`, post(ctx.staff.owner.token, { nota: "corto" }))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/retenciones/${retencionId}/liberar`, post(ctx.staff.owner.token, { nota: "Caso cerrado por la autoridad; se libera" }))).status).toBe(200);
    expect((await app.request(`${base(ctx)}/retenciones/${retencionId}/liberar`, post(ctx.staff.owner.token, { nota: "Segunda liberacion de la misma retencion" }))).status).toBe(409);
    expect((await ctx.identidadRepo.sweepRetention(ctx.propertyId, "2100-01-01")).purged).toBe(1);
  });

  it("validaciones y roles: folio/motivo/autorizacion obligatorios (400), frontdesk 403, identidad inexistente 404", async () => {
    const { ctx, app } = await setup();
    const { identidad } = await capture(app, ctx);
    const url = `${base(ctx)}/identidades/${identidad.id}/retencion`;
    const ok = { folio: "CASO-1", motivo: "Motivo suficiente para la retencion", autorizacion: "Direccion juridica" };
    for (const missing of ["folio", "motivo", "autorizacion"]) {
      const body: Record<string, unknown> = { ...ok };
      delete body[missing];
      expect((await app.request(url, post(ctx.staff.owner.token, body))).status).toBe(400);
    }
    expect((await app.request(url, post(ctx.staff.frontdesk.token, ok))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/identidades/${randomUUID()}/retencion`, post(ctx.staff.owner.token, ok))).status).toBe(404);
  });
});

describe("acceso excepcional a una identidad bloqueada (doble control)", () => {
  async function bloqueada(app: App, ctx: HotelesTestContext) {
    const { identidad } = await capture(app, ctx);
    const res = await app.request(`${base(ctx)}/identidades/${identidad.id}/bloquear`, post(ctx.staff.owner.token, { motivo: "Bloqueo preventivo por solicitud del titular" }));
    expect(res.status).toBe(200);
    return identidad.id;
  }

  it("bloqueada: revelar normal y verificar = 409; owner pide, el mismo owner NO decide (403), otro admin aprueba y solo quien pidio revela, una sola vez, con no-store", async () => {
    const { ctx, app } = await setup();
    const id = await bloqueada(app, ctx);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/revelar`, post(ctx.staff.frontdesk.token, { motivo: "Intento de revelar una identidad bloqueada" }))).status).toBe(409);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/verificar`, post(ctx.staff.frontdesk.token, {}))).status).toBe(409);

    const req = await app.request(`${base(ctx)}/identidades/${id}/acceso-excepcional`, post(ctx.staff.owner.token, { motivo: "Requerimiento de autoridad con oficio 123" }));
    expect(req.status).toBe(201);
    const solicitudId = ((await req.json()) as { solicitudId: string }).solicitudId;
    const self = await app.request(`${base(ctx)}/accesos-excepcionales/${solicitudId}/decidir`, post(ctx.staff.owner.token, { aprobar: true }));
    expect(self.status).toBe(403);
    expect(((await self.json()) as { message: string }).message).toMatch(/Doble control/);
    // Sin aprobar no hay acceso.
    expect((await app.request(`${base(ctx)}/accesos-excepcionales/${solicitudId}/revelar`, post(ctx.staff.owner.token, {}))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/accesos-excepcionales/${solicitudId}/decidir`, post(ctx.staff.gm.token, { aprobar: true, nota: "Aprobado con el oficio a la vista" }))).status).toBe(200);
    // Otra persona (el gm que aprobo) no puede consumirlo.
    expect((await app.request(`${base(ctx)}/accesos-excepcionales/${solicitudId}/revelar`, post(ctx.staff.gm.token, {}))).status).toBe(403);
    const reveal = await app.request(`${base(ctx)}/accesos-excepcionales/${solicitudId}/revelar`, post(ctx.staff.owner.token, {}));
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get("cache-control")).toBe("no-store");
    expect(await reveal.json()).toMatchObject({ documento: { nombreCompleto: "Ana Torres", numeroDocumento: "G-1234 5678" } });
    expect((await app.request(`${base(ctx)}/accesos-excepcionales/${solicitudId}/revelar`, post(ctx.staff.owner.token, {}))).status).toBe(403);
    const log = (await (await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/accesos`, get(ctx.staff.owner.token))).json()) as { items: { accion: string }[] };
    expect(log.items.map((l) => l.accion)).toEqual(expect.arrayContaining(["bloqueo", "acceso_excepcional_revelacion"]));
  });

  it("frontdesk no pide ni lista accesos excepcionales (403); identidad activa o inexistente no aplica (409/404)", async () => {
    const { ctx, app } = await setup();
    const { identidad } = await capture(app, ctx);
    expect((await app.request(`${base(ctx)}/identidades/${identidad.id}/acceso-excepcional`, post(ctx.staff.owner.token, { motivo: "La identidad aun esta activa y no aplica" }))).status).toBe(409);
    expect((await app.request(`${base(ctx)}/identidades/${randomUUID()}/acceso-excepcional`, post(ctx.staff.owner.token, { motivo: "Identidad que no existe en la base" }))).status).toBe(404);
    expect((await app.request(`${base(ctx)}/identidades/${identidad.id}/acceso-excepcional`, post(ctx.staff.frontdesk.token, { motivo: "Frontdesk no puede pedir acceso excepcional" }))).status).toBe(403);
    expect((await app.request(`${base(ctx)}/accesos-excepcionales`, get(ctx.staff.frontdesk.token))).status).toBe(403);
  });
});

describe("BASE SIN MIGRAR (032 pendiente): nada se rompe", () => {
  it("las lecturas responden 200 con disponible:false y las escrituras 503; la captura con consentimiento sigue valiendo sin ledger", async () => {
    const { ctx, app } = await setup();
    ctx.privacidadRepo.unavailable = true;
    for (const path of ["avisos", "consentimientos", "arco", "incidentes", "retenciones", "accesos-excepcionales", "bitacora"]) {
      const res = await app.request(`${base(ctx)}/${path}`, get(ctx.staff.owner.token));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ disponible: false, items: [] });
    }
    expect(await (await app.request(`${base(ctx)}/configuracion`, get(ctx.staff.owner.token))).json()).toMatchObject({ disponible: false, ventanaBloqueoDias: 7, esDefault: true });
    expect((await app.request(`${base(ctx)}/avisos`, post(ctx.staff.owner.token, NOTICE))).status).toBe(503);
    expect((await app.request(`${base(ctx)}/arco`, post(ctx.staff.owner.token, { derecho: "acceso", solicitante: "Juan Perez", canal: "correo" }))).status).toBe(503);
    expect((await app.request(`${base(ctx)}/incidentes`, post(ctx.staff.frontdesk.token, { tipo: "otro", severidad: "baja", titulo: "Incidente", descripcion: "Descripcion suficiente del incidente." }))).status).toBe(503);
    const out = await capture(app, ctx, { consentimiento: consentBody(randomUUID()) });
    expect(out.consentimiento).toEqual({ estado: "no_disponible" });
  });
});
