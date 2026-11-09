// Fase 6 (cierre mensual): checklist de cierre + validaciones de balance +
// bloqueo de edición de movimientos ya cerrados. A diferencia de
// declaraciones.ts/conciliacion.ts, ESTE motor SÍ persiste estado
// (`despachos.periodo_cierre`/`periodo_cierre_tarea`, migrations/003) —
// necesario para que "bloquear edición de movimientos ya cerrados" tenga
// sentido entre requests (ver `cfdi.ts`, que consulta
// `findPeriodoCierrePorAnioMes` antes de ingestar). Las validaciones de
// balance (`validaciones.ts`) SÍ son un endpoint puro/calculadora aparte.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import {
  VER_CIERRE_MENSUAL_ROLES,
  GESTIONAR_CIERRE_MENSUAL_ROLES,
  CERRAR_PERIODO_ROLES,
  getTemplate,
  verificarPeriodoNoDuplicado,
  completarTarea,
  autoCheckTareas,
  autoCheckHastaPuntoFijo,
  evaluarValidacionesCierre,
  validacionesFallidas,
  moduleStateDesdeEstado,
  requierePagosProvisionales,
  correoEntregaReportes,
  generarTokenPortal,
  hashTokenPortal,
  PostgresCarteraRepository,
  PostgresPortalClienteRepository,
  recomputeOverdue,
  calcularEstadoPeriodo,
  cerrarPeriodo,
  generarReporteCierre,
  validateBalanceCuadrada,
  validatePolizasCuadradas,
  validateNominaCuadrada,
  validateIvaConciliado,
  validateIsrProvisionado,
  validateBancosConciliados,
  PeriodoYaAbiertoError,
  CierreValidacionError,
  TareaCierreEstadoInvalidoError,
} from "@atiende/domain-despachos";
import type { ClosePeriod, CloseTask, EstadoModulosCierre, PortalClienteRepository, TipoArchivoEntrega, ValidacionCierre } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";
import { exigirStepUpDespachos } from "./step-up.ts";
import { pasoSeguro, pilotoDe, traducirPiloto } from "./piloto-comun.ts";
import { construirReporteDelPeriodo } from "./reportes.ts";
import { reporteAPdf } from "./reporte-pdf.ts";
import { calcularPapelPeriodo, guardarBorradorPapel } from "./pagos-provisionales.ts";
import { generarPaqueteContabilidadDelLibro } from "./libro.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

// Bug real (revisión r6, misma causa raíz que `./vencimientos.ts::todayIso` -- ver su
// comentario de cabecera): "hoy" para decidir tareas/periodo vencidos (`recomputeOverdue`/
// `calcularEstadoPeriodo`/`generarReporteCierre`) usaba el día UTC del proceso, corrido un
// día adelante del real en CDMX entre las 18:00 y las 23:59 hora local. Ahora delega en
// `@atiende/core-tenancy::hoyFechaNegocio()`.
//
// FASE 3 (producto) — recibe la zona YA resuelta (`resolverZonaHorariaDespachosProperty`,
// una consulta por request) en vez de asumir siempre el default de plataforma -- mismo
// fix que `./vencimientos.ts::todayIso`/`./cobranza.ts::todayIso`.
function todayIso(zonaHoraria: string): string {
  return hoyFechaNegocio(zonaHoraria);
}

