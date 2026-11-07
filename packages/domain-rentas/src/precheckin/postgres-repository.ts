// Rn-P3-08 -- adaptador Postgres del pre-check-in sobre el TenantDbSession de la sesion de sistema (formulario publico) o del staff.
//
// Base sin migrar (migracion 036 pendiente: SQLSTATE 42883/42P01/42703): TODAS las operaciones devuelven `disponible: false` (la ruta
// responde "aun no disponible", nunca un 500). La sesion es UNA transaccion por request y Postgres la deja ABORTADA tras el error (25P02),
// asi que cada operacion corre bajo SAVEPOINT (runWithSavepointFallback).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { RentasPrecheckinRepository } from "./repository.ts";
import type { ConfigPrecheckin, EntradaCapturaDb, InfoPrecheckin, ResultadoCapturaDb, ResultadoPrecheckin, VerificacionPrecheckinDb } from "./tipos.ts";

interface VerificarRow {
  resultado: "ok" | "invalido" | "bloqueado";
  propiedad_nombre: string | null;
  unidad_nombre: string | null;
  check_in: string | null;
  check_out: string | null;
  ya_capturado: boolean;
  token_expira_en: string | null;
}

interface ConfigRow {
  property_id: string;
  reglamento: string | null;
  reglamento_version: number;
}

export class PostgresRentasPrecheckinRepository implements RentasPrecheckinRepository {
  constructor(private readonly db: TenantDbSession) {}

  private conDegradacion<T>(nombre: string, primary: () => Promise<T>): Promise<ResultadoPrecheckin<T>> {
    return runWithSavepointFallback<ResultadoPrecheckin<T>>({
      session: this.db,
      savepointName: `sp_precheckin_${nombre}`,
      primary: async () => ({ disponible: true, valor: await primary() }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false }),
    });
  }

  obtenerInfo(propertyId: string): Promise<ResultadoPrecheckin<InfoPrecheckin | null>> {
    return this.conDegradacion("info", async () => {
      const { rows } = await this.db.query<{ propiedad_nombre: string; organizacion_nombre: string; reglamento: string | null; reglamento_version: number }>(
        `select propiedad_nombre, organizacion_nombre, reglamento, reglamento_version from rentas.precheckin_info($1::uuid);`,
        [propertyId],
      );
      const r = rows[0];
      return r ? { propiedadNombre: r.propiedad_nombre, organizacionNombre: r.organizacion_nombre, reglamento: r.reglamento, reglamentoVersion: r.reglamento_version } : null;
    });
  }

  verificar(propertyId: string, codigo: string, ultimos4: string, claveHash: string, tokenHash: string): Promise<ResultadoPrecheckin<VerificacionPrecheckinDb>> {
    return this.conDegradacion("verificar", async () => {
      const { rows } = await this.db.query<VerificarRow>(
        `select resultado, propiedad_nombre, unidad_nombre, to_char(check_in, 'YYYY-MM-DD') as check_in, to_char(check_out, 'YYYY-MM-DD') as check_out, ya_capturado, token_expira_en::text as token_expira_en
           from rentas.precheckin_verificar($1::uuid, $2, $3, $4, $5);`,
        [propertyId, codigo, ultimos4, claveHash, tokenHash],
      );
      const r = rows[0];
      if (!r) return { resultado: "invalido", propiedadNombre: null, unidadNombre: null, checkIn: null, checkOut: null, yaCapturado: false, tokenExpiraEn: null };
      return { resultado: r.resultado, propiedadNombre: r.propiedad_nombre, unidadNombre: r.unidad_nombre, checkIn: r.check_in, checkOut: r.check_out, yaCapturado: r.ya_capturado, tokenExpiraEn: r.token_expira_en };
    });
  }

  capturar(e: EntradaCapturaDb): Promise<ResultadoPrecheckin<{ readonly resultado: ResultadoCapturaDb }>> {
    return this.conDegradacion("capturar", async () => {
      const { rows } = await this.db.query<{ resultado: ResultadoCapturaDb }>(
        `select resultado from rentas.precheckin_capturar($1, $2, $3, $4::boolean, $5, $6::boolean);`,
        [e.tokenHash, e.correo, e.whatsapp, e.aceptaPrivacidad, e.avisoVersion, e.aceptaReglamento],
      );
      return { resultado: rows[0]?.resultado ?? "token_invalido" };
    });
  }

  obtenerConfig(propertyId: string): Promise<ResultadoPrecheckin<ConfigPrecheckin>> {
    return this.conDegradacion("config_leer", async () => {
      const { rows } = await this.db.query<ConfigRow>(`select property_id, reglamento, reglamento_version from rentas.precheckin_config where property_id = $1;`, [propertyId]);
      const r = rows[0];
      return r ? { propertyId: r.property_id, reglamento: r.reglamento, reglamentoVersion: r.reglamento_version } : { propertyId, reglamento: null, reglamentoVersion: 1 };
    });
  }

  guardarReglamento(organizationId: string, propertyId: string, reglamento: string | null, actorId: string): Promise<ResultadoPrecheckin<ConfigPrecheckin>> {
    return this.conDegradacion("config_guardar", async () => {
      const { rows } = await this.db.query<ConfigRow>(
        `insert into rentas.precheckin_config as c (property_id, organization_id, reglamento, reglamento_version, updated_by)
         values ($1, $2, $3, 1, $4)
         on conflict (property_id) do update set
           reglamento = excluded.reglamento,
           reglamento_version = case when c.reglamento is distinct from excluded.reglamento then c.reglamento_version + 1 else c.reglamento_version end,
           updated_at = now(), updated_by = excluded.updated_by
         returning property_id, reglamento, reglamento_version;`,
        [propertyId, organizationId, reglamento, actorId],
      );
      const r = rows[0]!;
      return { propertyId: r.property_id, reglamento: r.reglamento, reglamentoVersion: r.reglamento_version };
    });
  }
}
