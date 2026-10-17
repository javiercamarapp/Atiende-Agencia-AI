// paridad3 D-31 + D-P3-21 -- automatizacion por cliente (correo de contacto, dia y plantilla de la solicitud mensual, opt-in de la entrega de reportes
// al cerrar) y solicitudes de documentos por cliente y periodo (migracion 027).
//
//  GET  /despachos/:propertyId/automatizacion                                              configuracion del cliente (envio de reportes APAGADO por omision)
//  PUT  /despachos/:propertyId/automatizacion                                              guarda contacto, dia, plantilla y opt-in
//  GET  /despachos/:propertyId/solicitudes-documentos                                      solicitudes recientes con sus renglones
//  POST /despachos/:propertyId/solicitudes-documentos                                      { periodo: "AAAA-MM" } pide los documentos ahora (idempotente; avisa al cliente si tiene correo)
//  POST /despachos/:propertyId/solicitudes-documentos/renglones/:renglonId/no-aplica       { motivo } (3 a 300 caracteres)
//  POST /despachos/:propertyId/solicitudes-documentos/renglones/:renglonId/reabrir
//  POST /despachos/:propertyId/solicitudes-documentos/renglones/:renglonId/vincular        { documentoId } liga un documento del portal de ESTE cliente
//
// Autorizacion: ver = VER_CARTERA_ROLES; escribir = GESTIONAR_CARTERA_ROLES (admin/contador); la base repite todo (funciones definer con guard).
// Bitacora: cada escritura deja fila SIN el correo del cliente ni texto libre (solo ids, banderas y conteos). Compatible con la base sin migrar:
// las lecturas responden `disponible: false` y las escrituras 503; nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { GESTIONAR_CARTERA_ROLES, PostgresCarteraRepository, PostgresPortalClienteRepository, VER_CARTERA_ROLES, correoSolicitudDocumentos, generarTokenPortal, hashTokenPortal } from "@atiende/domain-despachos";
import type { AutomatizacionCliente, PlantillaSolicitud, PortalClienteRepository } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { pasoSeguro, pilotoDe, traducirPiloto } from "./piloto-comun.ts";

const MAX_BODY_BYTES = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODO_RE = /^(20[1-9][0-9])-(0[1-9]|1[0-2])$/;
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function booleano(v: unknown, campo: string, porOmision?: boolean): boolean {
  if (v === undefined && porOmision !== undefined) return porOmision;
  if (typeof v !== "boolean") throw Errors.validation(`${campo}: se esperaba verdadero o falso.`);
  return v;
}

function leerPlantilla(raw: unknown): PlantillaSolicitud {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("plantilla: se esperaba un objeto.");
  const o = raw as Record<string, unknown>;
  const permitidas = ["xmlEmitidos", "xmlRecibidos", "nomina", "otros", "estadosCuenta"];
  for (const k of Object.keys(o)) if (!permitidas.includes(k)) throw Errors.validation(`plantilla: la clave "${k}" no existe.`);
  const out: { xmlEmitidos?: boolean; xmlRecibidos?: boolean; nomina?: boolean; otros?: boolean; estadosCuenta?: string[] } = {};
  for (const k of ["xmlEmitidos", "xmlRecibidos", "nomina", "otros"] as const) if (o[k] !== undefined) out[k] = booleano(o[k], `plantilla.${k}`);
  if (o.estadosCuenta !== undefined) {
    if (!Array.isArray(o.estadosCuenta) || o.estadosCuenta.length > 10 || o.estadosCuenta.some((x) => typeof x !== "string" || x.trim().length < 1 || x.trim().length > 40)) {
      throw Errors.validation("plantilla.estadosCuenta: hasta 10 cuentas de 1 a 40 caracteres.");
    }
    out.estadosCuenta = (o.estadosCuenta as string[]).map((x) => x.trim());
  }
  return out;
}

