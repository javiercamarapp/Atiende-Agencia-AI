// D-35 + D-02 -- conciliación bancaria PERSISTIDA y nivel 4 (LLM) por HTTP (migración 021). Se registra DENTRO de `conciliacion.ts` (misma
// cadena authMiddleware -> dbSession -> requirePropertyMembership: una sola sesión/transacción por request).
//
//  POST /despachos/:propertyId/conciliacion/sesiones                        crea la sesión con los movimientos guardados del periodo
//  GET  /despachos/:propertyId/conciliacion/sesiones                        lista de sesiones
//  GET  /despachos/:propertyId/conciliacion/sesiones/:id                    detalle: movimientos, propuestas del motor, matches, sugerencias
//  POST /despachos/:propertyId/conciliacion/sesiones/:id/confirmar          confirma pares (el servidor RE-EJECUTA el motor; nunca confía en el cliente)
//  POST /despachos/:propertyId/conciliacion/sesiones/:id/cerrar             cierra la sesión (idempotente)
//  POST /despachos/:propertyId/conciliacion/matches/:matchId/deshacer       deshace un match (motivo obligatorio, idempotente)
//  POST /despachos/:propertyId/conciliacion/sesiones/:id/sugerencias-llm    nivel 4: el modelo SUGIERE; 503 honesto sin gateway
//  POST /despachos/:propertyId/conciliacion/sugerencias/:id/aprobar         aprobación humana: crea el match llm_aprobado
//  POST /despachos/:propertyId/conciliacion/sugerencias/:id/rechazar
//
// Autorización: ver = VER_CONCILIACION_ROLES; confirmar/deshacer/cerrar/sugerir/aprobar/rechazar = CONCILIACION_ROLES (admin/contador). La base
// repite el guard (funciones security definer). Una sugerencia del LLM NUNCA cambia el estado de la conciliación sin aprobación humana. Cada
// escritura deja bitácora en `despachosAuditSink` (metadata sin texto libre ni PII: ids y conteos). Compatibilidad con la base sin migrar: la lista
// responde `disponible: false` con vacío honesto y el resto 503; nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import {
  CONCILIACION_ROLES,
  ConciliacionConflictoError,
  ConciliacionDatosInvalidosError,
  ConciliacionNoDisponibleError,
  ConciliacionNoEncontradaError,
  ConciliacionPeriodoCerradoError,
  ConciliacionSinPermisoError,
  ConciliacionTopeExcedidoError,
  ParNoPropuestoPorMotorError,
  PERIODO_RE,
  PostgresConciliacionPersistidaRepository,
  SugerenciaLLMFallidaError,
  VER_CONCILIACION_ROLES,
  calcularPropuestas,
  estaPeriodoCerrado,
  resolverPares,
  sugerirMatchesLLM,
} from "@atiende/domain-despachos";
import type { ConciliacionPersistidaRepository, DespachosRole, InvoiceRecord, MovimientoGuardado, ParSolicitado, RegistroConciliable, SesionConciliacion } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Techo de movimientos que se mandan al modelo en una corrida (defensa de costo; el resto queda sin evaluar y se puede repetir). */
export const MAX_MOVIMIENTOS_LLM_POR_CORRIDA = 25;

/** Errores de dominio -> ApiError (400/403/404/409/503). Todo lo demás se repropaga. */
export function traducirErrorConciliacionHttp(err: unknown): never {
  if (err instanceof ConciliacionNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof ConciliacionSinPermisoError) throw Errors.forbidden(err.message);
  if (err instanceof ConciliacionNoEncontradaError) throw Errors.notFound(err.message);
  if (err instanceof ConciliacionDatosInvalidosError || err instanceof ConciliacionTopeExcedidoError) throw Errors.validation(err.message);
  if (err instanceof ConciliacionPeriodoCerradoError) throw Errors.despachosConciliacionPeriodoCerrado(err.periodo);
  if (err instanceof ConciliacionConflictoError) throw Errors.conflict(err.message);
  if (err instanceof ParNoPropuestoPorMotorError) throw Errors.despachosParNoPropuesto(err.message);
  throw err;
}

