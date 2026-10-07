// L-30 / L-32 -- lecturas y escrituras de SISTEMA que alimentan los avisos de la campana de licitaciones
// (funciones de la migracion 034). Modulo aparte de `repository.ts`/`postgres-repository.ts` (mismo criterio que
// `kyc-69b-repository.ts`: archivos compartidos por varias ramas en paralelo).
//
//   * `retamizarCarteraKyc`: re-evalua la cartera KYC (fichas de `kyc_party`) de cada organizacion activa contra la
//     edicion MAS RECIENTE de la lista 69-B y devuelve, por organizacion, cuantas fichas se evaluaron y cuantas
//     EMPEORARON (la primera evaluacion de un RFC es linea base y nunca cuenta como empeoramiento). Idempotente.
//   * `contarDocumentosPorVencer`: documentos de empresa APROBADOS con vigencia dentro de la ventana, por organizacion.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: la API se despliega antes que la migracion 034. Cada llamada corre dentro de
// `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) porque la sesion puede ser UNA transaccion compartida:
// un 42883/42P01/42703 sin savepoint la dejaria abortada (25P02) y el COMMIT revertiria todo en silencio. Si falta la
// migracion (o la lista 69-B de despachos) el resultado es "no disponible" -- nunca una excepcion ni un 500. Los demas
// errores de Postgres se propagan: el llamador decide (los barridos los cuentan como fallo real de esa organizacion).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export interface KycRetamizadoOrganizacion {
  readonly organizationId: string;
  /** Edicion de la lista 69-B contra la que se evaluo (YYYY-MM). */
  readonly periodo: string;
  /** Fichas guardadas o reevaluadas en ESTA corrida (0 filas = la edicion ya estaba evaluada: no aparece). */
  readonly evaluadas: number;
  /** Fichas (proveedores y competidores) cuyo semaforo es peor que el de la evaluacion anterior. */
  readonly empeoradas: number;
  /** De las anteriores, las que son proveedores propios: son las que justifican la alerta. */
  readonly proveedoresEmpeorados: number;
}

export interface KycRetamizadoResultado {
  /** `false` = la base no tiene aun la migracion 034 (o la lista 69-B): no se evaluo nada. */
  readonly disponible: boolean;
  readonly organizaciones: readonly KycRetamizadoOrganizacion[];
}

export interface AvisosSistemaRepository {
  retamizarCarteraKyc(): Promise<KycRetamizadoResultado>;
  /** `null` = no disponible aun (migracion 034 pendiente). `dias` entre 1 y 365; `hoyIso` = "YYYY-MM-DD". */
  contarDocumentosPorVencer(organizationId: string, hoyIso: string, dias: number): Promise<number | null>;
  /** Firmantes APROBADOS y autorizados cuyo poder vence dentro de la ventana (migracion 040). `null` = no disponible aun. */
  contarPoderesPorVencer(organizationId: string, hoyIso: string, dias: number): Promise<number | null>;
}

interface RetamizadoRow {
  out_organization_id: string;
  out_periodo: string;
  out_evaluadas: number;
  out_empeoradas: number;
  out_proveedores_empeorados: number;
}

export class PostgresAvisosSistemaRepository implements AvisosSistemaRepository {
  constructor(private readonly db: TenantDbSession) {}

  async retamizarCarteraKyc(): Promise<KycRetamizadoResultado> {
    const rows = await runWithSavepointFallback<readonly RetamizadoRow[] | null>({
      session: this.db,
      primary: async () => (await this.db.query<RetamizadoRow>(`select * from licitaciones.system_retamizar_cartera_kyc();`)).rows,
      isRecoverable: (err) => isMigrationPendingError(err, "system_retamizar_cartera_kyc"),
      fallback: async () => null,
    });
    if (rows === null) return { disponible: false, organizaciones: [] };
    return {
      disponible: true,
      organizaciones: rows.map((r) => ({
        organizationId: r.out_organization_id,
        periodo: r.out_periodo,
        evaluadas: Number(r.out_evaluadas),
        empeoradas: Number(r.out_empeoradas),
        proveedoresEmpeorados: Number(r.out_proveedores_empeorados),
      })),
    };
  }

  async contarDocumentosPorVencer(organizationId: string, hoyIso: string, dias: number): Promise<number | null> {
    return runWithSavepointFallback<number | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ n: number }>(`select licitaciones.system_count_company_documents_expiring($1::uuid, $2::date, $3::int) as n;`, [organizationId, hoyIso, dias]);
        return Number(rows[0]?.n ?? 0);
      },
      isRecoverable: (err) => isMigrationPendingError(err, "system_count_company_documents_expiring"),
      fallback: async () => null,
    });
  }

  async contarPoderesPorVencer(organizationId: string, hoyIso: string, dias: number): Promise<number | null> {
    return runWithSavepointFallback<number | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ n: number }>(`select licitaciones.system_count_signer_powers_expiring($1::uuid, $2::date, $3::int) as n;`, [organizationId, hoyIso, dias]);
        return Number(rows[0]?.n ?? 0);
      },
      isRecoverable: (err) => isMigrationPendingError(err, "system_count_signer_powers_expiring"),
      fallback: async () => null,
    });
  }
}
