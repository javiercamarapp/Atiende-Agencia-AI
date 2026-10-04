// D-32 -- facturacion de honorarios del despacho a sus clientes: igualas (contrato recurrente) y prefacturas mensuales con timbrado (migracion 023).
//
//  GET    /despachos/:propertyId/honorarios/igualas                              igualas del cliente
//  POST   /despachos/:propertyId/honorarios/igualas                              crea una iguala
//  PUT    /despachos/:propertyId/honorarios/igualas/:igualaId                    edita una iguala
//  DELETE /despachos/:propertyId/honorarios/igualas/:igualaId                    elimina una iguala (solo si no tiene prefacturas; si ya facturo se desactiva)
//  GET    /despachos/:propertyId/honorarios/prefacturas?periodo=AAAA-MM          prefacturas del cliente + estado honesto del PAC
//  POST   /despachos/:propertyId/honorarios/generar-prefacturas?periodo=AAAA-MM  genera (idempotente) las prefacturas del periodo
//  POST   /despachos/:propertyId/honorarios/prefacturas/:prefacturaId/aprobar    borrador -> aprobada
//  POST   /despachos/:propertyId/honorarios/prefacturas/:prefacturaId/timbrar    timbra con el PAC inyectado; SIN credencial responde 503 y la prefactura sigue aprobada
//  POST   /despachos/:propertyId/honorarios/prefacturas/:prefacturaId/cancelar   cancela con motivo SAT 01-04 y guardas
//
// Autorizacion: ver = VER_HONORARIOS_ROLES; escribir = GESTIONAR_HONORARIOS_ROLES (solo `admin`, como la base). Cada escritura deja bitacora.
// SIN llamadas al SAT: el unico efecto externo es el `PacClient` inyectado (`deps.pacClient`); en produccion no hay credencial (D-20) y timbrar/cancelar
// un CFDI timbrado responden 503 honesto, sin inventar nunca un UUID. Timbrar y cancelar abren sus PROPIAS transacciones (la reserva y el resultado se
// confirman aunque el PAC tarde o falle); el resto corre en la transaccion del request.
// Compatibilidad con la base sin migrar (migracion 023): las lecturas responden `estado: "no_disponible"` con lista vacia y las escrituras 503; nunca un 500.
// Notificaciones (catalogo): `despachos.honorarios.prefacturas_listas` y `despachos.honorarios.timbrado_fallido`.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import {
  GESTIONAR_HONORARIOS_ROLES,
  HonorariosCancelacionPacError,
  HonorariosCancelacionPendienteError,
  HonorariosDatosInvalidosError,
  HonorariosDuplicadoError,
  HonorariosEstadoInvalidoError,
  HonorariosNoDisponiblesError,
  HonorariosNoEncontradoError,
  HonorariosNoTimbrableError,
  HonorariosPacNoConfiguradoError,
  HonorariosSinPermisoError,
  HonorariosTimbradoFalloError,
  HonorariosTimbreNoRegistradoError,
  HonorariosTopeExcedidoError,
  PERIODO_HONORARIOS_RE,
  PostgresHonorariosRepository,
  VER_HONORARIOS_ROLES,
  cancelarPrefactura,
  evaluarTimbrabilidad,
  generarPrefacturasDelPeriodo,
  timbrarPrefactura,
  validarCancelacion,
  validarIgualaCapturada,
} from "@atiende/domain-despachos";
import type { HonorariosRepository, IgualaRecord, PrefacturaRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";

const MAX_BODY_BYTES = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MENSAJE_PAC_NO_CONFIGURADO = "timbrado pendiente: falta credencial del PAC (D-20)";

/** Errores de dominio de honorarios -> HTTP (la base ya devolvio un mensaje sin detalles internos). */
export function traducirHonorarios(err: unknown): never {
  if (err instanceof HonorariosNoDisponiblesError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof HonorariosPacNoConfiguradoError) throw Errors.serviceUnavailable(MENSAJE_PAC_NO_CONFIGURADO);
  if (err instanceof HonorariosSinPermisoError) throw Errors.forbidden(err.message);
  if (err instanceof HonorariosNoEncontradoError) throw Errors.notFound(err.message);
  if (err instanceof HonorariosDatosInvalidosError) throw Errors.validation(err.message);
  if (err instanceof HonorariosEstadoInvalidoError || err instanceof HonorariosTopeExcedidoError || err instanceof HonorariosDuplicadoError || err instanceof HonorariosCancelacionPendienteError) throw Errors.conflict(err.message);
  if (err instanceof HonorariosNoTimbrableError) throw new ApiError(422, "no_timbrable", err.message);
  if (err instanceof HonorariosTimbradoFalloError || err instanceof HonorariosCancelacionPacError) throw new ApiError(502, "pac_error", err.message);
  if (err instanceof HonorariosTimbreNoRegistradoError) throw new ApiError(500, "timbre_no_registrado", err.message);
  throw err;
}

export function serializarIguala(i: IgualaRecord) {
  return {
    id: i.id,
    concepto: i.concepto,
    claveProdServ: i.claveProdServ,
    claveUnidad: i.claveUnidad,
    claveSatEstado: i.claveSatEstado,
    montoBaseCentavos: i.montoBaseCentavos,
    tasaIvaBp: i.tasaIvaBp,
    retencionIsrBp: i.retencionIsrBp,
    retieneIvaDosTercios: i.retieneIvaDosTercios,
    periodicidad: i.periodicidad,
    diaEmision: i.diaEmision,
    usoCfdi: i.usoCfdi,
    activa: i.activa,
    creadaEn: i.createdAt,
    actualizadaEn: i.updatedAt,
  };
}

export function serializarPrefactura(p: PrefacturaRecord) {
  const timbrabilidad = evaluarTimbrabilidad(p);
  return {
    id: p.id,
    igualaId: p.igualaId,
    periodo: p.periodo,
    estado: p.estado,
    concepto: p.concepto,
    claveProdServ: p.claveProdServ,
    claveUnidad: p.claveUnidad,
    receptor: p.receptor,
    usoCfdi: p.usoCfdi,
    fechaEmision: p.fechaEmision,
    baseCentavos: p.baseCentavos,
    ivaCentavos: p.ivaCentavos,
    retencionIsrCentavos: p.retencionIsrCentavos,
    retencionIvaCentavos: p.retencionIvaCentavos,
    totalCentavos: p.totalCentavos,
    aprobadaEn: p.aprobadaEn,
    timbradaEn: p.timbradaEn,
    uuid: p.uuid,
    urlPdf: p.urlPdf,
    urlXml: p.urlXml,
    errorTimbrado: p.errorTimbrado,
    canceladaEn: p.canceladaEn,
    motivoCancelacion: p.motivoCancelacion,
    folioSustitucion: p.folioSustitucion,
    // Honesto para la pantalla: por que esta prefactura no se puede timbrar aunque este aprobada (retenciones sin verificar, desglose roto).
    timbrable: timbrabilidad.ok ? { ok: true as const } : { ok: false as const, motivo: timbrabilidad.mensaje },
  };
}

export function despachosHonorariosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repoDe = (db: TenantDbSession): HonorariosRepository => (deps.honorariosRepo ? deps.honorariosRepo(db) : new PostgresHonorariosRepository(db));

  app.use("/despachos/:propertyId/honorarios/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

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

  /** Una transaccion PROPIA (timbrar/cancelar): lo que escribe se confirma aunque el handler termine despues en un error. */
  const enSesionPropia = (c: Context<CoreAuthHonoEnv>) => <T>(fn: (repo: HonorariosRepository) => Promise<T>): Promise<T> =>
    deps.engine.withAppSession({ userId: c.get("userId") ?? null }, (session) => fn(repoDe(session)));

  function leerId(c: Context<CoreAuthHonoEnv>, nombre: string): string {
    const id = c.req.param(nombre) ?? "";
    if (!UUID_RE.test(id)) throw Errors.notFound();
    return id;
  }

  async function periodoDe(c: Context<CoreAuthHonoEnv>, desdeCuerpo: unknown): Promise<string> {
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(c.get("db")), c.req.param("propertyId") ?? ""));
    const periodo = c.req.query("periodo") ?? (typeof desdeCuerpo === "string" ? desdeCuerpo : hoy.slice(0, 7));
    if (!PERIODO_HONORARIOS_RE.test(periodo)) throw Errors.validation("periodo: se esperaba el formato AAAA-MM.");
    if (periodo > hoy.slice(0, 7)) throw Errors.validation("periodo: no se generan prefacturas de un periodo futuro.");
    return periodo;
  }

  app.get("/despachos/:propertyId/honorarios/igualas", async (c) => {
    assertVerticalRole(c, VER_HONORARIOS_ROLES);
    const r = await repoDe(c.get("db")).listarIgualas(c.req.param("propertyId"));
    return c.json({ estado: r.estado, igualas: r.igualas.map(serializarIguala) });
  });

  async function guardarIguala(c: Context<CoreAuthHonoEnv>, id: string | null) {
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const v = validarIgualaCapturada(raw);
    if (!v.ok) throw Errors.validation(v.errores.map((e) => `${e.campo}: ${e.mensaje}`).join(" "));
    const propertyId = c.req.param("propertyId") ?? "";
    let igualaId: string;
    try {
      igualaId = await repoDe(c.get("db")).guardarIguala(propertyId, id, v.valor);
    } catch (err) {
      return traducirHonorarios(err);
    }
    await auditar(c, id === null ? "despachos.honorarios.iguala:crear" : "despachos.honorarios.iguala:editar", { propertyId, igualaId, montoBaseCentavos: v.valor.montoBaseCentavos, activa: v.valor.activa });
    return igualaId;
  }

  app.post("/despachos/:propertyId/honorarios/igualas", async (c) => {
    assertVerticalRole(c, GESTIONAR_HONORARIOS_ROLES);
    const igualaId = await guardarIguala(c, null);
    return c.json({ igualaId }, 201);
  });

  app.put("/despachos/:propertyId/honorarios/igualas/:igualaId", async (c) => {
    assertVerticalRole(c, GESTIONAR_HONORARIOS_ROLES);
    const igualaId = await guardarIguala(c, leerId(c, "igualaId"));
    return c.json({ igualaId });
  });

  app.delete("/despachos/:propertyId/honorarios/igualas/:igualaId", async (c) => {
    assertVerticalRole(c, GESTIONAR_HONORARIOS_ROLES);
    const igualaId = leerId(c, "igualaId");
    const propertyId = c.req.param("propertyId");
    try {
      await repoDe(c.get("db")).eliminarIguala(propertyId, igualaId);
    } catch (err) {
      return traducirHonorarios(err);
    }
    await auditar(c, "despachos.honorarios.iguala:eliminar", { propertyId, igualaId });
    return c.json({ ok: true });
  });

  app.get("/despachos/:propertyId/honorarios/prefacturas", async (c) => {
    assertVerticalRole(c, VER_HONORARIOS_ROLES);
    const periodo = c.req.query("periodo") ?? null;
    if (periodo !== null && !PERIODO_HONORARIOS_RE.test(periodo)) throw Errors.validation("periodo: se esperaba el formato AAAA-MM.");
    const r = await repoDe(c.get("db")).listarPrefacturas(c.req.param("propertyId"), periodo);
    return c.json({
      estado: r.estado,
      periodo,
      // Estado honesto del PAC: sin credencial (D-20) el timbrado queda pendiente y la pantalla lo dice.
      pac: deps.pacClient ? { configurado: true, mensaje: null } : { configurado: false, mensaje: MENSAJE_PAC_NO_CONFIGURADO },
      prefacturas: r.prefacturas.map(serializarPrefactura),
    });
  });

  app.post("/despachos/:propertyId/honorarios/generar-prefacturas", async (c) => {
    assertVerticalRole(c, GESTIONAR_HONORARIOS_ROLES);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES).catch(() => ({}) as Record<string, unknown>);
    const periodo = await periodoDe(c, raw.periodo);
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    let resultado;
    try {
      resultado = await generarPrefacturasDelPeriodo(repoDe(db), propertyId, periodo);
    } catch (err) {
      return traducirHonorarios(err);
    }
    await auditar(c, "despachos.honorarios.prefacturas:generar", { propertyId, periodo, generadas: resultado.generadas, yaExistian: resultado.yaExistian, omitidas: resultado.omitidas.length });
    if (resultado.generadas > 0) {
      // Una por cliente y periodo (clave = property + periodo): generar de nuevo no repite el aviso.
      await emitirNotificacion(db, {
        evento: "despachos.honorarios.prefacturas_listas",
        organizationId: c.get("organizationId"),
        propertyId,
        clave: `${propertyId}:${periodo}`,
        parametros: { cantidad: resultado.generadas },
        entidadTipo: "prefactura_periodo",
      });
    }
    return c.json(resultado, resultado.generadas > 0 ? 201 : 200);
  });

  app.post("/despachos/:propertyId/honorarios/prefacturas/:prefacturaId/aprobar", async (c) => {
    assertVerticalRole(c, GESTIONAR_HONORARIOS_ROLES);
    const prefacturaId = leerId(c, "prefacturaId");
    const propertyId = c.req.param("propertyId");
    const repo = repoDe(c.get("db"));
    try {
      await repo.aprobar(propertyId, prefacturaId);
    } catch (err) {
      return traducirHonorarios(err);
    }
    await auditar(c, "despachos.honorarios.prefactura:aprobar", { propertyId, prefacturaId });
    const p = await repo.obtenerPrefactura(propertyId, prefacturaId);
    return c.json({ prefactura: p ? serializarPrefactura(p) : null });
  });

  app.post("/despachos/:propertyId/honorarios/prefacturas/:prefacturaId/timbrar", async (c) => {
    assertVerticalRole(c, GESTIONAR_HONORARIOS_ROLES);
    const prefacturaId = leerId(c, "prefacturaId");
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId") ?? null;
    try {
      const r = await timbrarPrefactura(
        {
          pac: deps.pacClient,
          enSesion: enSesionPropia(c),
          alFallar: async (p, codigo) => {
            // Aviso en su propia sesion (la del request se revierte al responder 502). Sin PII: solo el periodo y un codigo corto.
            const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(c.get("db")), propertyId));
            await deps.engine.withAppSession({ userId }, (session) =>
              emitirNotificacion(session, {
                evento: "despachos.honorarios.timbrado_fallido",
                organizationId,
                propertyId,
                clave: `${p.id}:${codigo}:${hoy}`,
                parametros: { periodo: p.periodo, codigo },
                entidadTipo: "prefactura",
                entidadId: p.id,
              }),
            );
          },
        },
        propertyId,
        prefacturaId,
      );
      await auditar(c, "despachos.honorarios.prefactura:timbrar", { propertyId, prefacturaId, yaTimbrada: r.yaTimbrada });
      return c.json({ prefactura: serializarPrefactura(r.prefactura), yaTimbrada: r.yaTimbrada, advertencias: r.totalNoCuadraConCobro ? ["El total del CFDI que devolvió el PAC no coincide con lo cobrado: revísalo antes de entregarlo."] : [] });
    } catch (err) {
      return traducirHonorarios(err);
    }
  });

  app.post("/despachos/:propertyId/honorarios/prefacturas/:prefacturaId/cancelar", async (c) => {
    assertVerticalRole(c, GESTIONAR_HONORARIOS_ROLES);
    const prefacturaId = leerId(c, "prefacturaId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    try {
      const datos = validarCancelacion(raw);
      const p = await cancelarPrefactura({ pac: deps.pacClient, enSesion: enSesionPropia(c) }, propertyId, prefacturaId, datos);
      await auditar(c, "despachos.honorarios.prefactura:cancelar", { propertyId, prefacturaId, motivo: datos.motivo });
      return c.json({ prefactura: serializarPrefactura(p) });
    } catch (err) {
      return traducirHonorarios(err);
    }
  });

  return app;
}
