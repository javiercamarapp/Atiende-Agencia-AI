// Lector Postgres del catalogo de licitaciones. Corre sobre la sesion RLS del USUARIO (la misma de la
// request, `dbSession`): nunca una sesion de sistema ni service_role. Cada consulta va en un SAVEPOINT
// (`runWithSavepointFallback`): si la base real todavia no tiene una tabla/columna (SQLSTATE
// 42P01/42703/42883) se hace ROLLBACK TO SAVEPOINT y se lanza DataChatUnavailableError -- la transaccion
// compartida de la request NUNCA queda abortada (25P02) y el COMMIT no se convierte en ROLLBACK.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  DataChatUnavailableError,
  type ConvocatoriaAbiertaRow,
  type FalloRow,
  type GoNoGoRow,
  type LicitacionesDataChatReader,
  type LicitacionesDataChatWindow,
  type PropuestaEstadoRow,
  type RenovacionRow,
  type SemaforoRow,
} from "./reader.ts";
import { SQL_CONVOCATORIAS_ABIERTAS, SQL_FALLOS, SQL_GO_NO_GO, SQL_ORG_TIMEZONE, SQL_PLAZOS_SEMAFORO, SQL_PROPUESTAS_POR_ESTADO, SQL_RENOVACIONES } from "./sql.ts";

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Tope de tiempo de cada consulta del chat (aplica al resto de la transaccion de la request). */
export const DATA_CHAT_STATEMENT_TIMEOUT_MS = 8_000;

export class PostgresLicitacionesDataChatReader implements LicitacionesDataChatReader {
  private timeoutApplied = false;

  constructor(private readonly db: TenantDbSession) {}

  private async query<R>(what: string, sql: string, params: unknown[]): Promise<R[]> {
    if (!this.timeoutApplied) {
      this.timeoutApplied = true;
      // `set local`: solo vive en la transaccion de esta request; un tope de tiempo real en la base.
      await this.db.exec(`set local statement_timeout = ${DATA_CHAT_STATEMENT_TIMEOUT_MS}`);
    }
    return runWithSavepointFallback<R[]>({
      session: this.db,
      primary: async () => (await this.db.query<R>(sql, params)).rows,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        throw new DataChatUnavailableError(what);
      },
    });
  }

  async organizationTimezone(organizationId: string): Promise<string | null> {
    try {
      const rows = await this.query<{ timezone: string | null }>("zona horaria", SQL_ORG_TIMEZONE, [organizationId, 1]);
      return rows[0]?.timezone ?? null;
    } catch (err) {
      // Sin tenant_config (base sin migrar) la zona cae al default de plataforma: nunca un error.
      if (err instanceof DataChatUnavailableError) return null;
      throw err;
    }
  }

  async convocatoriasAbiertas(w: LicitacionesDataChatWindow, venceEnDias: number | null): Promise<readonly ConvocatoriaAbiertaRow[]> {
    const rows = await this.query<{ titulo: string; dependencia: string | null; entidad: string | null; status: string; fecha_limite: string | null; dias_restantes: string | number | null; monto_mxn: string | null; moneda: string }>(
      "convocatorias",
      SQL_CONVOCATORIAS_ABIERTAS,
      [w.organizationId, w.timezone, w.ahora.toISOString(), venceEnDias, w.limit],
    );
    return rows.map((r) => ({ titulo: r.titulo, dependencia: r.dependencia, entidad: r.entidad, status: r.status, fechaLimite: r.fecha_limite, diasRestantes: numOrNull(r.dias_restantes), montoMxn: numOrNull(r.monto_mxn), moneda: r.moneda }));
  }

  async plazosSemaforo(w: LicitacionesDataChatWindow): Promise<readonly SemaforoRow[]> {
    const rows = await this.query<{ semaforo: string; convocatorias: string }>("convocatorias", SQL_PLAZOS_SEMAFORO, [w.organizationId, w.timezone, w.ahora.toISOString(), w.limit]);
    return rows.map((r) => ({ semaforo: r.semaforo, convocatorias: num(r.convocatorias) }));
  }

  async goNoGo(w: LicitacionesDataChatWindow): Promise<readonly GoNoGoRow[]> {
    const rows = await this.query<{ titulo: string; decision: "go" | "no_go"; elegibilidad: string; puntaje: string; fecha: string; motivo: string | null }>("go/no-go", SQL_GO_NO_GO, [
      w.organizationId,
      w.timezone,
      w.desde.toISOString(),
      w.hasta.toISOString(),
      w.limit,
    ]);
    return rows.map((r) => ({ titulo: r.titulo, decision: r.decision, elegibilidad: r.elegibilidad, puntaje: num(r.puntaje), fecha: r.fecha, motivo: r.motivo }));
  }

  async propuestasPorEstado(w: LicitacionesDataChatWindow): Promise<readonly PropuestaEstadoRow[]> {
    const rows = await this.query<{ status: string; propuestas: string; presentadas: string }>("propuestas", SQL_PROPUESTAS_POR_ESTADO, [w.organizationId, w.limit]);
    return rows.map((r) => ({ status: r.status, propuestas: num(r.propuestas), presentadas: num(r.presentadas) }));
  }

  async fallos(w: LicitacionesDataChatWindow): Promise<readonly FalloRow[]> {
    const rows = await this.query<{ titulo: string; dependencia: string | null; resultado: "won" | "lost"; fecha: string; monto_mxn: string | null }>("fallos", SQL_FALLOS, [
      w.organizationId,
      w.timezone,
      w.desde.toISOString(),
      w.hasta.toISOString(),
      w.limit,
    ]);
    return rows.map((r) => ({ titulo: r.titulo, dependencia: r.dependencia, resultado: r.resultado, fecha: r.fecha, montoMxn: numOrNull(r.monto_mxn) }));
  }

  async renovaciones(w: LicitacionesDataChatWindow, horizonteDias: number): Promise<readonly RenovacionRow[]> {
    const rows = await this.query<{
      contrato: string | null;
      titulo: string;
      dependencia: string | null;
      fin_vigencia: string;
      dias_restantes: string | number;
      opcion_renovacion: boolean;
      status: string;
      alerta_pendiente: boolean;
    }>("contratos", SQL_RENOVACIONES, [w.organizationId, w.timezone, w.ahora.toISOString(), horizonteDias, w.limit]);
    return rows.map((r) => ({
      contrato: r.contrato,
      titulo: r.titulo,
      dependencia: r.dependencia,
      finVigencia: r.fin_vigencia,
      diasRestantes: num(r.dias_restantes),
      opcionRenovacion: r.opcion_renovacion,
      status: r.status,
      alertaPendiente: r.alerta_pendiente,
    }));
  }
}
