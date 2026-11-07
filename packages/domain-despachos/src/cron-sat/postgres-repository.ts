import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { EstadoSatCfdi } from "../cfdi/modelo-cfdi.ts";
import { TIPOS_VENCIMIENTO_BASE } from "../vencimientos/engine.ts";
import type { NivelEscalamiento, TipoVencimiento } from "../vencimientos/engine.ts";
import { CronSatNoDisponibleError } from "./types.ts";
import type { CfdiPendienteEstatusSat, ClienteFichaSistema, CronSatRepository, DestinatarioAvisoSistema, EfosAfectadoSistema, RegistroEstatusSat, VencimientoPorEscalar } from "./types.ts";

const FN_PREFIX = "despachos.system_";

function fechaIso(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export class PostgresCronSatRepository implements CronSatRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async lectura<R, T>(savepoint: string, sql: string, params: unknown[], mapear: (rows: R[]) => T): Promise<T | null> {
    return runWithSavepointFallback<T | null>({
      session: this.db,
      savepointName: savepoint,
      primary: async () => mapear((await this.db.query<R>(sql, params)).rows),
      isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
      fallback: async () => null,
    });
  }

  private async escritura<T>(savepoint: string, operacion: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      savepointName: savepoint,
      primary: operacion,
      isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
      fallback: async () => {
        throw new CronSatNoDisponibleError();
      },
    });
  }

  listarCfdiPendientesEstatusSat(limite: number, reintentoDias: number): Promise<readonly CfdiPendienteEstatusSat[] | null> {
    return this.lectura<{ out_invoice_id: string; out_organization_id: string; out_property_id: string; out_folio_fiscal: string; out_rfc_emisor: string; out_rfc_receptor: string; out_total: string | number; out_estado_sat: EstadoSatCfdi }, readonly CfdiPendienteEstatusSat[]>(
      "sp_cron_cfdi_pendientes_sat",
      "select * from despachos.system_cfdi_pendientes_estatus_sat($1, $2);",
      [limite, reintentoDias],
      (rows) => rows.map((r) => ({ invoiceId: r.out_invoice_id, organizationId: r.out_organization_id, propertyId: r.out_property_id, folioFiscal: r.out_folio_fiscal, rfcEmisor: r.out_rfc_emisor, rfcReceptor: r.out_rfc_receptor, total: Number(r.out_total), estadoSat: r.out_estado_sat })),
    );
  }

  registrarEstatusSatSistema(invoiceId: string, estado: EstadoSatCfdi): Promise<RegistroEstatusSat> {
    return this.escritura("sp_cron_cfdi_registrar_sat", async () => {
      const { rows } = await this.db.query<{ out_organization_id: string; out_property_id: string; out_estado_anterior: EstadoSatCfdi; out_estado_nuevo: EstadoSatCfdi; out_cambio_a_cancelado: boolean }>("select * from despachos.system_cfdi_registrar_estatus_sat($1, $2);", [invoiceId, estado]);
      const r = rows[0]!;
      return { organizationId: r.out_organization_id, propertyId: r.out_property_id, estadoAnterior: r.out_estado_anterior, estadoNuevo: r.out_estado_nuevo, cambioACancelado: r.out_cambio_a_cancelado };
    });
  }

  listarEfosAfectadosSistema(limite: number): Promise<readonly EfosAfectadoSistema[] | null> {
    return this.lectura<{ out_invoice_id: string; out_organization_id: string; out_property_id: string; out_situacion: "presunto" | "definitivo" }, readonly EfosAfectadoSistema[]>(
      "sp_cron_efos_afectados",
      "select * from despachos.system_efos_invoices_afectados($1);",
      [limite],
      (rows) => rows.map((r) => ({ invoiceId: r.out_invoice_id, organizationId: r.out_organization_id, propertyId: r.out_property_id, situacion: r.out_situacion })),
    );
  }

  listarClientesFichaSistema(limite: number): Promise<readonly ClienteFichaSistema[] | null> {
    return this.lectura<{ out_organization_id: string; out_property_id: string; out_regimenes: string[]; out_zona_horaria: string | null }, readonly ClienteFichaSistema[]>(
      "sp_cron_clientes_ficha",
      "select * from despachos.system_despachos_clientes_ficha($1);",
      [limite],
      (rows) => rows.map((r) => ({ organizationId: r.out_organization_id, propertyId: r.out_property_id, regimenes: r.out_regimenes ?? [], zonaHoraria: r.out_zona_horaria })),
    );
  }

  upsertVencimientoSistema(propertyId: string, nuevo: { readonly tipo: string; readonly periodo: string; readonly fechaLimite: string; readonly prioridad: string }): Promise<{ readonly id: string; readonly creado: boolean; readonly omitido?: boolean }> {
    const insertar = (): Promise<{ id: string; creado: boolean; omitido?: boolean }> => this.escritura("sp_cron_vencimiento_upsert", async () => {
      const { rows } = await this.db.query<{ out_deadline_id: string; out_creado: boolean }>("select * from despachos.system_vencimiento_upsert($1, $2, $3, $4::date, $5);", [propertyId, nuevo.tipo, nuevo.periodo, nuevo.fechaLimite, nuevo.prioridad]);
      return { id: rows[0]!.out_deadline_id, creado: rows[0]!.out_creado } as { id: string; creado: boolean; omitido?: boolean };
    });
    if (TIPOS_VENCIMIENTO_BASE.includes(nuevo.tipo as TipoVencimiento)) return insertar();
    // Un tipo que el CHECK de la base aun no admite (23514, falta la migracion 019/024) NO debe tumbar la transaccion del cliente: el
    // intento corre en un SAVEPOINT propio, se omite y el resto de las obligaciones del cliente sigue.
    return runWithSavepointFallback<{ id: string; creado: boolean; omitido?: boolean }>({
      session: this.db,
      savepointName: "sp_cron_vencimiento_tipo_nuevo",
      primary: () => insertar(),
      isRecoverable: (err) => Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "23514"),
      fallback: async () => ({ id: "", creado: false, omitido: true }),
    });
  }

  async listarVencimientosPorEscalarSistema(propertyId: string, hoy: string): Promise<readonly VencimientoPorEscalar[]> {
    return this.escritura("sp_cron_vencimientos_por_escalar", async () => {
      const { rows } = await this.db.query<{ out_deadline_id: string; out_tipo: string; out_periodo: string; out_fecha_limite: string | Date; out_prioridad: string; out_nivel_max: NivelEscalamiento | null }>("select * from despachos.system_vencimientos_por_escalar($1, $2::date);", [propertyId, hoy]);
      return rows.map((r) => ({ id: r.out_deadline_id, tipo: r.out_tipo, periodo: r.out_periodo, fechaLimite: fechaIso(r.out_fecha_limite), prioridad: r.out_prioridad, nivelMax: r.out_nivel_max }));
    });
  }

  escalarVencimientoSistema(deadlineId: string, nivel: NivelEscalamiento, notas: string): Promise<boolean> {
    return this.escritura("sp_cron_vencimiento_escalar", async () => {
      const { rows } = await this.db.query<{ r: boolean }>("select despachos.system_vencimiento_escalar($1, $2, $3) as r;", [deadlineId, nivel, notas]);
      return rows[0]?.r === true;
    });
  }

  listarPeriodosVencimientosSistema(propertyId: string): Promise<readonly string[] | null> {
    return this.lectura<{ out_periodo: string }, readonly string[]>("sp_cron_vencimientos_periodos", "select * from despachos.system_vencimientos_periodos($1);", [propertyId], (rows) => rows.map((r) => r.out_periodo));
  }

  async nombreClienteSistema(propertyId: string): Promise<string | null> {
    const r = await this.lectura<{ nombre: string | null }, string | null>("sp_cron_cliente_nombre", "select despachos.system_cliente_nombre($1) as nombre;", [propertyId], (rows) => rows[0]?.nombre ?? null);
    return r ?? null;
  }

  async listarDestinatariosAvisoSistema(organizationId: string): Promise<readonly DestinatarioAvisoSistema[]> {
    const r = await runWithSavepointFallback<readonly DestinatarioAvisoSistema[]>({
      session: this.db,
      savepointName: "sp_cron_destinatarios_aviso",
      primary: async () => (await this.db.query<{ email: string }>("select email from despachos.organization_notification_recipients($1);", [organizationId])).rows.map((x) => ({ email: x.email })),
      isRecoverable: (err) => isMigrationPendingError(err, "despachos.organization_notification_recipients"),
      fallback: async () => [],
    });
    return r;
  }

  encolarCorreoSistema(organizationId: string, evento: string, dedupeKey: string, payload: { readonly to: string; readonly subject: string; readonly html: string; readonly text: string }): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_cron_encolar_correo",
      primary: async () => {
        await this.db.query("select despachos.enqueue_messaging_outbox($1, 'email', $2, $3, $4::jsonb);", [organizationId, evento, dedupeKey, JSON.stringify(payload)]);
        return true;
      },
      isRecoverable: (err) => isMigrationPendingError(err, "despachos.enqueue_messaging_outbox"),
      fallback: async () => false,
    });
  }
}
