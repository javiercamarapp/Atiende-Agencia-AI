// D-08 -- portal del cliente final del despacho (el cliente del despacho contable, sin cuenta).
//
// PUBLICO (sin authMiddleware; la unica credencial es el token del enlace):
//   GET  /portal-cliente/resumen     estatus de obligaciones (SAT), cierres, documentos y mensajes de SU cliente.
//   POST /portal-cliente/documentos  sube un CFDI (XML), PDF o imagen (cuerpo = bytes del archivo, <= 2 MB).
//   POST /portal-cliente/mensajes    { cuerpo } mensaje simple al despacho.
//   GET  /portal-cliente/cfdi         D-P3-22: sus CFDI (solo los de SU cliente); `?formato=csv` los exporta (celdas neutralizadas contra formulas). Cada lectura/exportacion deja bitacora (D-38).
// Un XML valido que sube el cliente se acepta SOLO (bandera por cliente `portal_autoaceptar_validos`, encendida por omision) si cumple todo lo de `decidirAutoaceptado`
// (valido, sin hallazgos, emisor fuera de la 69-B, no duplicado, periodo abierto, clasificacion con confianza); si no, queda pendiente y el staff recibe el aviso in-app.
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
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import {
  GESTIONAR_PORTAL_CLIENTE_ROLES,
  analizarXmlParaAutoaceptado,
  cfdiPortalACsv,
  decidirAutoaceptado,
  PortalCuotaExcedidaError,
  PortalEnlaceInvalidoError,
  PortalEntradaInvalidaError,
  PortalSinAccesoError,
  PostgresCarteraRepository,
  PostgresPortalClienteRepository,
  VER_PORTAL_CLIENTE_ROLES,
  esTokenPortalValido,
  tipoComprobanteDeXml,
  generarTokenPortal,
  hashTokenPortal,
  validarArchivoPortal,
} from "@atiende/domain-despachos";
import type { PortalClienteRepository, PortalDisponible } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { exigirStepUpDespachos } from "./step-up.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { avisarCfdiRequiereRevision, avisarEmisorEfos, ingestarXmlCfdiDespachos } from "./cfdi.ts";
import { clasificacionDe } from "./clasificacion-deps.ts";
import { registrarRepDespachos } from "./pagos-provisionales.ts";

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

  /**
   * D-P3-22: lo que pasa con un documento RECIEN recibido (en la misma transaccion de sistema, dentro de un SAVEPOINT: nada de aqui puede tumbar la recepcion).
   * XML valido que cumple todo -> se acepta solo y queda en bitacora; cualquier otra cosa queda pendiente y avisa al staff (`despachos.portal.documento_pendiente`).
   */
  async function procesarDocumentoNuevo(c: Context, db: TenantDbSession, repo: PortalClienteRepository, id: string, tipo: string, bytes: Uint8Array): Promise<"aceptado" | "ya_existia" | null> {
    const analisis = tipo === "cfdi_xml" ? analizarXmlParaAutoaceptado(new TextDecoder("utf-8").decode(bytes)) : null;
    const ctx = await repo.contextoIngesta(id, analisis?.ok ? { folioFiscal: analisis.folioFiscal, fecha: analisis.fecha, rfcEmisor: analisis.rfcEmisor } : { folioFiscal: null, fecha: null, rfcEmisor: null });
    if (!ctx.disponible) return null;
    const contexto = ctx.valor;
    if (analisis?.ok) {
      const decision = decidirAutoaceptado(analisis, contexto);
      if (decision.aceptar) {
        const r = await repo.aceptarCfdiSistema(id, decision.datos);
        if (r.disponible && (r.valor.estado === "aceptado" || r.valor.estado === "ya_existia")) {
          await deps.despachosAuditSink.record({
            at: new Date().toISOString(),
            actorUserId: null,
            actorEmail: null,
            organizationId: contexto.organizationId,
            action: "despachos.portal_cliente:documento_autoaceptado",
            route: c.req.path,
            method: c.req.method,
            decision: "allowed",
            metadata: { propertyId: contexto.propertyId, documentoId: id, invoiceId: r.valor.invoiceId, yaExistia: r.valor.estado === "ya_existia", origen: "sistema" },
          });
          return r.valor.estado;
        }
      }
    }
    await emitirNotificacion(db, { evento: "despachos.portal.documento_pendiente", organizationId: contexto.organizationId, propertyId: contexto.propertyId, clave: id, entidadTipo: "portal_documento", entidadId: id });
    return null;
  }

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
    let salida: { id: string; estado: string; duplicado: boolean };
    try {
      salida = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo = repoDe(db);
        const r = await repo.recibirDocumento(hash, { tipo: v.tipo, nombreArchivo: v.nombreArchivo, mimeType: v.mimeType, contenido: bytes, resumen: v.resumen });
        if (!r.disponible) throw portalNoDisponible();
        let estado: string = r.valor.estado;
        if (!r.valor.duplicado && r.valor.estado === "recibido") {
          const auto = await runWithSavepointFallback<"aceptado" | "ya_existia" | null>({
            session: db,
            primary: () => procesarDocumentoNuevo(c, db, repo, r.valor.id, v.tipo, bytes),
            // La recepcion ya ocurrio: cualquier fallo del autoaceptado/aviso deja el documento pendiente para el staff, sin responder error al cliente.
            isRecoverable: () => true,
            fallback: async () => null,
          });
          if (auto !== null) estado = "aceptado";
        }
        return { id: r.valor.id, estado, duplicado: r.valor.duplicado };
      });
    } catch (err) {
      throw traducirErrorPublico(err);
    }
    return c.json({ id: salida.id, estado: salida.estado, duplicado: salida.duplicado, nombreArchivo: v.nombreArchivo }, salida.duplicado ? 200 : 201);
  });

  /** D-P3-22: el cliente ve (y exporta) SUS CFDI. Solo los de la property de su enlace; la lectura y la exportacion dejan bitacora (D-38), sin el token. */
  app.get("/portal-cliente/cfdi", async (c) => {
    const hash = await credencial(c);
    const r = await comoSistema((repo) => repo.listarCfdi(hash));
    const csv = c.req.query("formato") === "csv";
    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: null,
      actorEmail: null,
      organizationId: r.organizationId,
      action: csv ? "despachos.portal_cliente:cfdi_exportado" : "despachos.portal_cliente:cfdi_consultado",
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata: { propertyId: r.propertyId, filas: r.cfdi.length, formato: csv ? "csv" : "json", origen: "portal_cliente" },
    });
    if (csv) {
      return new Response(cfdiPortalACsv(r.cfdi), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="mis-cfdi.csv"',
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    return c.json({ cfdi: r.cfdi, tope: 500 });
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
    let cfdi: { valido: boolean; requiereRevisionHumana: boolean; duplicado: boolean } | null = null;
    let rep: { registrados: number; yaExistian: number; omitidos: number; rechazados: number } | null = null;
    if (doc.tipo === "cfdi_xml") {
      const xml = new TextDecoder("utf-8").decode(doc.contenido);
      if (tipoComprobanteDeXml(xml) === "P") {
        // D-P3-22: un complemento de pago (REP) se ingiere por la MISMA ruta REP de siempre (`registrarRepDespachos`), no como factura.
        const r = await registrarRepDespachos(deps, c.get("db"), c.get("organizationId"), propertyId, xml);
        if (r.registrados === 0 && r.yaExistian === 0) {
          const detalle = r.rechazados[0]?.motivo ?? r.omitidos[0]?.motivo ?? "ningún documento relacionado se pudo ligar a una factura de este cliente";
          throw Errors.conflict(`El complemento de pago no se pudo registrar: ${detalle}. El documento sigue pendiente.`);
        }
        rep = { registrados: r.registrados, yaExistian: r.yaExistian, omitidos: r.omitidos.length, rechazados: r.rechazados.length };
      } else {
        // Misma ingesta que `POST .../cfdi/importar-xml` (EFOS, cierre de periodo, cola de revision, clasificacion): sin duplicar.
        const ingesta = await ingestarXmlCfdiDespachos(deps.despachosRepo(c.get("db")), c.get("organizationId"), propertyId, new TextDecoder("utf-8").decode(doc.contenido), deps.carteraRepo ? deps.carteraRepo(c.get("db")) : new PostgresCarteraRepository(c.get("db")), clasificacionDe(deps, c.get("db")));
        invoiceId = ingesta.invoice.id;
        cfdi = { valido: ingesta.invoice.valido, requiereRevisionHumana: ingesta.invoice.requiresHumanReview, duplicado: ingesta.duplicado };
        // D-P3-22: un duplicado se acepta como "ya existía" (no es un 409 que bloquee el documento); lo nuevo avisa al staff como cualquier ingesta.
        if (!ingesta.duplicado) {
          await avisarEmisorEfos(c.get("db"), c.get("organizationId"), propertyId, ingesta.invoice, ingesta.efos);
          if (ingesta.invoice.requiresHumanReview) await avisarCfdiRequiereRevision(deps, c.get("db"), c.get("organizationId"), propertyId);
        }
      }
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
      metadata: { propertyId, documentoId, tipo: doc.tipo, invoiceId, duplicado: cfdi?.duplicado ?? false, rep: rep !== null },
    });
    return c.json({ estado: "aceptado", invoiceId, cfdi, rep });
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
