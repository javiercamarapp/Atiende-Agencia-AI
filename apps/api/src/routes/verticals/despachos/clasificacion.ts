// D-P3-13 -- clasificacion contable del CFDI (migracion 026), sin LLM:
//
//  GET    /despachos/:propertyId/clasificacion/catalogo                  categorias contables con su nombre, piso y umbral por omision
//  PUT    /despachos/:propertyId/cfdi/:invoiceId/categoria               corrige la categoria de UN CFDI: fila NUEVA (nunca update silencioso), bitacora; opcional: regla por RFC emisor
//  GET    /despachos/:propertyId/clasificacion/correcciones              correcciones del despacho por RFC emisor (y ClaveProdServ opcional)
//  PUT    /despachos/:propertyId/clasificacion/correcciones              alta/edicion (upsert por RFC + ClaveProdServ)
//  DELETE /despachos/:propertyId/clasificacion/correcciones/:id          baja
//  GET    /despachos/:propertyId/clasificacion/ajustes             umbral de confianza y autoaceptado del portal del cliente
//  PUT    /despachos/:propertyId/clasificacion/ajustes             solo admin; el umbral nunca baja del piso de confianza (0.5)
//
// Autorizacion: leer = VER_CFDI_ROLES; escribir = BOOKKEEPING_ROLES (admin/contador); configuracion = admin. La base repite todo (funciones definer / RLS).
// Contra la base sin la 026: lecturas con `estado: "no_disponible"` y vacio honesto, escrituras 503. Cada escritura deja bitacora (despachos.audit_log), sin PII.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ADMIN_ROLES,
  BOOKKEEPING_ROLES,
  CATEGORIAS_CONTABLES,
  CONFIDENCE_FLOOR,
  ClasificacionDatosInvalidosError,
  ClasificacionNoDisponibleError,
  ClasificacionNoEncontradaError,
  ClasificacionSinPermisoError,
  ClasificacionTopeExcedidoError,
  DEFAULT_CONFIDENCE_THRESHOLD,
  NOMBRE_CATEGORIA,
  VER_CFDI_ROLES,
  validarUmbralConfianza,
} from "@atiende/domain-despachos";
import type { ClasificacionRecord, CorreccionRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { clasificacionDe } from "./clasificacion-deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const MAX_BODY = 8 * 1024;

/** Errores de dominio de la clasificacion -> HTTP (el mensaje de la base ya viene sin detalles internos). */
function traducir(err: unknown): never {
  if (err instanceof ClasificacionNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof ClasificacionSinPermisoError) throw Errors.forbidden(err.message);
  if (err instanceof ClasificacionNoEncontradaError) throw Errors.notFound(err.message);
  if (err instanceof ClasificacionTopeExcedidoError) throw Errors.conflict(err.message);
  if (err instanceof ClasificacionDatosInvalidosError) throw Errors.validation(err.message);
  throw err;
}

function categoriaFina(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || !CATEGORIAS_CONTABLES.includes(valor)) throw Errors.validation(`${campo}: se esperaba una de ${CATEGORIAS_CONTABLES.join(", ")}.`);
  return valor;
}

function cuentaOpcional(valor: unknown): string | null {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor !== "string" || !/^[0-9]{4,10}$/.test(valor.trim())) throw Errors.validation("cuenta: de 4 a 10 dígitos.");
  return valor.trim();
}

function serializarClasificacion(r: ClasificacionRecord) {
  return { categoria: r.categoria, nombre: NOMBRE_CATEGORIA[r.categoria] ?? r.categoria, confianza: r.confianza, metodo: r.metodo, razon: r.razon, cuenta: r.cuenta, empate: r.empate, porPersona: r.clasificadaPor !== null || r.metodo === "manual" || r.metodo === "correccion", creadaEn: r.creadaEn };
}

