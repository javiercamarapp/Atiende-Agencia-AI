// D-08 -- portal del cliente final del despacho (el cliente del despacho contable, sin cuenta).
//
// PUBLICO (sin authMiddleware; la unica credencial es el token del enlace):
//   GET  /portal-cliente/resumen     estatus de obligaciones (SAT), cierres, documentos y mensajes de SU cliente.
//   POST /portal-cliente/documentos  sube un CFDI (XML), PDF o imagen (cuerpo = bytes del archivo, <= 2 MB).
//   POST /portal-cliente/mensajes    { cuerpo } mensaje simple al despacho.
//   GET  /portal-cliente/solicitudes  (paridad3 D-31) lo que el despacho le pidio al cliente por periodo, con el estado de cada renglon.
//   POST /portal-cliente/documentos?renglonId=<uuid>   igual que arriba y ademas liga el archivo a ese renglon de la solicitud.
//   GET  /portal-cliente/reportes     (paridad3 D-P3-21) reportes del cierre publicados para el cliente.
//   GET  /portal-cliente/reportes/:archivoId   descarga un PDF publicado.
// El token viaja en el header `X-Portal-Token` (el enlace lo lleva en el FRAGMENTO `#t=...`, que el
// navegador nunca envia al servidor): no aparece en URLs de peticion, logs de acceso ni cabecera
// Referer. El servidor solo maneja su SHA-256; la base (funciones de sistema, migracion 016) valida
// que el enlace exista, no este revocado ni expirado y deriva la property de ahi: el cliente jamas
// elige property, y un token invalido/expirado/revocado/inexistente responde IGUAL (404 generico).
// Rate limit por IP y por enlace (categoria `despachos:portal-cliente`, falla cerrado). Ningun handler
// loguea token, nombre de archivo ni contenido de mensajes.
//
// STAFF (authMiddleware + dbSession + requirePropertyMembership):
//   GET  /despachos/:propertyId/portal-cliente/enlaces
//   POST /despachos/:propertyId/portal-cliente/enlaces                       { etiqueta, dias? }  (el enlace completo solo se muestra aqui, una vez)
//   POST /despachos/:propertyId/portal-cliente/enlaces/:enlaceId/revocar
//   GET  /despachos/:propertyId/portal-cliente/documentos
//   GET  /despachos/:propertyId/portal-cliente/documentos/:documentoId/descargar
//   POST /despachos/:propertyId/portal-cliente/documentos/:documentoId/aceptar   (CFDI XML -> ingesta existente `importar-xml`)
//   POST /despachos/:propertyId/portal-cliente/documentos/:documentoId/rechazar  { motivo? }
//   GET/POST /despachos/:propertyId/portal-cliente/mensajes                   POST { cuerpo }
// NO envia correos ni WhatsApp: avisar al cliente que tiene un enlace es una accion manual del despacho.
//
// Compatibilidad con la base sin migrar (016 pendiente): el portal publico responde 503
// `portal_no_disponible`; el panel del staff responde `disponible: false` con listas vacias.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import {
  GESTIONAR_PORTAL_CLIENTE_ROLES,
  PortalCuotaExcedidaError,
  PortalEnlaceInvalidoError,
  PortalEntradaInvalidaError,
  PortalSinAccesoError,
  PostgresCarteraRepository,
  PostgresPortalClienteRepository,
  VER_PORTAL_CLIENTE_ROLES,
  esTokenPortalValido,
  generarTokenPortal,
  hashTokenPortal,
  validarArchivoPortal,
} from "@atiende/domain-despachos";
import { PilotoEntradaInvalidaError, PilotoNoEncontradoError, PilotoSinAccesoError } from "@atiende/domain-despachos";
import type { PilotoDisponible, PilotoRepository, PortalClienteRepository, PortalDisponible } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { exigirStepUpDespachos } from "./step-up.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { ingestarXmlCfdiDespachos } from "./cfdi.ts";
import { pilotoDe } from "./piloto-comun.ts";

const CATEGORIA = "despachos:portal-cliente";
const MAX_BYTES_SUBIDA = 2 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MSG_ENLACE = "Este enlace no es válido o ya no está vigente. Pide uno nuevo a tu despacho.";

const enlaceNoValido = () => new ApiError(404, "enlace_no_valido", MSG_ENLACE);
const portalNoDisponible = () => Errors.serviceUnavailable("El portal aún no está disponible. Contacta a tu despacho.");

