// Puerto de lectura del catalogo de despachos: el catalogo (catalog.ts) solo habla con esto, nunca con
// SQL. Implementaciones: Postgres (postgres-reader.ts, sesion RLS del usuario) y dobles de prueba.
// En despachos un "cliente" es el contribuyente que atiende el despacho (una `core.property`).

export interface DespachosDataChatWindow {
  readonly organizationId: string;
  /** null = todos los clientes de la organizacion. Lo fija el SERVIDOR (membership), no el modelo. */
  readonly propertyIds: readonly string[] | null;
  /** Primer dia local inclusive AAAA-MM-DD (solo las consultas con periodo). */
  readonly fromDate: string;
  /** Ultimo dia local inclusive AAAA-MM-DD. */
  readonly toDate: string;
  /** Fecha de hoy en la zona del negocio AAAA-MM-DD. */
  readonly hoy: string;
  /** Tope de filas (el catalogo pide maxRows + 1 para detectar truncamiento). */
  readonly limit: number;
}

export interface VisibleClient {
  readonly propertyId: string;
  readonly name: string;
}

export interface CarteraClienteRow {
  readonly cliente: string;
  readonly cuentasPendientes: number;
  readonly montoPendiente: number;
  readonly cuentasVencidas: number;
  readonly montoVencido: number;
}
export interface AntiguedadRow { readonly bucket: string; readonly cuentas: number; readonly monto: number }
export interface CfdiTipoRow { readonly tipo: string; readonly cfdi: number; readonly total: number; readonly invalidos: number; readonly enRevision: number }
export interface IvaClienteRow { readonly cliente: string; readonly cfdi: number; readonly base: number; readonly ivaAcreditable: number }
export interface ObligacionRow {
  readonly cliente: string;
  readonly tipo: string;
  readonly periodo: string;
  readonly fechaLimite: string;
  readonly estado: string;
  readonly prioridad: string;
}
export interface CierrePendienteRow {
  readonly cliente: string;
  readonly anio: number;
  readonly mes: number;
  readonly status: string;
  readonly tareasTotal: number;
  readonly tareasPendientes: number;
  readonly tareasVencidas: number;
}
export interface CargaClienteRow {
  readonly cliente: string;
  readonly revisionesPendientes: number;
  readonly vencimientosAbiertos: number;
  readonly vencimientosVencidos: number;
  readonly tareasCierrePendientes: number;
}

export type EfosSituacionAlerta = "presunto" | "definitivo";
export interface EfosAlertaRow {
  readonly cliente: string;
  readonly rfcEmisor: string;
  readonly emisorNombre: string | null;
  readonly situacion: EfosSituacionAlerta;
  readonly cfdi: number;
  readonly total: number;
}
export interface EfosAlertasResultado {
  /** "no_disponible" = la lista 69-B aun no esta cargada (o la base no tiene la migracion): NUNCA "sin riesgo". */
  readonly estado: "disponible" | "no_disponible";
  readonly periodoLista: string | null;
  readonly alertas: readonly EfosAlertaRow[];
  /** true si hubo mas clientes que el tope por consulta (no se revisaron todos). */
  readonly truncado: boolean;
}

/** La base todavia no tiene la tabla/columna/funcion (migracion pendiente): honesto, no un 500. */
export class DataChatUnavailableError extends Error {
  constructor(readonly what: string) {
    super(`data_chat_unavailable:${what}`);
    this.name = "DataChatUnavailableError";
  }
}

export interface DespachosDataChatReader {
  listVisibleClients(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleClient[]>;
  carteraPorCliente(w: DespachosDataChatWindow): Promise<readonly CarteraClienteRow[]>;
  antiguedadCobranza(w: DespachosDataChatWindow): Promise<readonly AntiguedadRow[]>;
  cfdiPorPeriodo(w: DespachosDataChatWindow): Promise<readonly CfdiTipoRow[]>;
  ivaAcreditable(w: DespachosDataChatWindow): Promise<readonly IvaClienteRow[]>;
  obligacionesFiscales(w: DespachosDataChatWindow): Promise<readonly ObligacionRow[]>;
  cierresPendientes(w: DespachosDataChatWindow): Promise<readonly CierrePendienteRow[]>;
  cargaDeTrabajo(w: DespachosDataChatWindow): Promise<readonly CargaClienteRow[]>;
  /** Alertas de la lista 69-B del SAT para los clientes dados (ya filtrados por alcance por el catalogo). */
  efosAlertas(clients: readonly VisibleClient[]): Promise<EfosAlertasResultado>;
}
