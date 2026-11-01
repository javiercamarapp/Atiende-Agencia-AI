// F4c (paridad menor con el original) -- rutas del panel:
//   GET  /v1/restaurantes/:propertyId/admin/menu/productos/:productId/baja        vista previa: se borrara o se archivara (y por que)
//   POST /v1/restaurantes/:propertyId/admin/menu/productos/:productId/baja        { confirmar: true } -> borra (sin historial) o archiva (con historial); bitacora OBLIGATORIA
//   GET/PUT /v1/restaurantes/:propertyId/admin/agente/voz-idiomas                  idiomas del agente de VOZ de ESTA sucursal (lista cerrada de 32)
//   GET/PUT /v1/restaurantes/:propertyId/admin/agente/personalizacion              tono (4) y mensaje adicional del dueno para el agente de WhatsApp (toda la organizacion)
//   GET/POST /v1/restaurantes/:propertyId/admin/agente/conocimiento-archivos       lista / sube un PDF o imagen (JSON con el archivo en base64) -> borradores de conocimiento
//   DELETE   /v1/restaurantes/:propertyId/admin/agente/conocimiento-archivos/:archivoId
//
// Autorizacion: borrar un producto = `catalogo.precio` (owner/admin) con alcance de TODA la organizacion (el catalogo es de toda la organizacion); el resto = owner/admin (`STAFF_INVITE_ROLES`,
// el mismo umbral que las policies de las migraciones 181-183: RLS es la autoridad y esta capa da defensa en profundidad y mejor mensaje). Base sin migrar: lecturas con `disponible: false`
// y escrituras 503 honesto, nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ARCHIVOS_MAX_POR_ORGANIZACION,
  ARCHIVO_CUERPO_MAX_BYTES,
  ARCHIVO_MAX_BYTES,
  ARCHIVO_TIPOS,
  ETIQUETA_TONO,
  EscanerHeuristico,
  ExtractorTextoNoConfigurado,
  EXTRACTOR_LIMITES_MAX,
  extractorEsSeguro,
  IDIOMAS_ADICIONALES_MAX,
  IDIOMAS_VOZ,
  IdiomasVozInvalidosError,
  MENSAJE_DUENO_MAX,
  ParidadNoDisponibleError,
  ParidadRechazadaError,
  PersonalizacionInvalidaError,
  REGLAS_PROTEGIDAS,
  STAFF_INVITE_ROLES,
  TONOS_AGENTE_WHATSAPP,
  bloqueIdiomasVoz,
  borrarArchivoConocimiento,
  mensajeConfirmacionBaja,
  procesarCargaArchivo,
  validarConfigIdiomasVoz,
  validarPersonalizacion,
} from "@atiende/domain-restaurantes";
import type { ArchivoConocimiento, ConfigIdiomasVoz, EvaluacionBaja, LecturaIdiomasVoz, LecturaPersonalizacion, PersonalizacionAgente } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { assertAccion } from "./permisos-accion.ts";
import { assertAdminGeneral } from "./admin-scope.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function traducir(err: unknown): never {
  if (err instanceof ParidadNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof ParidadRechazadaError) throw Errors.forbidden(err.message);
  throw err;
}

function serializarArchivo(a: ArchivoConocimiento) {
  return { id: a.id, nombre: a.nombre, tipo: a.mime, tamanoBytes: a.tamanoBytes, caracteresTexto: a.caracteresTexto, borradores: a.entradasIds.length, subidoEn: a.createdAt };
}

function serializarEvaluacion(e: EvaluacionBaja) {
  return { productId: e.productId, nombre: e.nombre, accion: e.tipo, pedidosConHistorial: e.pedidosConHistorial, yaArchivado: e.yaArchivado, mensaje: mensajeConfirmacionBaja(e) };
}

function serializarIdiomas(l: LecturaIdiomasVoz) {
  return { disponible: l.disponible, configurado: l.configurado, actualizadoEn: l.actualizadoEn, idiomas: { principal: l.valor.principal, adicionales: l.valor.adicionales, deteccionAutomatica: l.valor.deteccionAutomatica } };
}

function serializarPersonalizacion(l: LecturaPersonalizacion) {
  return { disponible: l.disponible, configurada: l.configurada, actualizadoEn: l.actualizadoEn, personalizacion: { tono: l.valor.tono, mensajeDueno: l.valor.mensajeDueno } };
}

