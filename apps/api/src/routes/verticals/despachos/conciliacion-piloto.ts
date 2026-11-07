// D-P3-12 -- piloto automático de la conciliación. Al GUARDAR un estado de cuenta (`importar-estado-de-cuenta/guardar`) el servidor deja la conciliación lista sin que nadie
// haga clic:
//   1. crea la sesión del periodo y la cuenta si no existe (idempotente: `conciliacion_sesion_asegurar`, migración 025);
//   2. corre el motor y GUARDA las propuestas en la sesión;
//   3. con la bandera del cliente `conciliacion_autoconfirmar_nivel1` (APAGADA por omisión, decisión de Javier) confirma SOLO los pares de nivel 1 ÚNICOS (sin otro candidato para el
//      movimiento ni para el CFDI, dirección explícita) con origen `autopiloto`; queda en bitácora con actor «sistema» y se puede deshacer con motivo como cualquier match. Nunca
//      autoconfirma grupos, nivel 2 ni sugerencias de IA;
//   4. emite `despachos.conciliacion.propuestas_por_revisar` (una campana por sesión) si queda algo por revisar;
//   5. si hay gateway de IA, intenta las sugerencias de nivel 4 acotadas (best-effort: sin gateway, sin presupuesto o ante cualquier fallo del proveedor NO hace nada y NO falla); las
//      sugerencias quedan PENDIENTES de aprobación humana y emiten `despachos.conciliacion.sugerencias_pendientes`.
// Todo el paso corre dentro de un SAVEPOINT: el archivo ya quedó guardado y NADA de lo anterior puede revertirlo ni responder un 500. Contra una base sin las migraciones 021/025
// responde `estado: "no_disponible"`.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import {
  ConciliacionNoDisponibleError,
  ConciliacionNoEncontradaError,
  ConciliacionSinPermisoError,
  seleccionarAutoconfirmables,
  sugerirMatchesLLM,
} from "@atiende/domain-despachos";
import type { ConciliacionPersistidaRepository, DespachosRole, MovimientoGuardado, ParAutoconfirmable, PropuestasGuardadas, RegistroConciliable, ResultadoPropuestas, SesionConciliacion } from "@atiende/domain-despachos";
import type { AppDeps } from "../../../deps.ts";

/** Techo de periodos que un solo archivo dispara (un estado de cuenta normal trae 1 o 2). */
export const MAX_PERIODOS_PILOTO = 12;
/** Techo de movimientos que el piloto manda al modelo por sesión (el botón manual permite 25; el automático es más conservador: cuesta sin que nadie lo pida). */
export const MAX_MOVIMIENTOS_LLM_PILOTO = 10;
/** Plazo GLOBAL de toda la fase de IA del piloto (no por periodo): vercel.json fija maxDuration 30 s para la función y el guardado del archivo sigue sin COMMIT mientras se espera. Pasado el plazo se aborta la llamada al proveedor y el archivo se responde igual. */
export const PLAZO_FASE_IA_PILOTO_MS = 8_000;
const TAMANO_LOTE_AUTOPILOTO = 25;

export interface DatosPiloto {
  readonly movimientosLibres: readonly MovimientoGuardado[];
  readonly registrosLibres: readonly RegistroConciliable[];
  readonly sugerencias: readonly { readonly estado: string; readonly movimientoId: string; readonly invoiceId: string }[];
}

export interface DependenciasPiloto<D extends DatosPiloto> {
  readonly deps: AppDeps;
  readonly repoDe: (c: Context<CoreAuthHonoEnv>) => ConciliacionPersistidaRepository;
  readonly cargarDatos: (c: Context<CoreAuthHonoEnv>, repo: ConciliacionPersistidaRepository, sesion: SesionConciliacion) => Promise<D>;
  readonly refrescarPropuestas: (c: Context<CoreAuthHonoEnv>, repo: ConciliacionPersistidaRepository, sesion: SesionConciliacion, d?: D) => Promise<{ readonly datos: D; readonly calculo: ResultadoPropuestas; readonly guardables: PropuestasGuardadas; readonly guardado: boolean }>;
  readonly exigirPeriodoAbierto: (c: Context<CoreAuthHonoEnv>, sesion: SesionConciliacion) => Promise<void>;
  readonly auditar: (c: Context<CoreAuthHonoEnv>, action: string, metadata: Record<string, unknown>) => Promise<void>;
}

