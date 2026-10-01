// Lector Postgres del catalogo de despachos. Corre sobre la sesion RLS del USUARIO (la misma de la
// request, `dbSession`): nunca una sesion de sistema ni service_role. Cada consulta va en un SAVEPOINT
// (`runWithSavepointFallback`): si la base real todavia no tiene una tabla/columna/funcion
// (SQLSTATE 42P01/42703/42883) se hace ROLLBACK TO SAVEPOINT y se lanza DataChatUnavailableError -- la
// transaccion compartida de la request NUNCA queda abortada (25P02) y el COMMIT no se convierte en ROLLBACK.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  DataChatUnavailableError,
  type AntiguedadRow,
  type CarteraClienteRow,
  type CargaClienteRow,
  type CfdiTipoRow,
  type CierrePendienteRow,
  type DespachosDataChatReader,
  type DespachosDataChatWindow,
  type EfosAlertaRow,
  type EfosAlertasResultado,
  type EfosSituacionAlerta,
  type IvaClienteRow,
  type ObligacionRow,
  type VisibleClient,
} from "./reader.ts";
import {
  SQL_CARGA_DE_TRABAJO,
  SQL_CARTERA_POR_CLIENTE,
  SQL_CFDI_POR_PERIODO,
  SQL_CIERRES_PENDIENTES,
  SQL_COBRANZA_ANTIGUEDAD,
  SQL_EFOS_AFECTADOS,
  SQL_EFOS_ESTADO,
  SQL_IVA_ACREDITABLE,
  SQL_OBLIGACIONES_FISCALES,
  SQL_VISIBLE_CLIENTS,
} from "./sql.ts";

const num = (v: unknown): number => Number(v ?? 0);

/** Tope de tiempo de cada consulta del chat (aplica al resto de la transaccion de la request). */
export const DATA_CHAT_STATEMENT_TIMEOUT_MS = 8_000;
/** Tope de clientes que se revisan contra la lista 69-B en UNA pregunta (cada uno es una llamada a la funcion). */
export const MAX_EFOS_CLIENTES = 40;

const EFOS_FN_PREFIX = "despachos.efos_";

export class PostgresDespachosDataChatReader implements DespachosDataChatReader {
  private timeoutApplied = false;

  constructor(private readonly db: TenantDbSession) {}

  private async query<R>(what: string, sql: string, params: unknown[], functionPrefix?: string): Promise<R[]> {
    if (!this.timeoutApplied) {
      this.timeoutApplied = true;
      // `set local`: solo vive en la transaccion de esta request; un tope de tiempo real en la base.
      await this.db.exec(`set local statement_timeout = ${DATA_CHAT_STATEMENT_TIMEOUT_MS}`);
    }
    return runWithSavepointFallback<R[]>({
      session: this.db,
      primary: async () => (await this.db.query<R>(sql, params)).rows,
      isRecoverable: (err) => isMigrationPendingError(err, functionPrefix),
      fallback: async () => {
        throw new DataChatUnavailableError(what);
      },
    });
  }

  private scope(w: DespachosDataChatWindow): unknown[] {
    return [w.organizationId, w.propertyIds ? [...w.propertyIds] : null];
  }