function traducirErrorPublico(err: unknown): unknown {
  if (err instanceof PortalEnlaceInvalidoError) return enlaceNoValido();
  if (err instanceof PortalCuotaExcedidaError) return Errors.tooManyRequests(err.message);
  if (err instanceof PortalEntradaInvalidaError) return Errors.validation(err.message);
  if (err instanceof PortalSinAccesoError) return enlaceNoValido();
  return err;
}

function traducirErrorStaff(err: unknown): unknown {
  if (err instanceof PortalCuotaExcedidaError) return Errors.tooManyRequests(err.message);
  if (err instanceof PortalEntradaInvalidaError) return Errors.validation(err.message);
  if (err instanceof PortalSinAccesoError) return Errors.forbidden();
  return err;
}

/** Lee el cuerpo con tope duro: rechaza por Content-Length declarado Y corta el flujo real al pasarse. */
async function leerBytesAcotados(req: Request, max: number): Promise<Uint8Array> {
  const declarado = req.headers.get("content-length");
  if (declarado !== null) {
    const n = Number(declarado);
    if (!Number.isFinite(n) || n < 0 || n > max) throw Errors.payloadTooLarge("El archivo excede 2 MB.");
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw Errors.payloadTooLarge("El archivo excede 2 MB.");
    }
    partes.push(value);
  }
  const salida = new Uint8Array(total);
  let offset = 0;
  for (const p of partes) {
    salida.set(p, offset);
    offset += p.byteLength;
  }
  return salida;
}

