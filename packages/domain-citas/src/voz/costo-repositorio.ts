// Costo por llamada de la voz de citas hacia `core.usage_cost_event` (SA-02) con vertical 'citas' (la fija la base desde la organizacion; citas no tiene sucursal propia: `property_id` va NULL salvo que la llamada la traiga), via
// `core.record_usage_cost_event` (solo sistema, `auth.uid() is null`, idempotente por `ref_tipo + ref_id`). Los eventos los arma voice-core
// (`eventosCostoLlamada`): uno por escalon que atendio la llamada, con el desglose del proveedor.
//
// REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: si la migracion 0028 de core no esta aplicada la funcion no existe (42883/42P01/42703). Cada evento corre
// en su propio SAVEPOINT (la sesion es UNA transaccion): ante esos SQLSTATE el costo queda "no disponible aun" (nunca un 500 ni una transaccion abortada)
// y la llamada, que ya ocurrio, no se ve afectada. Cualquier otro error (p. ej. 42501 por sesion de staff, 22023 sucursal ajena) se repropaga.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { EventoCostoUso } from "@atiende/voice-core";

export interface ResultadoRegistroCosto {
  /** false = la base todavia no tiene `core.record_usage_cost_event` (migracion 0028 pendiente): nada se registro. */
  readonly disponible: boolean;
  /** Eventos nuevos (los repetidos por idempotencia no cuentan). */
  readonly registrados: number;
  readonly repetidos: number;
}

export interface RepositorioCostoVoz {
  registrarCostoLlamada(eventos: readonly EventoCostoUso[]): Promise<ResultadoRegistroCosto>;
}

export class PostgresCostoVozRepository implements RepositorioCostoVoz {
  constructor(private readonly db: TenantDbSession) {}

  async registrarCostoLlamada(eventos: readonly EventoCostoUso[]): Promise<ResultadoRegistroCosto> {
    let registrados = 0;
    let repetidos = 0;
    for (const e of eventos) {
      const nuevo = await runWithSavepointFallback<boolean | null>({
        session: this.db,
        primary: async () => {
          const { rows } = await this.db.query<{ nuevo: boolean }>(
            `select core.record_usage_cost_event($1::uuid, $2::uuid, $3::timestamptz, $4, $5, $6, $7::numeric, $8::bigint, $9::boolean, $10, $11) as nuevo;`,
            [e.organizationId, e.propertyId, e.ocurridoEn, e.categoria, e.proveedor, e.unidad, e.cantidad, e.costoMicroUsd, e.costoEstimado, e.refTipo, e.refId],
          );
          return rows[0]?.nuevo === true;
        },
        isRecoverable: (err) => isMigrationPendingError(err),
        fallback: async () => null,
      });
      if (nuevo === null) return { disponible: false, registrados, repetidos };
      if (nuevo) registrados += 1;
      else repetidos += 1;
    }
    return { disponible: true, registrados, repetidos };
  }
}

/** Doble en memoria con la misma idempotencia (`ref_tipo + ref_id`). */
export class InMemoryCostoVozRepository implements RepositorioCostoVoz {
  readonly eventos: EventoCostoUso[] = [];
  disponible = true;

  async registrarCostoLlamada(eventos: readonly EventoCostoUso[]): Promise<ResultadoRegistroCosto> {
    if (!this.disponible) return { disponible: false, registrados: 0, repetidos: 0 };
    let registrados = 0;
    let repetidos = 0;
    for (const e of eventos) {
      if (this.eventos.some((x) => x.refTipo === e.refTipo && x.refId === e.refId)) repetidos += 1;
      else {
        this.eventos.push(e);
        registrados += 1;
      }
    }
    return { disponible: true, registrados, repetidos };
  }
}