/** Bytes desde base64 ESTRICTO (sin espacios ni caracteres ajenos): una cadena rara no debe decodificarse "a medias". */
function decodificarBase64(valor: unknown): Uint8Array {
  if (typeof valor !== "string" || valor.length === 0) throw Errors.validation("contenidoBase64: se esperaba el archivo en base64.");
  if (valor.length > Math.ceil((ARCHIVO_MAX_BYTES["application/pdf"] * 4) / 3) + 8) throw Errors.payloadTooLarge("El archivo excede el tamano maximo permitido.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(valor) || valor.length % 4 !== 0) throw Errors.validation("contenidoBase64: base64 invalido.");
  return Uint8Array.from(Buffer.from(valor, "base64"));
}

export function restaurantesParidadMenorRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const raiz = "/v1/restaurantes/:propertyId/admin";
  const bajaPath = `${raiz}/menu/productos/:productId/baja`;
  const idiomasPath = `${raiz}/agente/voz-idiomas`;
  const personalizacionPath = `${raiz}/agente/personalizacion`;
  const archivosPath = `${raiz}/agente/conocimiento-archivos`;
  const archivoPath = `${raiz}/agente/conocimiento-archivos/:archivoId`;

  for (const path of [bajaPath, idiomasPath, personalizacionPath, archivosPath, archivoPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // ---------------------------------------------------------------- (1) borrar producto
  function bajaRepo(c: Context<CoreAuthHonoEnv>) {
    if (!deps.productoBajaRepo) throw Errors.serviceUnavailable("Borrar productos no esta disponible en este despliegue.");
    return deps.productoBajaRepo(c.get("db"));
  }
  function productId(c: Context<CoreAuthHonoEnv>): string {
    const id = c.req.param("productId") ?? "";
    if (!UUID_RE.test(id)) throw Errors.validation("productId: se esperaba un UUID.");
    return id;
  }

  app.get(bajaPath, async (c) => {
    assertAccion(c, "catalogo.precio");
    await assertAdminGeneral(deps, c);
    const ev = await bajaRepo(c).evaluar(c.get("organizationId"), productId(c));
    if (!ev) throw Errors.notFound("Producto no encontrado.");
    return c.json(serializarEvaluacion(ev));
  });

  app.post(bajaPath, async (c) => {
    assertAccion(c, "catalogo.precio");
    await assertAdminGeneral(deps, c);
    const organizationId = c.get("organizationId");
    const id = productId(c);
    const raw = await readJsonCapped<{ confirmar?: unknown }>(c.req.raw, 1024);
    // Confirmacion explicita: sin `confirmar: true` NO se toca nada (un clic perdido o un cliente desactualizado no borra el menu).
    if (raw.confirmar !== true) throw Errors.validation("confirmar: debe ser true; revisa primero la vista previa de la baja.");
    const repo = bajaRepo(c);
    let resultado;
    try {
      resultado = await repo.ejecutar(organizationId, id);
    } catch (err) {
      traducir(err);
    }
    if (!resultado) throw Errors.notFound("Producto no encontrado.");
    // Bitacora OBLIGATORIA: si no se puede escribir, la transaccion del request (que incluye el borrado) se revierte. Una baja sin rastro no es aceptable.
    await deps.restaurantesRepo(c.get("db")).registrarAuditoriaObligatoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: resultado.estado === "eliminado" ? "producto.eliminado" : "producto.archivado",
      entityType: "producto",
      entityId: id,
      campo: "producto",
      antes: `${resultado.nombre} (pedidos con historial: ${resultado.pedidosConHistorial})`,
      despues: resultado.estado,
    });
    logEvent(c, "info", "restaurantes_admin_producto_baja", { actorUserId: c.get("userId"), organizationId, productId: id, estado: resultado.estado });
    return c.json({ estado: resultado.estado, productId: id, nombre: resultado.nombre, pedidosConHistorial: resultado.pedidosConHistorial });
  });

  // ---------------------------------------------------------------- (2) idiomas de voz
  function idiomasRepo(c: Context<CoreAuthHonoEnv>) {
    if (!deps.idiomasVozRepo) throw Errors.serviceUnavailable("Los idiomas de voz no estan disponibles en este despliegue.");
    return deps.idiomasVozRepo(c.get("db"));
  }
  const opcionesIdiomas = () => ({ catalogo: IDIOMAS_VOZ, adicionalesMax: IDIOMAS_ADICIONALES_MAX, nota: "El idioma solo cambia como habla el agente; no cambia ninguna regla. Por omision la sucursal habla solo español (México), igual que hoy." });

  app.get(idiomasPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const l = await idiomasRepo(c).leer(c.req.param("propertyId") ?? "");
    return c.json({ ...serializarIdiomas(l), ...opcionesIdiomas(), instruccionAnexada: bloqueIdiomasVoz(l.valor) });
  });

  app.put(idiomasPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    const actorUserId = c.get("userId");
    const r = idiomasRepo(c);
    let nuevo: ConfigIdiomasVoz;
    try {
      nuevo = validarConfigIdiomasVoz(await readJsonCapped<Record<string, unknown>>(c.req.raw, 2 * 1024));
    } catch (err) {
      if (err instanceof IdiomasVozInvalidosError) throw Errors.validation(err.message);
      throw err;
    }
    const anterior = await r.leer(propertyId);
    let guardado: LecturaIdiomasVoz;
    try {
      guardado = await r.guardar(organizationId, propertyId, actorUserId, nuevo);
    } catch (err) {
      traducir(err);
    }
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.voz_idiomas_actualizados",
      entityType: "configuracion",
      entityId: propertyId,
      campo: "voz_idiomas",
      antes: anterior.configurado ? JSON.stringify(anterior.valor) : null,
      despues: JSON.stringify(guardado.valor),
    });
    logEvent(c, "info", "restaurantes_admin_voz_idiomas_actualizados", { actorUserId, organizationId, propertyId });
    return c.json({ ...serializarIdiomas(guardado), ...opcionesIdiomas(), instruccionAnexada: bloqueIdiomasVoz(guardado.valor) });
  });

  // ---------------------------------------------------------------- (4) tono y mensaje del dueno
  function personalizacionRepo(c: Context<CoreAuthHonoEnv>) {
    if (!deps.personalizacionAgenteRepo) throw Errors.serviceUnavailable("La personalizacion del agente no esta disponible en este despliegue.");
    return deps.personalizacionAgenteRepo(c.get("db"));
  }
  const opcionesPersonalizacion = () => ({
    tonos: TONOS_AGENTE_WHATSAPP.map((id) => ({ id, etiqueta: ETIQUETA_TONO[id] })),
    mensajeMax: MENSAJE_DUENO_MAX,
    reglasProtegidas: REGLAS_PROTEGIDAS,
    nota: "Solo estilo y bienvenida: el mensaje no puede cambiar reglas, precios, propina, pagos, escalacion ni seguridad (el servidor lo rechaza). Sin tono ni mensaje el agente se comporta exactamente como hoy.",
  });

  app.get(personalizacionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    return c.json({ ...serializarPersonalizacion(await personalizacionRepo(c).leer(c.get("organizationId"))), ...opcionesPersonalizacion() });
  });

  app.put(personalizacionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    await assertAdminGeneral(deps, c);
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");
    const r = personalizacionRepo(c);
    let nueva: PersonalizacionAgente;
    try {
      nueva = validarPersonalizacion(await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024));
    } catch (err) {
      if (err instanceof PersonalizacionInvalidaError) throw Errors.validation(err.message);
      throw err;
    }
    const anterior = await r.leer(organizationId);
    let guardada: LecturaPersonalizacion;
    try {
      guardada = await r.guardar(organizationId, actorUserId, nueva);
    } catch (err) {
      traducir(err);
    }
    // La bitacora lleva el tono y el LARGO del mensaje, no el texto (es del dueno, pero la bitacora no necesita copiarlo).
    const resumen = (p: PersonalizacionAgente) => JSON.stringify({ tono: p.tono, mensajeCaracteres: p.mensajeDueno?.length ?? 0 });
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.agente_personalizacion_actualizada",
      entityType: "configuracion",
      entityId: organizationId,
      campo: "agente_personalizacion",
      antes: anterior.configurada ? resumen(anterior.valor) : null,
      despues: resumen(guardada.valor),
    });
    logEvent(c, "info", "restaurantes_admin_agente_personalizacion_actualizada", { actorUserId, organizationId });
    return c.json({ ...serializarPersonalizacion(guardada), ...opcionesPersonalizacion() });
  });

  // ---------------------------------------------------------------- (3) archivos de conocimiento
  function archivosRepo(c: Context<CoreAuthHonoEnv>) {
    if (!deps.archivosConocimientoRepo) throw Errors.serviceUnavailable("Los archivos de conocimiento no estan disponibles en este despliegue.");
    return deps.archivosConocimientoRepo(c.get("db"));
  }
  const extractor = deps.extractorTextoConocimiento ?? new ExtractorTextoNoConfigurado();
  const escaner = deps.escanerArchivos ?? new EscanerHeuristico();
  const opcionesArchivos = () => ({
    tipos: Object.keys(ARCHIVO_TIPOS),
    maxBytes: ARCHIVO_MAX_BYTES,
    maxArchivos: ARCHIVOS_MAX_POR_ORGANIZACION,
    extraccionDisponible: extractorEsSeguro(extractor),
    limitesExtractor: EXTRACTOR_LIMITES_MAX,
    nota: extractorEsSeguro(extractor)
      ? "El texto del archivo se convierte en borradores de Conocimiento del negocio: revisalos y publicalos. Sirven igual al agente de WhatsApp y al de voz."
      : "No disponible aun: falta configurar la extraccion de texto de PDF e imagenes. Mientras tanto, escribe el conocimiento a mano en Conocimiento del negocio.",
  });

  app.get(archivosPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const l = await archivosRepo(c).listar(c.get("organizationId"));
    return c.json({ disponible: l.disponible, archivos: l.archivos.map(serializarArchivo), ...opcionesArchivos() });
  });

  app.post(archivosPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    await assertAdminGeneral(deps, c);
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");
    // Sin extractor real no se acepta el archivo (ni se lee el cuerpo): no se finge una carga que no hara nada.
    if (!extractorEsSeguro(extractor)) throw Errors.serviceUnavailable(opcionesArchivos().nota);
    const raw = await readJsonCapped<{ nombre?: unknown; tipo?: unknown; contenidoBase64?: unknown }>(c.req.raw, ARCHIVO_CUERPO_MAX_BYTES);
    if (typeof raw.nombre !== "string" || typeof raw.tipo !== "string") throw Errors.validation("nombre y tipo: se esperaban textos.");
    const bytes = decodificarBase64(raw.contenidoBase64);
    const repoArchivos = archivosRepo(c);
    const restaurantes = deps.restaurantesRepo(c.get("db"));
    const nombresCatalogo = (await restaurantes.listProducts(organizationId)).map((p) => p.name);
    const r = await procesarCargaArchivo(
      { escaner, extractor, archivos: repoArchivos, conocimiento: restaurantes, nombresCatalogo },
      { organizationId, actorId: actorUserId, nombre: raw.nombre, mimeDeclarado: raw.tipo, bytes },
    ).catch(traducir);
    if (r.estado === "no_disponible") throw Errors.serviceUnavailable(r.mensaje);
    if (r.estado === "rechazado") {
      // Sin eco del contenido: solo el motivo. 413 para tamano, 409 para duplicado, 422 para el resto.
      logEvent(c, "warn", "restaurantes_admin_conocimiento_archivo_rechazado", { actorUserId, organizationId, motivo: r.motivo });
      if (r.motivo === "demasiado_grande") throw Errors.payloadTooLarge(r.mensaje);
      if (r.motivo === "duplicado" || r.motivo === "limite_de_archivos") throw Errors.conflict(r.mensaje);
      throw Errors.validation(r.mensaje);
    }
    await restaurantes.registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.conocimiento_archivo_subido",
      entityType: "configuracion",
      entityId: r.archivo.id,
      campo: "conocimiento_archivo",
      antes: null,
      despues: `${r.archivo.mime}, ${r.archivo.tamanoBytes} bytes, ${r.borradores} borrador(es)`,
    });
    logEvent(c, "info", "restaurantes_admin_conocimiento_archivo_subido", { actorUserId, organizationId, archivoId: r.archivo.id, borradores: r.borradores });
    return c.json({ archivo: serializarArchivo(r.archivo), borradores: r.borradores, omitidos: r.omitidos, truncado: r.truncado }, 201);
  });

  app.delete(archivoPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    await assertAdminGeneral(deps, c);
    const organizationId = c.get("organizationId");
    const id = c.req.param("archivoId") ?? "";
    if (!UUID_RE.test(id)) throw Errors.validation("archivoId: se esperaba un UUID.");
    const restaurantes = deps.restaurantesRepo(c.get("db"));
    const r = await borrarArchivoConocimiento({ archivos: archivosRepo(c), conocimiento: restaurantes }, organizationId, id);
    if (!r) throw Errors.notFound("Archivo no encontrado.");
    await restaurantes.registrarAuditoriaObligatoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.conocimiento_archivo_borrado",
      entityType: "configuracion",
      entityId: id,
      campo: "conocimiento_archivo",
      antes: `${r.archivo.mime}, ${r.archivo.tamanoBytes} bytes`,
      despues: `borrado con ${r.entradasBorradas} entrada(s) de conocimiento`,
    });
    return c.json({ borrado: true, entradasBorradas: r.entradasBorradas });
  });

  return app;
}