export function despachosCierreMensualRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const portalDe = (db: TenantDbSession): PortalClienteRepository => (deps.portalClienteRepo ? deps.portalClienteRepo(db) : new PostgresPortalClienteRepository(db));

  /** Estado de los modulos calculado en el SERVIDOR desde datos persistidos (`null` = base sin la migracion 027: sin validaciones derivadas). */
  async function leerEstadoModulos(db: TenantDbSession, periodo: ClosePeriod): Promise<EstadoModulosCierre | null> {
    try {
      const r = await pilotoDe(deps, db).estadoModulosCierre(periodo.propertyId, periodo.year, periodo.month);
      return r.disponible ? r.valor : null;
    } catch (err) {
      return traducirPiloto(err);
    }
  }

  function resumenValidaciones(estado: EstadoModulosCierre | null, mes: number): { readonly disponible: boolean; readonly items: readonly ValidacionCierre[]; readonly puedeCerrar: boolean; readonly estado: EstadoModulosCierre | null } {
    if (!estado) return { disponible: false, items: [], puedeCerrar: true, estado: null };
    const items = evaluarValidacionesCierre(estado, mes);
    return { disponible: true, items, puedeCerrar: validacionesFallidas(items).length === 0, estado };
  }

  /** Auto-check con el estado del servidor (NUNCA con lo que mande el navegador), hasta punto fijo. Sin la migracion 027 no completa nada. */
  function autoCheckServidor(estado: EstadoModulosCierre | null, periodo: ClosePeriod, tareas: readonly CloseTask[], actor: string): { readonly tareas: readonly CloseTask[]; readonly completadas: readonly CloseTask[] } {
    if (!estado) return { tareas, completadas: [] };
    const moduleState = moduleStateDesdeEstado(estado, periodo.month);
    const ahora = new Date().toISOString();
    return autoCheckHastaPuntoFijo(tareas, (t) => autoCheckTareas(t, moduleState, actor, ahora));
  }

  app.use("/despachos/:propertyId/cierre-mensual/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/despachos/:propertyId/cierre-mensual/periodos", async (c) => {
    assertVerticalRole(c, GESTIONAR_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly anio?: unknown; readonly mes?: unknown; readonly templateName?: unknown }>(c.req.raw, 8 * 1024);
    const anio = requireNumber(raw.anio, "anio");
    const mes = requireNumber(raw.mes, "mes");
    if (mes < 1 || mes > 12) throw Errors.validation("mes: se esperaba 1-12.");
    const propertyId = c.req.param("propertyId");
    const repo = deps.despachosRepo(c.get("db"));

    const periodosExistentes = await repo.listPeriodosCierre(propertyId);
    try {
      verificarPeriodoNoDuplicado(periodosExistentes, anio, mes);
    } catch (err) {
      if (err instanceof PeriodoYaAbiertoError) throw Errors.conflict(err.message);
      throw err;
    }

    const template = getTemplate(typeof raw.templateName === "string" ? raw.templateName : undefined);
    const { periodo, tareas } = await repo.insertPeriodoCierre({ organizationId: c.get("organizationId"), propertyId, anio, mes, template });
    return c.json({ periodo, tareas }, 201);
  });

  app.get("/despachos/:propertyId/cierre-mensual/periodos", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const periodos = await repo.listPeriodosCierre(c.req.param("propertyId"));
    return c.json({ periodos });
  });

  app.get("/despachos/:propertyId/cierre-mensual/periodos/:periodoId", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    let tareas = await repo.listTareasCierre(periodoId);
    const hoy = todayIso(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const estadoModulos = await leerEstadoModulos(c.get("db"), periodo);
    // Piloto automatico: al abrir el detalle de un periodo abierto, quien puede gestionarlo auto-completa lo que el servidor ya puede comprobar.
    // Un poll sin efecto no deja bitacora (solo cuando de verdad se completo algo).
    if (periodo.status !== "closed" && GESTIONAR_CIERRE_MENSUAL_ROLES.includes((c.get("verticalRole") ?? "") as never)) {
      const r = autoCheckServidor(estadoModulos, periodo, tareas, "sistema");
      if (r.completadas.length > 0) {
        tareas = await repo.replaceTareasCierre(periodoId, r.tareas);
        await deps.despachosAuditSink.record({
          at: new Date().toISOString(),
          actorUserId: c.get("userId"),
          actorEmail: c.get("userEmail") ?? null,
          organizationId: c.get("organizationId"),
          action: "despachos.cierre-mensual:auto-check",
          route: c.req.path,
          method: c.req.method,
          decision: "allowed",
          metadata: { periodoId, tareaIds: r.completadas.map((t) => t.id), origen: "detalle" },
        });
      }
    }
    const periodoActualizado = recomputeOverdue(periodo, tareas, hoy);
    if (periodoActualizado.status !== periodo.status) await repo.updatePeriodoCierre(periodoActualizado);
    const estado = calcularEstadoPeriodo(tareas, hoy);
    const validaciones = resumenValidaciones(estadoModulos, periodo.month);
    const piloto = pilotoDe(deps, c.get("db"));
    // Secuencial a proposito: una sola transaccion compartida por request (nunca Promise.all sobre la sesion).
    const artefactos = periodo.status === "closed" ? await piloto.listarArtefactos(propertyId, periodoId).catch((err: unknown) => traducirPiloto(err)) : null;
    const entrega = periodo.status === "closed" ? await piloto.entregaDelPeriodo(propertyId, periodoId).catch((err: unknown) => traducirPiloto(err)) : null;
    return c.json({
      periodo: periodoActualizado,
      tareas,
      estado,
      validaciones: { disponible: validaciones.disponible, items: validaciones.items, puedeCerrar: validaciones.puedeCerrar },
      artefactos: artefactos?.disponible ? artefactos.valor : [],
      entrega: entrega?.disponible ? entrega.valor : null,
    });
  });

  // Validaciones del cierre calculadas en el servidor (la pantalla las muestra como lista de bloqueos).
  app.get("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/validaciones", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const periodo = await repo.findPeriodoCierre(c.req.param("propertyId"), c.req.param("periodoId"));
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const v = resumenValidaciones(await leerEstadoModulos(c.get("db"), periodo), periodo.month);
    return c.json({ disponible: v.disponible, items: v.items, puedeCerrar: v.puedeCerrar });
  });

  app.post("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/tareas/:tareaId/completar", async (c) => {
    assertVerticalRole(c, GESTIONAR_CIERRE_MENSUAL_ROLES);
    // El actor SIEMPRE viene de la sesión autenticada (`c.get("userId")`), NUNCA de
    // un campo que el cliente pueda mandar en el body -- mismo patrón que
    // revisiones.ts/cfdi.ts. Antes de esta corrección la ruta confiaba en
    // `raw.userId` (texto libre del body), permitiendo que cualquier cliente
    // atribuyera la tarea a otro usuario o la dejara vacía (la UI mandaba "").
    // El body ya no tiene campos que necesitemos, pero se sigue leyendo/capando
    // (igual que el resto de rutas de este archivo) para no aceptar un payload
    // sin límite de tamaño.
    await readJsonCapped<Record<string, unknown>>(c.req.raw, 2 * 1024);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const tareas = await repo.listTareasCierre(periodoId);
    try {
      const tareaId = c.req.param("tareaId");
      const actualizadas = completarTarea(tareas, tareaId, userId, new Date().toISOString());
      const persistidas = await repo.replaceTareasCierre(periodoId, actualizadas);
      await deps.despachosAuditSink.record({
        at: new Date().toISOString(),
        actorUserId: userId,
        actorEmail: c.get("userEmail") ?? null,
        organizationId,
        action: "despachos.cierre-mensual:completar-tarea",
        route: c.req.path,
        method: c.req.method,
        decision: "allowed",
        metadata: { periodoId, tareaId },
      });
      return c.json({ tareas: persistidas });
    } catch (err) {
      if (err instanceof TareaCierreEstadoInvalidoError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  app.post("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/auto-check", async (c) => {
    assertVerticalRole(c, GESTIONAR_CIERRE_MENSUAL_ROLES);
    // El actor SIEMPRE viene de la sesion autenticada (`c.get("userId")`), NUNCA de un campo del body (hallazgo de la ronda 12). paridad3 D-P3-15:
    // tampoco el ESTADO de los modulos viene del navegador: el servidor lo calcula desde datos persistidos (`despachos.cierre_estado_modulos`), asi
    // que un `moduleState` en el body se ignora (antes un cliente podia declarar «0 CFDI pendientes» y auto-completar la tarea sin que fuera cierto).
    // El body se lee y se acota (sin limite de tamano no se acepta nada) pero ya no tiene campos que importen.
    await readJsonCapped<Record<string, unknown>>(c.req.raw, 32 * 1024);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    if (periodo.status === "closed") throw Errors.conflict(`El período ${periodo.year}-${String(periodo.month).padStart(2, "0")} ya está cerrado.`);
    const tareas = await repo.listTareasCierre(periodoId);
    const estadoModulos = await leerEstadoModulos(c.get("db"), periodo);
    const { tareas: actualizadas, completadas } = autoCheckServidor(estadoModulos, periodo, tareas, userId);
    const persistidas = completadas.length > 0 ? await repo.replaceTareasCierre(periodoId, actualizadas) : tareas;
    const periodoActualizado = recomputeOverdue(periodo, persistidas, todayIso(await resolverZonaHorariaDespachosProperty(repo, propertyId)));
    if (periodoActualizado.status !== periodo.status) await repo.updatePeriodoCierre(periodoActualizado);
    // Solo se audita cuando el auto-check de verdad completo algo: un poll sin efecto no es una accion atribuible al actor.
    if (completadas.length > 0) {
      await deps.despachosAuditSink.record({
        at: new Date().toISOString(),
        actorUserId: userId,
        actorEmail: c.get("userEmail") ?? null,
        organizationId,
        action: "despachos.cierre-mensual:auto-check",
        route: c.req.path,
        method: c.req.method,
        decision: "allowed",
        metadata: { periodoId, tareaIds: completadas.map((t) => t.id) },
      });
    }
    const validaciones = resumenValidaciones(estadoModulos, periodo.month);
    return c.json({ tareas: persistidas, completadas, periodo: periodoActualizado, validaciones: { disponible: validaciones.disponible, items: validaciones.items, puedeCerrar: validaciones.puedeCerrar } });
  });

  app.post("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/cerrar", async (c) => {
    assertVerticalRole(c, CERRAR_PERIODO_ROLES);
    // D-30: cerrar un periodo es irreversible -> segundo factor reciente (x-step-up-token, alcance despachos_sensitive).
    await exigirStepUpDespachos(deps, c);
    // Cierre de periodo: accion IRREVERSIBLE sobre un periodo fiscal (sin reapertura implementada, ver CierreMensualDetalle.tsx). El actor SIEMPRE
    // viene de la sesion autenticada, NUNCA de `raw.userId` -- ver comentario del handler de "completar" arriba, mismo hallazgo.
    // paridad3 D-P3-15: las validaciones derivadas (balanza, polizas, CFDI sin poliza, conciliacion, papel de pagos provisionales, documentos del
    // cliente) se calculan en el servidor y BLOQUEAN el cierre con un 409 que lista lo que falla. Un admin puede forzar (`forzar: true`) con un
    // motivo obligatorio (10 a 500 caracteres): el motivo queda en el periodo y la bitacora registra las validaciones saltadas (sin el texto).
    const raw = await readJsonCapped<{ readonly confirmacion?: unknown; readonly forzar?: unknown; readonly motivo?: unknown }>(c.req.raw, 4 * 1024);
    const db = c.get("db");
    const repo = deps.despachosRepo(db);
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");

    // Hallazgo de auditoria (severidad ALTA, "cierre-mensual es irreversible y ejecuta con un clic sin confirmacion ni reapertura"): se exige que el
    // llamador escriba/confirme explicitamente CUAL periodo esta cerrando ("AAAA-MM"), igual que "escribe el nombre del recurso para confirmar".
    const esperado = `${periodo.year}-${String(periodo.month).padStart(2, "0")}`;
    if (raw.confirmacion !== esperado) {
      throw Errors.validation(`confirmacion: escribe "${esperado}" (el período exacto que se va a cerrar) para confirmar. Esta acción es irreversible.`);
    }

    const estadoModulos = await leerEstadoModulos(db, periodo);
    const validaciones = resumenValidaciones(estadoModulos, periodo.month);
    const fallidas = validaciones.disponible ? validacionesFallidas(validaciones.items) : [];
    let forzado = false;
    if (fallidas.length > 0) {
      if (raw.forzar !== true) {
        return c.json(
          { code: "cierre_bloqueado", message: `No se puede cerrar ${esperado}: ${fallidas.length} validación(es) sin cumplir. Resuélvelas o, si eres admin, fuerza el cierre con un motivo.`, validaciones: fallidas },
          409,
        );
      }
      const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
      if (motivo.length < 10 || motivo.length > 500) throw Errors.validation("motivo: para forzar el cierre explica el motivo (10 a 500 caracteres).");
      try {
        forzado = await pilotoDe(deps, db).forzarCierre(propertyId, periodoId, motivo, fallidas.map((v) => v.clave));
      } catch (err) {
        return traducirPiloto(err);
      }
    }

    const tareas = await repo.listTareasCierre(periodoId);
    try {
      const cerrado = cerrarPeriodo(periodo, tareas, userId, new Date().toISOString());
      const persistido = await repo.updatePeriodoCierre(cerrado);
      await deps.despachosAuditSink.record({
        at: new Date().toISOString(),
        actorUserId: userId,
        actorEmail: c.get("userEmail") ?? null,
        organizationId,
        action: forzado ? "despachos.cierre-mensual:cerrar-periodo-forzado" : "despachos.cierre-mensual:cerrar-periodo",
        route: c.req.path,
        method: c.req.method,
        decision: "allowed",
        metadata: { periodoId, anio: persistido.year, mes: persistido.month, ...(forzado ? { forzado: true, validaciones: fallidas.map((v) => v.clave).join(",") } : {}) },
      });
      const posCierre = await posCierrePeriodo(c, persistido, estadoModulos);
      return c.json({ ...persistido, posCierre });
    } catch (err) {
      if (err instanceof CierreValidacionError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  /**
   * Lo que sigue al cierre, cada paso de mejor esfuerzo en su propio SAVEPOINT (un fallo se reporta pero NO deshace el cierre ya hecho):
   *  1. pre-genera el papel de pagos provisionales si no existe (borrador; NO lo presenta);
   *  2. pre-genera el catalogo y la balanza XML de contabilidad electronica desde el libro (se guardan; NO se presentan);
   *  3. si el cliente activo la entrega (apagada por omision), publica los PDF en su portal y le manda un correo con el enlace.
   */
  async function posCierrePeriodo(c: Context<CoreAuthHonoEnv>, periodo: ClosePeriod, estado: EstadoModulosCierre | null): Promise<{ readonly papelPagos: string; readonly contabilidadElectronica: string; readonly entrega: string }> {
    const db = c.get("db");
    const propertyId = periodo.propertyId;
    const piloto = pilotoDe(deps, db);
    const mesTxt = String(periodo.month).padStart(2, "0");

    let papelPagos = "no_aplica";
    if (estado && estado.pagosProvisionales === 0 && requierePagosProvisionales(estado.periodicidad, periodo.month)) {
      const r = await pasoSeguro(db, "papel_pagos", async () => {
        const x = await calcularPapelPeriodo(deps, db, propertyId, periodo.year, periodo.month, {}, undefined);
        await guardarBorradorPapel(deps, db, propertyId, x, periodo.year, periodo.month);
      });
      papelPagos = r.ok ? "generado" : `no_generado: ${r.error}`;
    } else if (estado && estado.pagosProvisionales > 0) {
      papelPagos = "ya_existia";
    }

    let contabilidadElectronica = "no_generada";
    if (estado) {
      const r = await pasoSeguro(db, "contab_electronica", async () => {
        const paquete = await generarPaqueteContabilidadDelLibro(deps, db, propertyId, periodo.year, periodo.month);
        if (!paquete) return false;
        const enc = new TextEncoder();
        const nuevoCat = await piloto.guardarArtefacto(propertyId, periodo.id, "contabilidad_catalogo_xml", `catalogo-${periodo.year}-${mesTxt}.xml`, enc.encode(paquete.catalogo.xml));
        const nuevoBal = await piloto.guardarArtefacto(propertyId, periodo.id, "contabilidad_balanza_xml", `balanza-${periodo.year}-${mesTxt}.xml`, enc.encode(paquete.balanza.xml));
        return nuevoCat || nuevoBal ? true : "ya_existia";
      });
      contabilidadElectronica = !r.ok ? `no_generada: ${r.error}` : r.valor === true ? "generada" : r.valor === "ya_existia" ? "ya_existia" : "sin_libro_en_el_periodo";
    }

    let entrega = "no_aplica";
    if (estado) {
      const r = await pasoSeguro(db, "entrega_cliente", () => entregarReportesAlCliente(c, periodo));
      entrega = r.ok ? r.valor : `no_enviada: ${r.error}`;
    }
    return { papelPagos, contabilidadElectronica, entrega };
  }

  /** Entrega de reportes al cliente (D-P3-21): idempotente por periodo; solo con el opt-in del cliente y su correo de contacto. */
  async function entregarReportesAlCliente(c: Context<CoreAuthHonoEnv>, periodo: ClosePeriod): Promise<string> {
    const db = c.get("db");
    const propertyId = periodo.propertyId;
    const organizationId = c.get("organizationId");
    const piloto = pilotoDe(deps, db);
    const auto = await piloto.obtenerAutomatizacion(propertyId);
    if (!auto.disponible || !auto.valor.envioReportesCierre || !auto.valor.contactoCorreo) return "no_activada";
    const entrega = await piloto.crearEntrega(propertyId, periodo.id);
    if (!entrega.creada) return "ya_entregada";
    const mesTxt = String(periodo.month).padStart(2, "0");
    const repo = deps.despachosRepo(db);
    const hoy = todayIso(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const archivos: { readonly tipo: TipoArchivoEntrega; readonly nombre: string }[] = [];
    for (const [tipo, titulo] of [["impuestos", "Impuestos"], ["diot", "DIOT"], ["balanza", "Balanza"]] as const) {
      const reporte = await construirReporteDelPeriodo(deps, db, organizationId, propertyId, tipo, `${periodo.year}-${mesTxt}`, hoy);
      const pdf = await reporteAPdf(reporte);
      const nombre = `${tipo}-${periodo.year}-${mesTxt}.pdf`;
      await piloto.agregarArchivoEntrega(propertyId, entrega.id, tipo, nombre, pdf);
      archivos.push({ tipo, nombre: `${titulo} ${periodo.year}-${mesTxt} (PDF)` });
    }
    const token = generarTokenPortal();
    await portalDe(db).crearEnlace(propertyId, hashTokenPortal(token), `Reportes ${periodo.year}-${mesTxt}`, 30);
    const ficha = await (deps.carteraRepo ? deps.carteraRepo(db) : new PostgresCarteraRepository(db)).obtenerFicha(propertyId);
    const correo = correoEntregaReportes({ clienteNombre: ficha?.razonSocial ?? "tu empresa", ejercicio: periodo.year, mes: periodo.month, archivos: archivos.map((a) => a.nombre), enlace: `${deps.env.appBaseUrl}/portal/cliente#t=${token}` });
    await repo.enqueueMessagingOutbox(organizationId, "email", "despachos.cierre.entrega", `cierre-entrega:${periodo.id}`, { to: auto.valor.contactoCorreo, subject: correo.asunto, html: correo.html, text: correo.texto });
    await piloto.marcarCorreoEntrega(propertyId, entrega.id);
    await emitirNotificacion(db, { evento: "despachos.cierre.entrega_enviada", organizationId, propertyId, clave: periodo.id, entidadTipo: "periodo_cierre", entidadId: periodo.id });
    return "enviada";
  }

  // Descarga de un artefacto pre-generado al cerrar (XML de contabilidad electronica): es una exportacion fiscal -> segundo factor + bitacora D-38.
  app.get("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/artefactos/:artefactoId/descargar", async (c) => {
    assertVerticalRole(c, GESTIONAR_CIERRE_MENSUAL_ROLES);
    await exigirStepUpDespachos(deps, c);
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const artefactoId = c.req.param("artefactoId");
    const piloto = pilotoDe(deps, c.get("db"));
    const lista = await piloto.listarArtefactos(propertyId, periodoId).catch((err: unknown) => traducirPiloto(err));
    const meta = lista.disponible ? lista.valor.find((a) => a.id === artefactoId) : undefined;
    if (!meta) throw Errors.notFound("Archivo no encontrado.");
    const archivo = await piloto.contenidoArtefacto(propertyId, artefactoId).catch((err: unknown) => traducirPiloto(err));
    await auditarAccesoDespachos(deps, c, { recurso: "cierre_mensual.artefacto", tipo: "descarga", metadata: { periodoId, tipo: meta.tipo } });
    return new Response(archivo.contenido, { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${meta.nombreArchivo}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  });

  app.get("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/reporte", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const tareas = await repo.listTareasCierre(periodoId);
    const hoy = todayIso(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    return c.json(generarReporteCierre(periodo, tareas, hoy));
  });

  // ---- Validaciones de balance (endpoint puro/calculadora, sin persistencia) ----

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/balance", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly totalDebe?: unknown; readonly totalHaber?: unknown; readonly toleranciaBalance?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(validateBalanceCuadrada(requireNumber(raw.totalDebe, "totalDebe"), requireNumber(raw.totalHaber, "totalHaber"), optionalNumber(raw.toleranciaBalance, "toleranciaBalance", 1.0)));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/polizas", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly polizas?: unknown }>(c.req.raw, 256 * 1024);
    if (!Array.isArray(raw.polizas)) throw Errors.validation("polizas: se esperaba un arreglo.");
    const polizas = (raw.polizas as { id?: unknown; totalDebe?: unknown; totalHaber?: unknown }[]).map((p, idx) => ({
      id: typeof p.id === "string" ? p.id : undefined,
      totalDebe: requireNumber(p.totalDebe, `polizas[${idx}].totalDebe`),
      totalHaber: requireNumber(p.totalHaber, `polizas[${idx}].totalHaber`),
    }));
    return c.json(validatePolizasCuadradas(polizas));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/nomina", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly nominas?: unknown }>(c.req.raw, 256 * 1024);
    if (!Array.isArray(raw.nominas)) throw Errors.validation("nominas: se esperaba un arreglo.");
    const nominas = (raw.nominas as { sueldoBruto?: unknown; totalDeducciones?: unknown; sueldoNeto?: unknown }[]).map((n, idx) => ({
      sueldoBruto: requireNumber(n.sueldoBruto, `nominas[${idx}].sueldoBruto`),
      totalDeducciones: requireNumber(n.totalDeducciones, `nominas[${idx}].totalDeducciones`),
      sueldoNeto: requireNumber(n.sueldoNeto, `nominas[${idx}].sueldoNeto`),
    }));
    return c.json(validateNominaCuadrada(nominas));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/iva", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly ivaTrasladado?: unknown; readonly ivaAcreditable?: unknown; readonly ivaProvisionado?: unknown; readonly tolerance?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(
      validateIvaConciliado(
        requireNumber(raw.ivaTrasladado, "ivaTrasladado"),
        requireNumber(raw.ivaAcreditable, "ivaAcreditable"),
        requireNumber(raw.ivaProvisionado, "ivaProvisionado"),
        optionalNumber(raw.tolerance, "tolerance", 100.0),
      ),
    );
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/isr", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly isrProvision?: unknown; readonly utilidadFiscal?: unknown; readonly isrRate?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(validateIsrProvisionado(requireNumber(raw.isrProvision, "isrProvision"), requireNumber(raw.utilidadFiscal, "utilidadFiscal"), optionalNumber(raw.isrRate, "isrRate", 0.3)));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/bancos", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly matchRate?: unknown; readonly minReconciliationRate?: unknown; readonly totalMovements?: unknown; readonly matched?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(
      validateBancosConciliados(
        requireNumber(raw.matchRate, "matchRate"),
        optionalNumber(raw.minReconciliationRate, "minReconciliationRate", 0.8),
        optionalNumber(raw.totalMovements, "totalMovements", 0),
        optionalNumber(raw.matched, "matched", 0),
      ),
    );
  });

  return app;
}