export function despachosPilotoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const portalDe = (db: TenantDbSession): PortalClienteRepository => (deps.portalClienteRepo ? deps.portalClienteRepo(db) : new PostgresPortalClienteRepository(db));

  for (const ruta of ["/despachos/:propertyId/automatizacion", "/despachos/:propertyId/solicitudes-documentos", "/despachos/:propertyId/solicitudes-documentos/*"]) {
    app.use(ruta, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  async function auditar(c: Context<CoreAuthHonoEnv>, action: string, metadata: Record<string, string | number | boolean | null>): Promise<void> {
    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: c.get("userId"),
      actorEmail: c.get("userEmail") ?? null,
      organizationId: c.get("organizationId"),
      action,
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata,
    });
  }

  // ------------------------------------------------------------------ automatizacion
  app.get("/despachos/:propertyId/automatizacion", async (c) => {
    assertVerticalRole(c, VER_CARTERA_ROLES);
    const r = await pilotoDe(deps, c.get("db")).obtenerAutomatizacion(c.req.param("propertyId")).catch((err: unknown) => traducirPiloto(err));
    return c.json(r.disponible ? { disponible: true, automatizacion: r.valor } : { disponible: false, automatizacion: null });
  });

  app.put("/despachos/:propertyId/automatizacion", async (c) => {
    assertVerticalRole(c, GESTIONAR_CARTERA_ROLES);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const propertyId = c.req.param("propertyId");
    let contacto: string | null = null;
    if (raw.contactoCorreo !== undefined && raw.contactoCorreo !== null && raw.contactoCorreo !== "") {
      if (typeof raw.contactoCorreo !== "string") throw Errors.validation("contactoCorreo: se esperaba un correo.");
      contacto = raw.contactoCorreo.trim().toLowerCase();
      if (contacto.length > 254 || !CORREO_RE.test(contacto)) throw Errors.validation("contactoCorreo: correo inválido.");
    }
    const envio = booleano(raw.envioReportesCierre, "envioReportesCierre", false);
    if (envio && contacto === null) throw Errors.validation("envioReportesCierre: para enviar reportes al cerrar captura primero el correo de contacto del cliente.");
    const dia = raw.solicitudDia === undefined ? 1 : raw.solicitudDia;
    if (typeof dia !== "number" || !Number.isInteger(dia) || dia < 1 || dia > 28) throw Errors.validation("solicitudDia: un entero del 1 al 28.");
    const nueva: AutomatizacionCliente = { contactoCorreo: contacto, envioReportesCierre: envio, solicitudActiva: booleano(raw.solicitudActiva, "solicitudActiva", true), solicitudDia: dia, plantilla: leerPlantilla(raw.plantilla) };
    try {
      await pilotoDe(deps, c.get("db")).guardarAutomatizacion(propertyId, nueva);
    } catch (err) {
      return traducirPiloto(err);
    }
    await auditar(c, "despachos.automatizacion:guardar", { propertyId, envioReportesCierre: nueva.envioReportesCierre, solicitudActiva: nueva.solicitudActiva, solicitudDia: nueva.solicitudDia, tieneContacto: contacto !== null });
    return c.json({ disponible: true, automatizacion: nueva });
  });

  // ------------------------------------------------------------------ solicitudes de documentos
  app.get("/despachos/:propertyId/solicitudes-documentos", async (c) => {
    assertVerticalRole(c, VER_CARTERA_ROLES);
    const r = await pilotoDe(deps, c.get("db")).listarSolicitudes(c.req.param("propertyId")).catch((err: unknown) => traducirPiloto(err));
    return c.json({ disponible: r.disponible, solicitudes: r.disponible ? r.valor : [] });
  });

  app.post("/despachos/:propertyId/solicitudes-documentos", async (c) => {
    assertVerticalRole(c, GESTIONAR_CARTERA_ROLES);
    const raw = await readJsonCapped<{ readonly periodo?: unknown }>(c.req.raw, MAX_BODY_BYTES);
    const m = typeof raw.periodo === "string" ? PERIODO_RE.exec(raw.periodo) : null;
    if (!m) throw Errors.validation("periodo: se esperaba el formato AAAA-MM.");
    const [ejercicio, mes] = [Number(m[1]), Number(m[2])];
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    const piloto = pilotoDe(deps, db);
    let reg: { readonly id: string; readonly creada: boolean };
    try {
      reg = await piloto.crearSolicitud(propertyId, ejercicio, mes);
    } catch (err) {
      return traducirPiloto(err);
    }
    let correo: "enviado" | "sin_contacto" | "no_enviado" | "ya_existia" = "ya_existia";
    if (reg.creada) {
      correo = "sin_contacto";
      const auto = await piloto.obtenerAutomatizacion(propertyId);
      const solicitudes = await piloto.listarSolicitudes(propertyId);
      const solicitud = solicitudes.disponible ? solicitudes.valor.find((s) => s.id === reg.id) : undefined;
      if (auto.disponible && auto.valor.contactoCorreo && solicitud) {
        const contacto = auto.valor.contactoCorreo;
        const r = await pasoSeguro(db, "solicitud_correo", async () => {
          const token = generarTokenPortal();
          // Si no se puede crear el enlace (tope de enlaces vigentes) el aviso sale sin enlace: el cliente puede responder por el canal de siempre.
          const enlace = await pasoSeguro(db, "solicitud_enlace", () => portalDe(db).crearEnlace(propertyId, hashTokenPortal(token), `Solicitud ${ejercicio}-${String(mes).padStart(2, "0")}`, 35));
          const ficha = await (deps.carteraRepo ? deps.carteraRepo(db) : new PostgresCarteraRepository(db)).obtenerFicha(propertyId);
          const nombre = ficha?.razonSocial ?? "tu empresa";
          const msg = correoSolicitudDocumentos({ clienteNombre: nombre, ejercicio, mes, renglones: solicitud.renglones.map((x) => x.etiqueta), enlace: enlace.ok ? `${deps.env.appBaseUrl}/portal/cliente#t=${token}` : null });
          await deps.despachosRepo(db).enqueueMessagingOutbox(c.get("organizationId"), "email", "despachos.solicitud.documentos", `solicitud:${reg.id}:inicial`, { to: contacto, subject: msg.asunto, html: msg.html, text: msg.texto });
        });
        correo = r.ok ? "enviado" : "no_enviado";
      }
    }
    await auditar(c, "despachos.solicitudes-documentos:crear", { propertyId, solicitudId: reg.id, ejercicio, mes, creada: reg.creada, correo });
    return c.json({ id: reg.id, creada: reg.creada, correo }, reg.creada ? 201 : 200);
  });

  function renglonId(c: Context<CoreAuthHonoEnv>): string {
    const id = c.req.param("renglonId") ?? "";
    if (!UUID_RE.test(id)) throw Errors.validation("renglonId: se esperaba un UUID.");
    return id;
  }

  app.post("/despachos/:propertyId/solicitudes-documentos/renglones/:renglonId/no-aplica", async (c) => {
    assertVerticalRole(c, GESTIONAR_CARTERA_ROLES);
    const raw = await readJsonCapped<{ readonly motivo?: unknown }>(c.req.raw, MAX_BODY_BYTES);
    const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
    if (motivo.length < 3 || motivo.length > 300) throw Errors.validation("motivo: explica en 3 a 300 caracteres por qué no aplica.");
    const id = renglonId(c);
    const propertyId = c.req.param("propertyId");
    const ok = await pilotoDe(deps, c.get("db")).marcarRenglonNoAplica(propertyId, id, motivo).catch((err: unknown) => traducirPiloto(err));
    if (!ok) throw Errors.conflict("Ese documento ya se recibió o no se puede marcar como «no aplica».");
    // El motivo es texto libre del staff: vive en la fila del renglon (con RLS), NO en la bitacora.
    await auditar(c, "despachos.solicitudes-documentos:no-aplica", { propertyId, renglonId: id, longitudMotivo: motivo.length });
    return c.json({ ok: true });
  });

  app.post("/despachos/:propertyId/solicitudes-documentos/renglones/:renglonId/reabrir", async (c) => {
    assertVerticalRole(c, GESTIONAR_CARTERA_ROLES);
    await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const id = renglonId(c);
    const propertyId = c.req.param("propertyId");
    const ok = await pilotoDe(deps, c.get("db")).reabrirRenglon(propertyId, id).catch((err: unknown) => traducirPiloto(err));
    if (!ok) throw Errors.conflict("Solo se puede reabrir un documento marcado como «no aplica».");
    await auditar(c, "despachos.solicitudes-documentos:reabrir", { propertyId, renglonId: id });
    return c.json({ ok: true });
  });

  app.post("/despachos/:propertyId/solicitudes-documentos/renglones/:renglonId/vincular", async (c) => {
    assertVerticalRole(c, GESTIONAR_CARTERA_ROLES);
    const raw = await readJsonCapped<{ readonly documentoId?: unknown }>(c.req.raw, MAX_BODY_BYTES);
    if (typeof raw.documentoId !== "string" || !UUID_RE.test(raw.documentoId)) throw Errors.validation("documentoId: se esperaba un UUID.");
    const id = renglonId(c);
    const propertyId = c.req.param("propertyId");
    const estado = await pilotoDe(deps, c.get("db")).vincularDocumentoStaff(propertyId, id, raw.documentoId).catch((err: unknown) => traducirPiloto(err));
    await auditar(c, "despachos.solicitudes-documentos:vincular", { propertyId, renglonId: id, documentoId: raw.documentoId, estado });
    return c.json({ estado });
  });

  return app;
}