function requireUuid(valor: string | undefined, campo: string): string {
  if (!valor || !UUID_RE.test(valor)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
  return valor;
}

function exigirDisponible<T>(r: PortalDisponible<T>): T {
  if (!r.disponible) throw Errors.serviceUnavailable("El portal del cliente aún no está disponible en este ambiente (migración pendiente).");
  return r.valor;
}

function cuerpoMensaje(raw: unknown): string {
  const cuerpo = typeof raw === "object" && raw !== null ? (raw as { cuerpo?: unknown }).cuerpo : undefined;
  if (typeof cuerpo !== "string") throw Errors.validation("cuerpo: se esperaba un texto.");
  const limpio = cuerpo.trim();
  if (limpio.length < 1 || limpio.length > 2000) throw Errors.validation("cuerpo: debe tener entre 1 y 2000 caracteres.");
  return limpio;
}

export function despachosPortalClienteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repoDe = (db: TenantDbSession): PortalClienteRepository => (deps.portalClienteRepo ? deps.portalClienteRepo(db) : new PostgresPortalClienteRepository(db));

  // ---------------------------------------------------------------- PUBLICO (token de enlace)
  /** Valida forma del token, aplica rate limit y devuelve SOLO el hash. Nunca toca la base. */
  async function credencial(c: Context, extra?: { readonly clave: string; readonly max: number; readonly ventanaMs: number }): Promise<string> {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const permitido = await rateLimit(`${CATEGORIA}:ip:${requestActor(c.req.raw)}`, 120, 60_000, { category: CATEGORIA });
    if (!permitido) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    const token = c.req.header("x-portal-token");
    if (!esTokenPortalValido(token)) throw enlaceNoValido();
    const hash = hashTokenPortal(token);
    if (extra) {
      const ok = await rateLimit(`${CATEGORIA}:${extra.clave}:${hash.slice(0, 24)}`, extra.max, extra.ventanaMs, { category: CATEGORIA });
      if (!ok) throw Errors.tooManyRequests("Demasiados envíos. Intenta de nuevo en unos minutos.");
    }
    return hash;
  }

  /** Sesion de SISTEMA (sin sub): las funciones del cliente exigen `auth.uid() is null`. */
  async function comoSistema<T>(fn: (repo: PortalClienteRepository) => Promise<PortalDisponible<T>>): Promise<T> {
    try {
      const r = await deps.engine.withAppSession({ userId: null }, (db) => fn(repoDe(db)));
      if (!r.disponible) throw portalNoDisponible();
      return r.valor;
    } catch (err) {
      throw traducirErrorPublico(err);
    }
  }

  /** Igual que `comoSistema` para el piloto (solicitudes y reportes): token invalido o recurso ajeno = el mismo 404 generico, sin oraculo. */
  async function comoSistemaPiloto<T>(fn: (repo: PilotoRepository) => Promise<PilotoDisponible<T>>): Promise<T> {
    try {
      const r = await deps.engine.withAppSession({ userId: null }, (db) => fn(pilotoDe(deps, db)));
      if (!r.disponible) throw portalNoDisponible();
      return r.valor;
    } catch (err) {
      if (err instanceof PilotoNoEncontradoError || err instanceof PilotoSinAccesoError) throw enlaceNoValido();
      if (err instanceof PilotoEntradaInvalidaError) throw Errors.validation(err.message);
      throw err;
    }
  }

  app.get("/portal-cliente/resumen", async (c) => {
    const hash = await credencial(c);
    const r = await comoSistema((repo) => repo.resumen(hash));
    return c.json({
      cliente: { nombre: r.clienteNombre },
      despacho: { nombre: r.despachoNombre },
      expiraEn: r.expiraEn,
      obligaciones: r.obligaciones,
      cierres: r.cierres,
      documentos: r.documentos,
      mensajes: r.mensajes,
    });
  });

  app.post("/portal-cliente/documentos", async (c) => {
    const hash = await credencial(c, { clave: "upl", max: 15, ventanaMs: 600_000 });
    const bytes = await leerBytesAcotados(c.req.raw, MAX_BYTES_SUBIDA);
    let nombre: string | null = null;
    const crudo = c.req.header("x-nombre-archivo");
    if (crudo) {
      try {
        nombre = decodeURIComponent(crudo).slice(0, 300);
      } catch {
        nombre = null;
      }
    }
    const v = validarArchivoPortal({ nombre, contentType: c.req.header("content-type"), bytes });
    if (!v.ok) throw new ApiError(422, `archivo_${v.codigo}`, v.mensaje);
    const renglonId = c.req.query("renglonId");
    if (renglonId !== undefined && !UUID_RE.test(renglonId)) throw Errors.validation("renglonId: se esperaba un UUID.");
    const r = await comoSistema((repo) => repo.recibirDocumento(hash, { tipo: v.tipo, nombreArchivo: v.nombreArchivo, mimeType: v.mimeType, contenido: bytes, resumen: v.resumen }));
    // paridad3 D-31: si el cliente subio el archivo PARA un renglon de su solicitud, queda ligado (en revision hasta que el despacho lo acepte). Si el
    // renglon ya no aplica el archivo SI quedo recibido: se avisa en `renglon` sin fallar la subida.
    let renglon: { readonly vinculado: boolean; readonly estado?: string } | undefined;
    if (renglonId !== undefined) {
      try {
        const estado = await comoSistemaPiloto((repo) => repo.portalVincular(hash, r.id, renglonId));
        renglon = { vinculado: true, estado };
      } catch (err) {
        // 404 (el renglon ya no aplica) y 503 (base sin la 027): el archivo YA quedo recibido (otra transaccion), asi que la subida no falla.
        if (err instanceof ApiError && (err.status === 404 || err.status === 503)) renglon = { vinculado: false };
        else throw err;
      }
    }
    return c.json({ id: r.id, estado: r.estado, duplicado: r.duplicado, nombreArchivo: v.nombreArchivo, ...(renglon ? { renglon } : {}) }, r.duplicado ? 200 : 201);
  });

  app.get("/portal-cliente/solicitudes", async (c) => {
    const hash = await credencial(c);
    const solicitudes = await comoSistemaPiloto((repo) => repo.portalSolicitudes(hash));
    return c.json({ solicitudes });
  });

  app.get("/portal-cliente/reportes", async (c) => {
    const hash = await credencial(c);
    const reportes = await comoSistemaPiloto((repo) => repo.portalReportes(hash));
    return c.json({ reportes });
  });

  app.get("/portal-cliente/reportes/:archivoId", async (c) => {
    const hash = await credencial(c, { clave: "rep", max: 30, ventanaMs: 600_000 });
    const archivoId = c.req.param("archivoId");
    if (!UUID_RE.test(archivoId)) throw enlaceNoValido();
    const archivo = await comoSistemaPiloto((repo) => repo.portalReporteContenido(hash, archivoId));
    const nombre = archivo.nombreArchivo.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(archivo.contenido, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${nombre}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
  });

  app.post("/portal-cliente/mensajes", async (c) => {
    const hash = await credencial(c, { clave: "msg", max: 20, ventanaMs: 600_000 });
    const cuerpo = cuerpoMensaje(await readJsonCapped(c.req.raw, 8 * 1024));
    const r = await comoSistema((repo) => repo.enviarMensajeCliente(hash, cuerpo));
    return c.json({ id: r.id }, 201);
  });

  // ---------------------------------------------------------------- STAFF
  app.use("/despachos/:propertyId/portal-cliente/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Misma traduccion de errores de dominio para todo el bloque de staff. */
  async function staff<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw traducirErrorStaff(err);
    }
  }

  app.get("/despachos/:propertyId/portal-cliente/enlaces", async (c) => {
    assertVerticalRole(c, VER_PORTAL_CLIENTE_ROLES);
    const r = await staff(() => repoDe(c.get("db")).listarEnlaces(c.req.param("propertyId")));
    return c.json({ disponible: r.disponible, enlaces: r.disponible ? r.valor : [] });
  });

  app.post("/despachos/:propertyId/portal-cliente/enlaces", async (c) => {
    assertVerticalRole(c, GESTIONAR_PORTAL_CLIENTE_ROLES);
    // D-30: un enlace nuevo da acceso a un tercero -> segundo factor reciente.
    await exigirStepUpDespachos(deps, c);
    const raw = await readJsonCapped<{ etiqueta?: unknown; dias?: unknown }>(c.req.raw, 4 * 1024);
    const etiqueta = typeof raw.etiqueta === "string" ? raw.etiqueta.trim() : "";
    if (etiqueta.length < 1 || etiqueta.length > 80) throw Errors.validation("etiqueta: debe tener entre 1 y 80 caracteres.");
    const dias = raw.dias === undefined ? 30 : raw.dias;
    if (typeof dias !== "number" || !Number.isInteger(dias) || dias < 1 || dias > 365) throw Errors.validation("dias: se esperaba un entero entre 1 y 365.");

    const token = generarTokenPortal();
    const propertyId = c.req.param("propertyId");
    const r = exigirDisponible(await staff(() => repoDe(c.get("db")).crearEnlace(propertyId, hashTokenPortal(token), etiqueta, dias)));

    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: c.get("userId"),
      actorEmail: c.get("userEmail") ?? null,
      organizationId: c.get("organizationId"),
      action: "despachos.portal_cliente:enlace_creado",
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata: { propertyId, enlaceId: r.id, dias },
    });

    c.header("Cache-Control", "no-store");
    // El enlace completo (con el token en el fragmento) solo existe en esta respuesta: la base solo guarda el hash.
    return c.json({ id: r.id, etiqueta, expiraEn: r.expiraEn, url: `${deps.env.appBaseUrl}/portal/cliente#t=${token}` }, 201);
  });

  app.post("/despachos/:propertyId/portal-cliente/enlaces/:enlaceId/revocar", async (c) => {
    assertVerticalRole(c, GESTIONAR_PORTAL_CLIENTE_ROLES);
    // D-30: revocar un enlace tambien es una accion sensible del portal -> segundo factor reciente.
    await exigirStepUpDespachos(deps, c);
    const enlaceId = requireUuid(c.req.param("enlaceId"), "enlaceId");
    const propertyId = c.req.param("propertyId");
    const revocado = exigirDisponible(await staff(() => repoDe(c.get("db")).revocarEnlace(propertyId, enlaceId)));
    if (revocado) {
      await deps.despachosAuditSink.record({
        at: new Date().toISOString(),
        actorUserId: c.get("userId"),
        actorEmail: c.get("userEmail") ?? null,
        organizationId: c.get("organizationId"),
        action: "despachos.portal_cliente:enlace_revocado",
        route: c.req.path,
        method: c.req.method,
        decision: "allowed",
        metadata: { propertyId, enlaceId },
      });
    }
    return c.json({ revocado });
  });

  app.get("/despachos/:propertyId/portal-cliente/documentos", async (c) => {
    assertVerticalRole(c, VER_PORTAL_CLIENTE_ROLES);
    const r = await staff(() => repoDe(c.get("db")).listarDocumentos(c.req.param("propertyId")));
    return c.json({ disponible: r.disponible, documentos: r.disponible ? r.valor : [] });
  });

  app.get("/despachos/:propertyId/portal-cliente/documentos/:documentoId/descargar", async (c) => {
    assertVerticalRole(c, VER_PORTAL_CLIENTE_ROLES);
    const documentoId = requireUuid(c.req.param("documentoId"), "documentoId");
    const doc = exigirDisponible(await staff(() => repoDe(c.get("db")).contenidoDocumento(c.req.param("propertyId"), documentoId)));
    if (!doc) throw Errors.notFound("Documento no encontrado.");
    // D-38: la descarga de un documento subido por el cliente deja fila en la bitacora (sin contenido ni nombre de archivo).
    await auditarAccesoDespachos(deps, c, { recurso: "portal_cliente.documento", tipo: "descarga", metadata: { documentoId, tipoDocumento: doc.tipo } });
    // Lo que subio un tercero se entrega SIEMPRE como descarga, sin interpretacion en el navegador.
    return new Response(doc.contenido, {
      status: 200,
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.nombreArchivo)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "no-store",
      },
    });
  });

  app.post("/despachos/:propertyId/portal-cliente/documentos/:documentoId/aceptar", async (c) => {
    assertVerticalRole(c, GESTIONAR_PORTAL_CLIENTE_ROLES);
    const documentoId = requireUuid(c.req.param("documentoId"), "documentoId");
    const propertyId = c.req.param("propertyId");
    const repo = repoDe(c.get("db"));
    const doc = exigirDisponible(await staff(() => repo.contenidoDocumento(propertyId, documentoId)));
    if (!doc) throw Errors.notFound("Documento no encontrado.");
    if (doc.estado !== "recibido") throw Errors.conflict("Este documento ya fue resuelto.");

    let invoiceId: string | null = null;
    let cfdi: { valido: boolean; requiereRevisionHumana: boolean } | null = null;
    if (doc.tipo === "cfdi_xml") {
      // Misma ingesta que `POST .../cfdi/importar-xml` (EFOS, cierre de periodo, cola de revision): sin duplicar.
      const { invoice } = await ingestarXmlCfdiDespachos(deps.despachosRepo(c.get("db")), c.get("organizationId"), propertyId, new TextDecoder("utf-8").decode(doc.contenido), deps.carteraRepo ? deps.carteraRepo(c.get("db")) : new PostgresCarteraRepository(c.get("db")));
      invoiceId = invoice.id;
      cfdi = { valido: invoice.valido, requiereRevisionHumana: invoice.requiresHumanReview };
    }
    const resuelto = exigirDisponible(await staff(() => repo.resolverDocumento(propertyId, documentoId, "aceptado", null, invoiceId)));
    // Si otro staff lo resolvio entre la lectura y aqui, el error revierte tambien la ingesta (misma transaccion).
    if (!resuelto) throw Errors.conflict("Este documento ya fue resuelto.");

    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: c.get("userId"),
      actorEmail: c.get("userEmail") ?? null,
      organizationId: c.get("organizationId"),
      action: "despachos.portal_cliente:documento_aceptado",
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata: { propertyId, documentoId, tipo: doc.tipo, invoiceId },
    });
    return c.json({ estado: "aceptado", invoiceId, cfdi });
  });

  app.post("/despachos/:propertyId/portal-cliente/documentos/:documentoId/rechazar", async (c) => {
    assertVerticalRole(c, GESTIONAR_PORTAL_CLIENTE_ROLES);
    const documentoId = requireUuid(c.req.param("documentoId"), "documentoId");
    const raw = await readJsonCapped<{ motivo?: unknown }>(c.req.raw, 4 * 1024);
    const motivo = typeof raw.motivo === "string" && raw.motivo.trim().length > 0 ? raw.motivo.trim() : null;
    if (motivo !== null && motivo.length > 500) throw Errors.validation("motivo: máximo 500 caracteres.");
    const propertyId = c.req.param("propertyId");
    const resuelto = exigirDisponible(await staff(() => repoDe(c.get("db")).resolverDocumento(propertyId, documentoId, "rechazado", motivo, null)));
    if (!resuelto) throw Errors.conflict("El documento no existe o ya fue resuelto.");
    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: c.get("userId"),
      actorEmail: c.get("userEmail") ?? null,
      organizationId: c.get("organizationId"),
      action: "despachos.portal_cliente:documento_rechazado",
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata: { propertyId, documentoId },
    });
    return c.json({ estado: "rechazado" });
  });

  app.get("/despachos/:propertyId/portal-cliente/mensajes", async (c) => {
    assertVerticalRole(c, VER_PORTAL_CLIENTE_ROLES);
    const r = await staff(() => repoDe(c.get("db")).listarMensajes(c.req.param("propertyId")));
    return c.json({ disponible: r.disponible, mensajes: r.disponible ? r.valor : [] });
  });

  app.post("/despachos/:propertyId/portal-cliente/mensajes", async (c) => {
    assertVerticalRole(c, GESTIONAR_PORTAL_CLIENTE_ROLES);
    const cuerpo = cuerpoMensaje(await readJsonCapped(c.req.raw, 8 * 1024));
    const r = exigirDisponible(await staff(() => repoDe(c.get("db")).enviarMensajeStaff(c.req.param("propertyId"), cuerpo)));
    return c.json({ id: r.id }, 201);
  });

  return app;
}
