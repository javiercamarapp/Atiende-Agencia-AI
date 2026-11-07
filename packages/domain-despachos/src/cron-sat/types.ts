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

/** Destinatario de un aviso interno (staff owner/admin de la organización). */
export interface DestinatarioAvisoSistema {
  readonly email: string;
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
  upsertVencimientoSistema(propertyId: string, nuevo: Pick<NuevoVencimiento, "tipo" | "periodo" | "fechaLimite" | "prioridad">): Promise<{ readonly id: string; readonly creado: boolean; /** true = la base aun no admite ese tipo (CHECK sin la migracion 019/024): no se creo, el resto del cliente sigue. */ readonly omitido?: boolean }>;
  listarVencimientosPorEscalarSistema(propertyId: string, hoy: string): Promise<readonly VencimientoPorEscalar[]>;
  /** false = no hizo nada (completado, o ya tenia ese nivel o uno mayor). */
  escalarVencimientoSistema(deadlineId: string, nivel: NivelEscalamiento, notas: string): Promise<boolean>;
  /** D-P3-33: periodos 'YYYY-MM' que ya tienen algun vencimiento en la property (`null` = base sin la migracion 024). Sirve para rellenar el periodo anterior solo en clientes que ya corrian. */
  listarPeriodosVencimientosSistema(propertyId: string): Promise<readonly string[] | null>;
  /** D-P3-33: razon social del cliente para el asunto del correo interno (`null` = sin ficha o base sin la 024). */
  nombreClienteSistema(propertyId: string): Promise<string | null>;
  /** D-P3-33: staff owner/admin de la organizacion (funcion de la migracion 007; `[]` si la base no la tiene). */
  listarDestinatariosAvisoSistema(organizationId: string): Promise<readonly DestinatarioAvisoSistema[]>;
  /** D-P3-33: encola un correo en `despachos.messaging_outbox` (funcion de la migracion 005/007) con clave de dedupe; la supresion y el reintento los resuelve el despacho del outbox. `false` si la base no tiene el outbox. */
  encolarCorreoSistema(organizationId: string, evento: string, dedupeKey: string, payload: { readonly to: string; readonly subject: string; readonly html: string; readonly text: string }): Promise<boolean>;
}