  async listVisibleClients(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleClient[]> {
    const rows = await this.query<{ property_id: string; name: string }>("clientes", SQL_VISIBLE_CLIENTS, [organizationId, propertyIds ? [...propertyIds] : null]);
    return rows.map((r) => ({ propertyId: r.property_id, name: r.name }));
  }

  async carteraPorCliente(w: DespachosDataChatWindow): Promise<readonly CarteraClienteRow[]> {
    const rows = await this.query<{ cliente: string; cuentas_pendientes: string; monto_pendiente: string; cuentas_vencidas: string; monto_vencido: string }>("cobranza", SQL_CARTERA_POR_CLIENTE, [...this.scope(w), w.hoy, w.limit]);
    return rows.map((r) => ({ cliente: r.cliente, cuentasPendientes: num(r.cuentas_pendientes), montoPendiente: num(r.monto_pendiente), cuentasVencidas: num(r.cuentas_vencidas), montoVencido: num(r.monto_vencido) }));
  }

  async antiguedadCobranza(w: DespachosDataChatWindow): Promise<readonly AntiguedadRow[]> {
    const rows = await this.query<{ bucket: string; cuentas: string; monto: string }>("cobranza", SQL_COBRANZA_ANTIGUEDAD, [...this.scope(w), w.hoy]);
    return rows.map((r) => ({ bucket: r.bucket, cuentas: num(r.cuentas), monto: num(r.monto) }));
  }

  async cfdiPorPeriodo(w: DespachosDataChatWindow): Promise<readonly CfdiTipoRow[]> {
    const rows = await this.query<{ tipo: string; cfdi: string; total: string; invalidos: string; en_revision: string }>("cfdi", SQL_CFDI_POR_PERIODO, [...this.scope(w), w.fromDate, w.toDate, w.limit]);
    return rows.map((r) => ({ tipo: r.tipo, cfdi: num(r.cfdi), total: num(r.total), invalidos: num(r.invalidos), enRevision: num(r.en_revision) }));
  }

  async ivaAcreditable(w: DespachosDataChatWindow): Promise<readonly IvaClienteRow[]> {
    const rows = await this.query<{ cliente: string; cfdi: string; base: string; iva_acreditable: string }>("cfdi", SQL_IVA_ACREDITABLE, [...this.scope(w), w.fromDate, w.toDate, w.limit]);
    return rows.map((r) => ({ cliente: r.cliente, cfdi: num(r.cfdi), base: num(r.base), ivaAcreditable: num(r.iva_acreditable) }));
  }

  async obligacionesFiscales(w: DespachosDataChatWindow): Promise<readonly ObligacionRow[]> {
    const rows = await this.query<{ cliente: string; tipo: string; periodo: string; fecha_limite: string; estado: string; prioridad: string }>("vencimientos", SQL_OBLIGACIONES_FISCALES, [
      ...this.scope(w),
      w.fromDate,
      w.toDate,
      w.hoy,
      w.limit,
    ]);
    return rows.map((r) => ({ cliente: r.cliente, tipo: r.tipo, periodo: r.periodo, fechaLimite: r.fecha_limite, estado: r.estado, prioridad: r.prioridad }));
  }

  async cierresPendientes(w: DespachosDataChatWindow): Promise<readonly CierrePendienteRow[]> {
    const rows = await this.query<{ cliente: string; anio: number; mes: number; status: string; tareas_total: string; tareas_pendientes: string; tareas_vencidas: string }>("cierre mensual", SQL_CIERRES_PENDIENTES, [...this.scope(w), w.hoy, w.limit]);
    return rows.map((r) => ({ cliente: r.cliente, anio: num(r.anio), mes: num(r.mes), status: r.status, tareasTotal: num(r.tareas_total), tareasPendientes: num(r.tareas_pendientes), tareasVencidas: num(r.tareas_vencidas) }));
  }

  async cargaDeTrabajo(w: DespachosDataChatWindow): Promise<readonly CargaClienteRow[]> {
    const rows = await this.query<{ cliente: string; revisiones_pendientes: string; vencimientos_abiertos: string; vencimientos_vencidos: string; tareas_cierre_pendientes: string }>("carga de trabajo", SQL_CARGA_DE_TRABAJO, [...this.scope(w), w.hoy, w.limit]);
    return rows.map((r) => ({
      cliente: r.cliente,
      revisionesPendientes: num(r.revisiones_pendientes),
      vencimientosAbiertos: num(r.vencimientos_abiertos),
      vencimientosVencidos: num(r.vencimientos_vencidos),
      tareasCierrePendientes: num(r.tareas_cierre_pendientes),
    }));
  }

  async efosAlertas(clients: readonly VisibleClient[]): Promise<EfosAlertasResultado> {
    const revisados = clients.slice(0, MAX_EFOS_CLIENTES);
    const truncado = clients.length > revisados.length;
    const estado = await this.query<{ out_periodo: string }>("lista 69-B", SQL_EFOS_ESTADO, [], EFOS_FN_PREFIX).catch((err: unknown) => {
      if (err instanceof DataChatUnavailableError) return null;
      throw err;
    });
    // Sin lista cargada (o sin la migracion): NUNCA se informa "sin riesgo".
    if (estado === null || estado.length === 0) return { estado: "no_disponible", periodoLista: null, alertas: [], truncado };

    const grupos = new Map<string, { cliente: string; rfc: string; nombre: string | null; situacion: EfosSituacionAlerta; cfdi: number; total: number }>();
    for (const c of revisados) {
      const rows = await this.query<{ out_rfc_emisor: string; out_emisor_nombre: string | null; out_fecha: string; out_total: string; out_situacion: string; out_periodo_lista: string }>(
        "lista 69-B",
        SQL_EFOS_AFECTADOS,
        [c.propertyId],
        EFOS_FN_PREFIX,
      );
      for (const r of rows) {
        const situacion: EfosSituacionAlerta = r.out_situacion === "definitivo" ? "definitivo" : "presunto";
        const key = `${c.propertyId}|${r.out_rfc_emisor}|${situacion}`;
        const g = grupos.get(key) ?? { cliente: c.name, rfc: r.out_rfc_emisor, nombre: r.out_emisor_nombre, situacion, cfdi: 0, total: 0 };
        g.cfdi += 1;
        g.total += num(r.out_total);
        grupos.set(key, g);
      }
    }
    const alertas: EfosAlertaRow[] = [...grupos.values()]
      .map((g) => ({ cliente: g.cliente, rfcEmisor: g.rfc, emisorNombre: g.nombre, situacion: g.situacion, cfdi: g.cfdi, total: g.total }))
      .sort((a, b) => (a.situacion === b.situacion ? b.total - a.total : a.situacion === "definitivo" ? -1 : 1));
    return { estado: "disponible", periodoLista: estado[0]!.out_periodo, alertas, truncado };
  }
}