export interface ResumenSesionPiloto {
  readonly sesionId: string;
  readonly periodo: string;
  readonly creada: boolean;
  readonly propuestas: number;
  readonly ambiguas: number;
  readonly autoconfirmados: number;
  readonly autoconfirmacionOmitida: number;
  readonly sugerenciasIA: number;
}

export interface ResumenPiloto {
  /** `no_disponible`: la base aún no tiene las migraciones 021/025. `error`: el piloto falló y se revirtió SIN afectar el archivo ya guardado. */
  readonly estado: "ok" | "no_disponible" | "error";
  readonly autoconfirmarNivel1: boolean;
  readonly sesiones: readonly ResumenSesionPiloto[];
}

export interface PilotoConciliacion {
  leerConfiguracion(c: Context<CoreAuthHonoEnv>, propertyId: string): Promise<{ readonly autoconfirmarNivel1: boolean }>;
  configurar(c: Context<CoreAuthHonoEnv>, propertyId: string, activo: boolean): Promise<{ readonly autoconfirmarNivel1: boolean }>;
  trasImportar(c: Context<CoreAuthHonoEnv>, entrada: { readonly propertyId: string; readonly cuenta: string | null; readonly periodos: readonly string[] }): Promise<ResumenPiloto>;
}

export function crearPilotoConciliacion<D extends DatosPiloto>(p: DependenciasPiloto<D>): PilotoConciliacion {
  const { deps, repoDe } = p;

  async function autoconfirmar(c: Context<CoreAuthHonoEnv>, repo: ConciliacionPersistidaRepository, sesion: SesionConciliacion, pares: readonly ParAutoconfirmable[]): Promise<{ confirmados: number; omitidos: number }> {
    if (pares.length === 0) return { confirmados: 0, omitidos: 0 };
    try {
      await p.exigirPeriodoAbierto(c, sesion);
    } catch {
      return { confirmados: 0, omitidos: pares.length }; // periodo cerrado: el piloto no toca un periodo cerrado
    }
    const matchIds: string[] = [];
    let omitidos = 0;
    for (let i = 0; i < pares.length; i += TAMANO_LOTE_AUTOPILOTO) {
      const lote = pares.slice(i, i + TAMANO_LOTE_AUTOPILOTO);
      try {
        const m = await repo.confirmarAutopiloto(sesion.propertyId, sesion.id, lote, c.get("userId"));
        matchIds.push(...m.map((x) => x.id));
      } catch (err) {
        if (err instanceof ConciliacionNoDisponibleError) throw err;
        // Un par inválido (tope del CFDI, signo, periodo...) no frena a los demás: el lote es todo-o-nada, así que se reintenta par por par.
        for (const par of lote) {
          try {
            const m = await repo.confirmarAutopiloto(sesion.propertyId, sesion.id, [par], c.get("userId"));
            matchIds.push(...m.map((x) => x.id));
          } catch (errPar) {
            if (errPar instanceof ConciliacionNoDisponibleError) throw errPar;
            omitidos += 1;
          }
        }
      }
    }
    if (matchIds.length > 0) {
      // Actor «sistema»: lo decidió el piloto; el humano que subió el archivo queda como `disparadoPor` (y en `confirmado_por` de la base). Sin PII: ids y conteos.
      await deps.despachosAuditSink.record({
        at: new Date().toISOString(),
        actorUserId: null,
        actorEmail: "sistema",
        organizationId: c.get("organizationId"),
        action: "despachos.conciliacion:autopiloto-confirmar",
        route: c.req.path,
        method: c.req.method,
        decision: "allowed",
        metadata: { actor: "sistema", disparadoPor: c.get("userId"), sesionId: sesion.id, pares: matchIds.length, omitidos, matchIds },
      });
    }
    return { confirmados: matchIds.length, omitidos };
  }

  /** Sugerencias de nivel 4, best-effort. Nunca lanza. */
  async function sugerirConIA(c: Context<CoreAuthHonoEnv>, repo: ConciliacionPersistidaRepository, sesion: SesionConciliacion, calculo: ResultadoPropuestas, d: D, signal: AbortSignal): Promise<number> {
    const gateway = deps.llmGateway;
    if (!gateway || calculo.movimientosSinConciliar.length === 0) return 0;
    const conPendiente = new Set(d.sugerencias.filter((g) => g.estado === "pendiente").map((g) => g.movimientoId));
    const cfdiConPendiente = new Set(d.sugerencias.filter((g) => g.estado === "pendiente").map((g) => g.invoiceId));
    const movimientos = calculo.movimientosSinConciliar.filter((m) => !conPendiente.has(m.id));
    const registros = calculo.registrosSinConciliar.filter((r) => !cfdiConPendiente.has(r.id));
    if (movimientos.length === 0 || registros.length === 0) return 0;
    try {
      // La señal cancela la petición al proveedor; la carrera además suelta la espera si un gateway la ignora.
      const llamada = sugerirMatchesLLM(gateway, movimientos, registros, {
        tenantId: c.get("organizationId"),
        actor: { actorId: c.get("userId"), actorRole: c.get("verticalRole") as DespachosRole },
        maxMovimientos: MAX_MOVIMIENTOS_LLM_PILOTO,
        signal,
      }).catch(() => null);
      const abortada = new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      const resultado = await Promise.race([llamada, abortada]);
      if (signal.aborted || resultado === null || resultado.sugerencias.length === 0) return 0;
      const guardadas = await repo.guardarSugerencias(
        sesion.propertyId,
        sesion.id,
        resultado.sugerencias.map((s) => ({ movimientoId: movimientos[s.movementIdx]!.id, invoiceId: registros[s.registroIdx]!.id, confianza: s.score, razon: s.detail })),
        c.get("userId"),
      );
      if (guardadas.length > 0) {
        const total = d.sugerencias.filter((g) => g.estado === "pendiente").length + guardadas.length;
        await emitirNotificacion(c.get("db"), {
          evento: "despachos.conciliacion.sugerencias_pendientes",
          organizationId: c.get("organizationId"),
          propertyId: sesion.propertyId,
          clave: sesion.id,
          parametros: { cantidad: total },
          entidadTipo: "conciliacion_sesion",
          entidadId: sesion.id,
        });
      }
      return guardadas.length;
    } catch {
      return 0; // sin presupuesto, proveedor caído o base sin migrar: el piloto no hace nada y no falla
    }
  }

  interface PeriodoProcesado {
    readonly resumen: ResumenSesionPiloto;
    readonly sesion: SesionConciliacion;
    readonly calculo: ResultadoPropuestas;
    readonly datos: D;
  }

  async function procesarPeriodo(c: Context<CoreAuthHonoEnv>, repo: ConciliacionPersistidaRepository, propertyId: string, periodo: string, cuenta: string | null, activo: boolean): Promise<PeriodoProcesado | null> {
    let aseg;
    try {
      aseg = await repo.asegurarSesion(propertyId, periodo, cuenta, c.get("userId"));
    } catch (err) {
      if (err instanceof ConciliacionNoEncontradaError) return null; // el periodo no quedó con movimientos guardados (archivo con todo ya importado antes)
      throw err;
    }
    let refresco = await p.refrescarPropuestas(c, repo, aseg.sesion);
    let autoconfirmados = 0;
    let omitidos = 0;
    if (activo && refresco.calculo.propuestas.length > 0) {
      const pares = seleccionarAutoconfirmables(refresco.calculo.propuestas, refresco.datos.movimientosLibres, refresco.datos.registrosLibres);
      const r = await autoconfirmar(c, repo, aseg.sesion, pares);
      autoconfirmados = r.confirmados;
      omitidos = r.omitidos;
      if (r.confirmados > 0) refresco = await p.refrescarPropuestas(c, repo, aseg.sesion);
    }
    const porRevisar = refresco.calculo.propuestas.length + refresco.calculo.ambiguas.length + refresco.calculo.multiLinea.length;
    if (porRevisar > 0) {
      await emitirNotificacion(c.get("db"), {
        evento: "despachos.conciliacion.propuestas_por_revisar",
        organizationId: c.get("organizationId"),
        propertyId,
        clave: aseg.sesion.id,
        parametros: { cantidad: porRevisar },
        entidadTipo: "conciliacion_sesion",
        entidadId: aseg.sesion.id,
      });
    }
    return {
      sesion: aseg.sesion,
      calculo: refresco.calculo,
      datos: refresco.datos,
      resumen: {
        sesionId: aseg.sesion.id,
        periodo,
        creada: aseg.creada,
        propuestas: refresco.calculo.propuestas.length,
        ambiguas: refresco.calculo.ambiguas.length,
        autoconfirmados,
        autoconfirmacionOmitida: omitidos,
        sugerenciasIA: 0,
      },
    };
  }

  return {
    async leerConfiguracion(c, propertyId) {
      return { autoconfirmarNivel1: await repoDe(c).autoconfirmarNivel1Activo(propertyId) };
    },

    async configurar(c, propertyId, activo) {
      const repo = repoDe(c);
      const ok = await repo.configurarAutoconfirmarNivel1(propertyId, c.get("organizationId"), activo, c.get("userId"));
      if (!ok) throw new ConciliacionSinPermisoError();
      await p.auditar(c, "despachos.conciliacion:piloto-configurar", { autoconfirmarNivel1: activo });
      return { autoconfirmarNivel1: activo };
    },

    async trasImportar(c, entrada) {
      const repo = repoDe(c);
      const periodos = [...new Set(entrada.periodos)].sort().slice(0, MAX_PERIODOS_PILOTO);
      const sinEfecto: ResumenPiloto = { estado: "no_disponible", autoconfirmarNivel1: false, sesiones: [] };
      let procesados: PeriodoProcesado[] = [];
      let activo = false;
      const nucleo = await runWithSavepointFallback<ResumenPiloto>({
        session: c.get("db"),
        savepointName: "sp_conc_piloto",
        primary: async () => {
          activo = await repo.autoconfirmarNivel1Activo(entrada.propertyId);
          for (const periodo of periodos) {
            const r = await procesarPeriodo(c, repo, entrada.propertyId, periodo, entrada.cuenta, activo);
            if (r) procesados.push(r);
          }
          return { estado: "ok", autoconfirmarNivel1: activo, sesiones: procesados.map((x) => x.resumen) };
        },
        // Cualquier fallo del piloto se revierte a su savepoint: el estado de cuenta ya guardado en esta transacción sobrevive y la respuesta no es un 500.
        isRecoverable: () => true,
        fallback: async (err) => {
          procesados = [];
          return err instanceof ConciliacionNoDisponibleError ? sinEfecto : { estado: "error", autoconfirmarNivel1: activo, sesiones: [] };
        },
      });
      if (nucleo.estado !== "ok" || deps.llmGateway === undefined) return nucleo;
      // Nivel 4 (IA): best-effort fuera del núcleo; cada escritura abre su propio savepoint y nada de aquí puede fallar la respuesta.
      // Un solo plazo global y solo la sesión más reciente (la que el usuario mira al terminar): una espera por periodo pasaría el maxDuration de Vercel y revertiría el archivo.
      const reciente = procesados[procesados.length - 1];
      if (!reciente) return nucleo;
      const control = new AbortController();
      const temporizador = setTimeout(() => control.abort(), PLAZO_FASE_IA_PILOTO_MS);
      let sugerenciasIA = 0;
      try {
        sugerenciasIA = await sugerirConIA(c, repo, reciente.sesion, reciente.calculo, reciente.datos, control.signal);
      } finally {
        clearTimeout(temporizador);
      }
      return { ...nucleo, sesiones: procesados.map((x) => (x === reciente ? { ...x.resumen, sugerenciasIA } : x.resumen)) };
    },
  };
}