function serializarCorreccion(r: CorreccionRecord) {
  return { id: r.id, rfcEmisor: r.rfcEmisor, claveProdServ: r.claveProdServ, categoria: r.categoria, nombre: NOMBRE_CATEGORIA[r.categoria] ?? r.categoria, cuenta: r.cuenta, creadaEn: r.creadaEn, actualizadaEn: r.actualizadaEn };
}

export function despachosClasificacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // `PUT .../cfdi/:invoiceId/categoria` cuelga de `/cfdi/*`: la sesion ya la abre `despachosCfdiRoutes` (montado antes). Las demas rutas viven bajo `/clasificacion/*`.
  app.use("/despachos/:propertyId/clasificacion/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function auditar(c: Context<CoreAuthHonoEnv>, action: string, metadata: Record<string, unknown>): Promise<void> {
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

  app.get("/despachos/:propertyId/clasificacion/catalogo", async (c) => {
    assertVerticalRole(c, VER_CFDI_ROLES);
    return c.json({ categorias: CATEGORIAS_CONTABLES.map((id) => ({ id, nombre: NOMBRE_CATEGORIA[id] ?? id })), pisoConfianza: CONFIDENCE_FLOOR, umbralPorOmision: DEFAULT_CONFIDENCE_THRESHOLD });
  });

  app.put("/despachos/:propertyId/cfdi/:invoiceId/categoria", async (c) => {
    assertVerticalRole(c, BOOKKEEPING_ROLES);
    const invoiceId = c.req.param("invoiceId");
    if (!UUID_RE.test(invoiceId)) throw Errors.notFound("CFDI no encontrado.");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<{ categoria?: unknown; cuenta?: unknown; guardarRegla?: unknown }>(c.req.raw, MAX_BODY);
    const categoria = categoriaFina(raw.categoria, "categoria");
    const cuenta = cuentaOpcional(raw.cuenta);
    if (raw.guardarRegla !== undefined && typeof raw.guardarRegla !== "boolean") throw Errors.validation("guardarRegla: se esperaba verdadero o falso.");
    const guardarRegla = raw.guardarRegla === true;
    const repo = clasificacionDe(deps, c.get("db"));
    try {
      // Mismo contrato que el resto: si el CFDI no es de esta property el repositorio responde "no encontrado" (nunca confirma CFDI ajenos).
      const factura = await deps.despachosRepo(c.get("db")).findInvoice(propertyId, invoiceId);
      if (!factura) throw Errors.notFound("CFDI no encontrado.");
      const id = await repo.corregirCategoria(propertyId, invoiceId, { categoria, cuenta, guardarRegla });
      const vigente = (await repo.vigentes(propertyId, [invoiceId])).datos.get(invoiceId);
      await auditar(c, "despachos.cfdi:categoria", { propertyId, invoiceId, categoria, conCuenta: cuenta !== null, guardarRegla, clasificacionId: id });
      return c.json({ clasificacionId: id, clasificacion: vigente ? serializarClasificacion(vigente) : null });
    } catch (err) {
      return traducir(err);
    }
  });

  app.get("/despachos/:propertyId/clasificacion/correcciones", async (c) => {
    assertVerticalRole(c, VER_CFDI_ROLES);
    const r = await clasificacionDe(deps, c.get("db")).listarCorrecciones(c.req.param("propertyId"));
    return c.json({ estado: r.estado, correcciones: r.datos.map(serializarCorreccion) });
  });

  app.put("/despachos/:propertyId/clasificacion/correcciones", async (c) => {
    assertVerticalRole(c, BOOKKEEPING_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<{ rfcEmisor?: unknown; claveProdServ?: unknown; categoria?: unknown; cuenta?: unknown }>(c.req.raw, MAX_BODY);
    const rfc = typeof raw.rfcEmisor === "string" ? raw.rfcEmisor.trim().toUpperCase() : "";
    if (!RFC_RE.test(rfc)) throw Errors.validation("rfcEmisor: RFC inválido.");
    let claveProdServ: string | null = null;
    if (raw.claveProdServ !== undefined && raw.claveProdServ !== null && raw.claveProdServ !== "") {
      if (typeof raw.claveProdServ !== "string" || !/^[0-9]{8}$/.test(raw.claveProdServ.trim())) throw Errors.validation("claveProdServ: se esperaban 8 dígitos.");
      claveProdServ = raw.claveProdServ.trim();
    }
    const categoria = categoriaFina(raw.categoria, "categoria");
    const cuenta = cuentaOpcional(raw.cuenta);
    try {
      const id = await clasificacionDe(deps, c.get("db")).guardarCorreccion(propertyId, { rfcEmisor: rfc, claveProdServ, categoria, cuenta });
      await auditar(c, "despachos.clasificacion:correccion-guardada", { propertyId, correccionId: id, categoria, conClaveProdServ: claveProdServ !== null, conCuenta: cuenta !== null });
      return c.json({ id }, 200);
    } catch (err) {
      return traducir(err);
    }
  });

  app.delete("/despachos/:propertyId/clasificacion/correcciones/:id", async (c) => {
    assertVerticalRole(c, BOOKKEEPING_ROLES);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.notFound("Corrección no encontrada.");
    const propertyId = c.req.param("propertyId");
    try {
      const borrada = await clasificacionDe(deps, c.get("db")).eliminarCorreccion(propertyId, id);
      if (!borrada) throw Errors.notFound("Corrección no encontrada.");
      await auditar(c, "despachos.clasificacion:correccion-eliminada", { propertyId, correccionId: id });
      return c.json({ eliminada: true });
    } catch (err) {
      return traducir(err);
    }
  });

  app.get("/despachos/:propertyId/clasificacion/ajustes", async (c) => {
    assertVerticalRole(c, VER_CFDI_ROLES);
    const cfg = await clasificacionDe(deps, c.get("db")).leerConfig(c.req.param("propertyId"));
    return c.json({ estado: cfg.disponible ? "disponible" : "no_disponible", umbralConfianza: cfg.umbral, portalAutoaceptarValidos: cfg.portalAutoaceptar, pisoConfianza: CONFIDENCE_FLOOR });
  });

  app.put("/despachos/:propertyId/clasificacion/ajustes", async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<{ umbralConfianza?: unknown; portalAutoaceptarValidos?: unknown }>(c.req.raw, MAX_BODY);
    if (raw.umbralConfianza === undefined && raw.portalAutoaceptarValidos === undefined) throw Errors.validation("Envía umbralConfianza o portalAutoaceptarValidos.");
    let umbral: number | undefined;
    if (raw.umbralConfianza !== undefined) {
      // Invariante del suelto (common/confidence.py): umbral >= piso; si no, el piso duro nunca actuaria antes.
      const v = validarUmbralConfianza(raw.umbralConfianza);
      if (!v.ok) throw Errors.validation(v.mensaje);
      umbral = v.umbral;
    }
    if (raw.portalAutoaceptarValidos !== undefined && typeof raw.portalAutoaceptarValidos !== "boolean") throw Errors.validation("portalAutoaceptarValidos: se esperaba verdadero o falso.");
    try {
      const cfg = await clasificacionDe(deps, c.get("db")).guardarConfig(propertyId, c.get("organizationId"), { umbral, portalAutoaceptar: raw.portalAutoaceptarValidos as boolean | undefined });
      await auditar(c, "despachos.clasificacion:configuracion", { propertyId, umbralConfianza: cfg.umbral, portalAutoaceptarValidos: cfg.portalAutoaceptar });
      return c.json({ estado: "disponible", umbralConfianza: cfg.umbral, portalAutoaceptarValidos: cfg.portalAutoaceptar, pisoConfianza: CONFIDENCE_FLOOR });
    } catch (err) {
      return traducir(err);
    }
  });

  return app;
}