function exigirUuid(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || !UUID_RE.test(valor)) throw Errors.validation(`${campo}: se esperaba un id válido.`);
  return valor;
}

export function registrarConciliacionPersistida(app: Hono<CoreAuthHonoEnv>, deps: AppDeps, invoiceARegistro: (inv: InvoiceRecord) => RegistroConciliable): void {
  const repoDe = (c: Context<CoreAuthHonoEnv>): ConciliacionPersistidaRepository => (deps.conciliacionRepo ? deps.conciliacionRepo(c.get("db")) : new PostgresConciliacionPersistidaRepository(c.get("db")));

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

  async function sesionOFallar(repo: ConciliacionPersistidaRepository, propertyId: string, id: string): Promise<SesionConciliacion> {
    const r = await repo.obtenerSesion(propertyId, exigirUuid(id, "id"));
    if (r.estado === "no_disponible") throw Errors.serviceUnavailable(new ConciliacionNoDisponibleError().message);
    if (!r.datos) throw Errors.notFound("Sesión de conciliación no encontrada.");
    return r.datos;
  }

  /** 409 claro si el periodo de la sesión está cerrado en cierre-mensual (la base lo repite con 55000). */
  async function exigirPeriodoAbierto(c: Context<CoreAuthHonoEnv>, sesion: SesionConciliacion): Promise<void> {
    const [anio, mes] = sesion.periodo.split("-").map(Number);
    const periodo = await deps.despachosRepo(c.get("db")).findPeriodoCierrePorAnioMes(sesion.propertyId, anio!, mes!);
    if (estaPeriodoCerrado(periodo)) throw Errors.despachosConciliacionPeriodoCerrado(sesion.periodo);
  }

  /** Datos que el motor necesita, SIEMPRE leídos del servidor: movimientos de la sesión sin match vigente y CFDI de la property aún sin conciliar. */
  async function cargarDatos(c: Context<CoreAuthHonoEnv>, repo: ConciliacionPersistidaRepository, sesion: SesionConciliacion) {
    // En SECUENCIA: la sesión del request es UNA transacción con un solo cliente pg. Cada método del repo abre su propio
    // SAVEPOINT; en paralelo se encolan SAVEPOINT a, b, c y luego RELEASE a destruye b y c (3B001) y aborta la transacción.
    const movimientos = await repo.listarMovimientosSesion(sesion);
    const matches = await repo.listarMatches(sesion.id);
    const sugerencias = await repo.listarSugerencias(sesion.id);
    const conciliados = await repo.invoiceIdsConciliados(sesion.propertyId);
    const invoices = await deps.despachosRepo(c.get("db")).listInvoices(sesion.propertyId);
    const movimientosConMatch = new Set(matches.filter((m) => m.deshechoEn === null).map((m) => m.movimientoId));
    const movimientosLibres: MovimientoGuardado[] = movimientos.filter((m) => !movimientosConMatch.has(m.id));
    const registrosLibres = invoices.filter((i) => !conciliados.datos.has(i.id)).map(invoiceARegistro);
    return { movimientos, movimientosLibres, matches, sugerencias, invoices, conciliados: conciliados.datos, registrosLibres };
  }

  app.post("/despachos/:propertyId/conciliacion/sesiones", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly periodo?: unknown; readonly cuenta?: unknown }>(c.req.raw, 8 * 1024);
    if (typeof raw.periodo !== "string" || !PERIODO_RE.test(raw.periodo)) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");
    let cuenta: string | null = null;
    if (raw.cuenta !== undefined && raw.cuenta !== null && raw.cuenta !== "") {
      if (typeof raw.cuenta !== "string" || !/^[0-9A-Za-z-]{4,34}$/.test(raw.cuenta.trim())) throw Errors.validation("cuenta: se esperaba una CLABE o número de cuenta (4 a 34 caracteres alfanuméricos).");
      cuenta = raw.cuenta.trim();
    }
    try {
      const r = await repoDe(c).crearSesion(c.req.param("propertyId"), raw.periodo, cuenta, c.get("userId"));
      await auditar(c, "despachos.conciliacion:sesion-crear", { sesionId: r.sesion.id, periodo: r.sesion.periodo, movimientos: r.movimientos });
      return c.json({ sesion: r.sesion, movimientos: r.movimientos }, 201);
    } catch (err) {
      return traducirErrorConciliacionHttp(err);
    }
  });

  app.get("/despachos/:propertyId/conciliacion/sesiones", async (c) => {
    assertVerticalRole(c, VER_CONCILIACION_ROLES);
    const r = await repoDe(c).listarSesiones(c.req.param("propertyId"), 100);
    return c.json({ disponible: r.estado === "disponible", sesiones: r.datos });
  });

  app.get("/despachos/:propertyId/conciliacion/sesiones/:id", async (c) => {
    assertVerticalRole(c, VER_CONCILIACION_ROLES);
    const repo = repoDe(c);
    try {
      const sesion = await sesionOFallar(repo, c.req.param("propertyId"), c.req.param("id"));
      const d = await cargarDatos(c, repo, sesion);
      // Propuestas del motor recalculadas AHORA, solo con lo que sigue libre y mientras la sesión esté abierta.
      const calculo = sesion.estado === "abierta" ? calcularPropuestas(d.movimientosLibres, d.registrosLibres) : { propuestas: [], multiLinea: [] };
      const pendientes = new Set(d.sugerencias.filter((g) => g.estado === "pendiente").map((g) => g.movimientoId));
      const vigentePorMovimiento = new Map(d.matches.filter((m) => m.deshechoEn === null).map((m) => [m.movimientoId, m.id]));
      return c.json({
        sesion,
        movimientos: d.movimientos.map((m) => ({
          id: m.id,
          fecha: m.fecha,
          descripcion: m.descripcion,
          referencia: m.referencia,
          cuenta: m.cuenta,
          monto: m.monto,
          estado: vigentePorMovimiento.has(m.id) ? "conciliado" : pendientes.has(m.id) ? "sugerido" : "sin_conciliar",
          matchId: vigentePorMovimiento.get(m.id) ?? null,
        })),
        cfdis: d.invoices.slice(0, 2000).map((i) => ({ id: i.id, folioFiscal: i.folioFiscal, emisorNombre: i.emisorNombre, total: i.total, fecha: i.fecha, conciliado: d.conciliados.has(i.id) })),
        propuestas: calculo.propuestas,
        multiLinea: calculo.multiLinea,
        matches: d.matches,
        sugerencias: d.sugerencias,
      });
    } catch (err) {
      return traducirErrorConciliacionHttp(err);
    }
  });

  app.post("/despachos/:propertyId/conciliacion/sesiones/:id/confirmar", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly pares?: unknown }>(c.req.raw, 128 * 1024);
    if (!Array.isArray(raw.pares) || raw.pares.length < 1 || raw.pares.length > 200) throw Errors.validation("pares: se esperaba un arreglo de 1 a 200 pares.");
    const solicitados: ParSolicitado[] = raw.pares.map((p: unknown, i: number) => {
      if (typeof p !== "object" || p === null) throw Errors.validation(`pares[${i}]: se esperaba un objeto.`);
      const o = p as { movimientoId?: unknown; invoiceId?: unknown; manual?: unknown };
      if (o.manual !== undefined && typeof o.manual !== "boolean") throw Errors.validation(`pares[${i}].manual: se esperaba true o false.`);
      return { movimientoId: exigirUuid(o.movimientoId, `pares[${i}].movimientoId`), invoiceId: exigirUuid(o.invoiceId, `pares[${i}].invoiceId`), manual: o.manual === true };
    });
    if (new Set(solicitados.map((s) => s.movimientoId)).size !== solicitados.length) throw Errors.validation("pares: un movimiento solo puede conciliarse una vez por solicitud.");
    const repo = repoDe(c);
    const propertyId = c.req.param("propertyId");
    try {
      const sesion = await sesionOFallar(repo, propertyId, c.req.param("id"));
      if (sesion.estado !== "abierta") throw Errors.conflict("La sesión está cerrada: no admite más confirmaciones.");
      await exigirPeriodoAbierto(c, sesion);
      const d = await cargarDatos(c, repo, sesion);
      // El SERVIDOR recalcula: solo se confirma lo que el motor propone ahora, o lo que una persona con rol de escritura marca como manual.
      const { propuestas } = calcularPropuestas(d.movimientosLibres, d.registrosLibres);
      const pares = resolverPares(solicitados, propuestas);
      const matches = await repo.confirmarMatches(propertyId, sesion.id, pares, c.get("userId"));
      await auditar(c, "despachos.conciliacion:confirmar", {
        sesionId: sesion.id,
        pares: matches.length,
        motor: matches.filter((m) => m.origen === "motor").length,
        manuales: matches.filter((m) => m.origen === "manual").length,
        matchIds: matches.map((m) => m.id),
      });
      return c.json({ matches }, 201);
    } catch (err) {
      return traducirErrorConciliacionHttp(err);
    }
  });

  app.post("/despachos/:propertyId/conciliacion/sesiones/:id/cerrar", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const repo = repoDe(c);
    try {
      const sesion = await sesionOFallar(repo, c.req.param("propertyId"), c.req.param("id"));
      const r = await repo.cerrarSesion(sesion.propertyId, sesion.id, c.get("userId"));
      if (!r.yaCerrada) await auditar(c, "despachos.conciliacion:sesion-cerrar", { sesionId: sesion.id });
      return c.json({ yaCerrada: r.yaCerrada });
    } catch (err) {
      return traducirErrorConciliacionHttp(err);
    }
  });

  app.post("/despachos/:propertyId/conciliacion/matches/:matchId/deshacer", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly motivo?: unknown }>(c.req.raw, 8 * 1024);
    const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
    if (motivo.length < 3 || motivo.length > 500) throw Errors.validation("motivo: es obligatorio (3 a 500 caracteres).");
    const matchId = exigirUuid(c.req.param("matchId"), "matchId");
    const propertyId = c.req.param("propertyId");
    const repo = repoDe(c);
    try {
      const match = await repo.obtenerMatch(propertyId, matchId);
      if (!match) throw Errors.notFound("Conciliación no encontrada.");
      const r = await repo.deshacerMatch(propertyId, matchId, motivo, c.get("userId"));
      // Idempotente: la segunda llamada responde 200 con `yaDeshecho` y NO vuelve a dejar bitácora.
      if (!r.yaDeshecho) await auditar(c, "despachos.conciliacion:deshacer", { matchId, sesionId: match.sesionId, origen: match.origen, motivoLongitud: motivo.length });
      return c.json({ yaDeshecho: r.yaDeshecho });
    } catch (err) {
      return traducirErrorConciliacionHttp(err);
    }
  });

  app.post("/despachos/:propertyId/conciliacion/sesiones/:id/sugerencias-llm", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const gateway = deps.llmGateway;
    if (!gateway) throw Errors.serviceUnavailable("IA no configurada: el entorno no tiene un proveedor de modelos, así que no se pueden generar sugerencias. La conciliación determinística sigue disponible.");
    const repo = repoDe(c);
    const propertyId = c.req.param("propertyId");
    try {
      const sesion = await sesionOFallar(repo, propertyId, c.req.param("id"));
      if (sesion.estado !== "abierta") throw Errors.conflict("La sesión está cerrada: no admite sugerencias.");
      await exigirPeriodoAbierto(c, sesion);
      const d = await cargarDatos(c, repo, sesion);
      const conPendiente = new Set(d.sugerencias.filter((g) => g.estado === "pendiente").map((g) => g.movimientoId));
      // El nivel 4 opera SOLO sobre lo que el motor determinístico no pudo conciliar y que no tiene ya una sugerencia pendiente.
      const sinPendiente = d.movimientosLibres.filter((m) => !conPendiente.has(m.id));
      // Tampoco se re-sugiere un CFDI que ya tiene una sugerencia pendiente: aprobar dos dejaría dos matches sobre una factura.
      const cfdiConPendiente = new Set(d.sugerencias.filter((g) => g.estado === "pendiente").map((g) => g.invoiceId));
      const calculo = calcularPropuestas(sinPendiente, d.registrosLibres.filter((r) => !cfdiConPendiente.has(r.id)));
      const actorRole = c.get("verticalRole") as DespachosRole;
      let resultado;
      try {
        resultado = await sugerirMatchesLLM(gateway, calculo.movimientosSinConciliar, calculo.registrosSinConciliar, {
          tenantId: c.get("organizationId"),
          actor: { actorId: c.get("userId"), actorRole },
          maxMovimientos: MAX_MOVIMIENTOS_LLM_POR_CORRIDA,
        });
      } catch (err) {
        if (err instanceof SugerenciaLLMFallidaError) throw Errors.despachosIaFallo("El proveedor de IA no respondió. Intenta de nuevo en unos minutos.");
        throw err;
      }
      const guardadas = await repo.guardarSugerencias(
        propertyId,
        sesion.id,
        resultado.sugerencias.map((s) => ({
          movimientoId: calculo.movimientosSinConciliar[s.movementIdx]!.id,
          invoiceId: calculo.registrosSinConciliar[s.registroIdx]!.id,
          confianza: s.score,
          razon: s.detail,
        })),
        c.get("userId"),
      );
      let notificacion: string = "sin_nuevas";
      if (guardadas.length > 0) {
        // Se emite desde la escritura que la causa (dedupe por sesión: una campana por sesión aunque se vuelva a sugerir). Sin PII: solo un conteo.
        const total = d.sugerencias.filter((g) => g.estado === "pendiente").length + guardadas.length;
        const n = await emitirNotificacion(c.get("db"), {
          evento: "despachos.conciliacion.sugerencias_pendientes",
          organizationId: c.get("organizationId"),
          propertyId,
          clave: sesion.id,
          parametros: { cantidad: total },
          entidadTipo: "conciliacion_sesion",
          entidadId: sesion.id,
        });
        notificacion = n.estado;
      }
      await auditar(c, "despachos.conciliacion:sugerencias-llm", { sesionId: sesion.id, evaluados: calculo.movimientosSinConciliar.length, sugerencias: guardadas.length, sinSugerencia: resultado.sinSugerencia.length });
      return c.json(
        {
          sugerencias: guardadas,
          sinSugerencia: resultado.sinSugerencia.map((s) => ({ movimientoId: calculo.movimientosSinConciliar[s.movementIdx]!.id, razon: s.razon, mejorScoreEvaluado: s.mejorScoreEvaluado })),
          notificacion,
        },
        201,
      );
    } catch (err) {
      return traducirErrorConciliacionHttp(err);
    }
  });

  async function resolver(c: Context<CoreAuthHonoEnv>, aprobar: boolean) {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const id = exigirUuid(c.req.param("id"), "id");
    const propertyId = c.req.param("propertyId") ?? "";
    const repo = repoDe(c);
    try {
      const sug = await repo.obtenerSugerencia(propertyId, id);
      if (!sug) throw Errors.notFound("Sugerencia no encontrada.");
      const r = await repo.resolverSugerencia(propertyId, id, aprobar, c.get("userId"));
      await auditar(c, aprobar ? "despachos.conciliacion:sugerencia-aprobar" : "despachos.conciliacion:sugerencia-rechazar", { sugerenciaId: id, sesionId: sug.sesionId, matchId: r.matchId });
      return c.json({ estado: r.estado, matchId: r.matchId });
    } catch (err) {
      return traducirErrorConciliacionHttp(err);
    }
  }
  app.post("/despachos/:propertyId/conciliacion/sugerencias/:id/aprobar", (c) => resolver(c, true));
  app.post("/despachos/:propertyId/conciliacion/sugerencias/:id/rechazar", (c) => resolver(c, false));
}
