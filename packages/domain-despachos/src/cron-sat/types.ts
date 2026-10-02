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
}

export interface RegistroEstatusSat {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly estadoAnterior: EstadoSatCfdi;
  readonly estadoNuevo: EstadoSatCfdi;
  /** true solo la PRIMERA vez que el CFDI pasa a cancelado (el estado es terminal). */
  readonly cambioACancelado: boolean;
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
  /** CFDI por verificar ante el SAT, los mas antiguos primero (`null` = base sin migrar). */
  listarCfdiPendientesEstatusSat(limite: number, reintentoDias: number): Promise<readonly CfdiPendienteEstatusSat[] | null>;
  /** Registra el resultado de UNA consulta. `pendiente` solo anota el intento (no pisa un estado verificado). */
  registrarEstatusSatSistema(invoiceId: string, estado: EstadoSatCfdi): Promise<RegistroEstatusSat>;
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
