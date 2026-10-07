// Alertas de voz evaluadas por el SISTEMA (QA R2 automatizacion-09): el costo del dia sobre el umbral y la tasa de error del proveedor salian
// solo si alguien apretaba "Evaluar" en el panel. La evaluacion corre ahora en el tick que ya existe (/internal/restaurantes/promover-programados,
// cada 5 min; sin cron nuevo) con `restaurantes.voz_alertas_evaluar_sistema()` (migracion 076, SOLO sistema), y por cada alerta NUEVA del dia emite
// la notificacion in-app por el productor compartido (dedupe: una por sucursal, dia y tipo; sin cifras ni PII en el texto).
//
// Base sin migrar: la funcion no existe (42883) y la evaluacion responde `disponible: false` dentro de un SAVEPOINT (runWithSavepointFallback),
// sin romper el tick ni dejar abortada la transaccion.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export interface ResultadoAlertasVozSistema {
  /** `false` = la base aun no tiene la migracion 076 (nada que evaluar). */
  readonly disponible: boolean;
  /** Alertas disparadas por PRIMERA VEZ hoy en esta corrida. */
  readonly nuevas: number;
  readonly emitidas: number;
  readonly errores: number;
}

interface FilaAlertaNueva {
  readonly organization_id: string;
  readonly property_id: string;
  readonly fecha: string;
  readonly tipo: string;
}

export async function evaluarAlertasVozDelSistema(db: TenantDbSession): Promise<ResultadoAlertasVozSistema> {
  const lectura = await runWithSavepointFallback<{ readonly disponible: boolean; readonly filas: readonly FilaAlertaNueva[] }>({
    session: db,
    savepointName: "sp_voz_alertas_sistema",
    primary: async () => {
      const { rows } = await db.query<FilaAlertaNueva>(
        `select organization_id, property_id, to_char(fecha, 'YYYY-MM-DD') as fecha, tipo from restaurantes.voz_alertas_evaluar_sistema();`,
      );
      return { disponible: true, filas: rows };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, filas: [] }),
  });
  if (!lectura.disponible) return { disponible: false, nuevas: 0, emitidas: 0, errores: 0 };
  let emitidas = 0;
  let errores = 0;
  for (const f of lectura.filas) {
    const r = await emitirNotificacion(db, {
      evento: f.tipo === "costo_dia" ? "restaurantes.costo.umbral_voz" : "restaurantes.voz.tasa_error_alta",
      organizationId: f.organization_id,
      propertyId: f.property_id,
      clave: `${f.property_id}:${f.fecha}`,
    });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "error" || r.estado === "invalida") errores += 1;
  }
  return { disponible: true, nuevas: lectura.filas.length, emitidas, errores };
}
