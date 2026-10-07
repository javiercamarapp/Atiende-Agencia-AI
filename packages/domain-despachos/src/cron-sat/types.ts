// Repositorio de SOLO SISTEMA de los crons de despachos (D-26/D-27/D-28, migracion 022). Cada metodo envuelve UNA funcion SQL
// `despachos.system_*` (security definer, `auth.uid() is null`): corren como sesion de sistema y nunca desde un request de staff.
//
// Contrato de compatibilidad con la base sin migrar: los metodos de LECTURA devuelven `null` cuando la funcion no existe (42883/42P01/
// 42703, dentro de un SAVEPOINT) = "no disponible aun"; los de ESCRITURA lanzan `CronSatNoDisponibleError` (el cron lo reporta
// como estado "no_disponible", nunca como un 500 ni como un barrido vacio fingido).
import type { EstadoSatCfdi } from "../cfdi/modelo-cfdi.ts";
import type { NivelEscalamiento, NuevoVencimiento } from "../vencimientos/engine.ts";

export class CronSatNoDisponibleError extends Error {
  constructor() {
    super("Los crons de despachos requieren la migracion 022.");
    this.name = "CronSatNoDisponibleError";
  }
}

export interface CfdiPendienteEstatusSat {
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioFiscal: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  /** Total en pesos (numeric(14,2)). */
  readonly total: number;
  readonly estadoSat: EstadoSatCfdi;
  /** 0 nunca consultado, 1 cancelacion «En proceso», 2 reciente, 3 vigente dentro de la ventana (027). Ausente con la base sin migrar. */
  readonly prioridad?: number;
}

/** Detalle que responde el SAT ademas del estado (paridad3 D-P3-19): se persiste tal cual, acotado a 80/200 caracteres. */
export interface DetalleEstatusSat {
  readonly esCancelable: string | null;
  readonly estatusCancelacion: string | null;
  readonly codigoEstatus: string | null;
  readonly validacionEfos: string | null;
}

export interface RegistroEstatusSat {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly estadoAnterior: EstadoSatCfdi;
  readonly estadoNuevo: EstadoSatCfdi;
  /** true solo la PRIMERA vez que el CFDI pasa a cancelado (el estado es terminal). */
  readonly cambioACancelado: boolean;
  /** true solo la PRIMERA vez que el SAT reporta la cancelacion «En proceso» (el receptor tiene 72 h para aceptar o rechazar). */
  readonly cancelacionEnProcesoNueva: boolean;
}

export interface EfosAfectadoSistema {
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly situacion: "presunto" | "definitivo";
}

export interface ClienteFichaSistema {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly regimenes: readonly string[];
  readonly zonaHoraria: string | null;
}

export interface VencimientoPorEscalar {
  readonly id: string;
  readonly tipo: string;
  readonly periodo: string;
  readonly fechaLimite: string;
  readonly prioridad: string;
  readonly nivelMax: NivelEscalamiento | null;
}

export interface CronSatRepository {
  /**
   * CFDI por verificar ante el SAT, por prioridad (nunca consultados, cancelacion «En proceso», recientes, vigentes dentro de la ventana de
   * ejercicios) con tope por cliente (`null` = base sin migrar). Con la base sin la migracion 027 cae al orden anterior (mas antiguos primero).
   */
  listarCfdiPendientesEstatusSat(limite: number, reintentoDias: number, ventanaEjercicios?: number, porProperty?: number): Promise<readonly CfdiPendienteEstatusSat[] | null>;
  /** Registra el resultado de UNA consulta. `pendiente` solo anota el intento (no pisa un estado verificado). Sin 027 no guarda el detalle. */
  registrarEstatusSatSistema(invoiceId: string, estado: EstadoSatCfdi, detalle?: DetalleEstatusSat): Promise<RegistroEstatusSat>;
  /** CFDI ya ingeridos de cualquier cliente cuyo emisor figura como presunto/definitivo en la edicion mas reciente (`null` = sin migrar). */
  listarEfosAfectadosSistema(limite: number): Promise<readonly EfosAfectadoSistema[] | null>;
  /** Clientes (properties activas) con ficha de cliente (`null` = sin migrar). */
  listarClientesFichaSistema(limite: number): Promise<readonly ClienteFichaSistema[] | null>;
  /** Crea (o corrige, si sigue pendiente) un vencimiento. Idempotente. */
  upsertVencimientoSistema(propertyId: string, nuevo: Pick<NuevoVencimiento, "tipo" | "periodo" | "fechaLimite" | "prioridad">): Promise<{ readonly id: string; readonly creado: boolean }>;
  listarVencimientosPorEscalarSistema(propertyId: string, hoy: string): Promise<readonly VencimientoPorEscalar[]>;
  /** false = no hizo nada (completado, o ya tenia ese nivel o uno mayor). */
  escalarVencimientoSistema(deadlineId: string, nivel: NivelEscalamiento, notas: string): Promise<boolean>;
}
