// D-25 -- aviso in-app (campana) de pagos provisionales de ISR/IVA por vencer. Productor del evento
// "despachos.pago_provisional.por_vencer" del catalogo de notificaciones: una por organizacion por dia, con la CANTIDAD de
// obligaciones de pago provisional (ISR/IVA) que vencen en los proximos dias y aun no tienen su papel marcado como presentado. Sin PII:
// la plantilla es de catalogo y el unico parametro es un numero.
//
// La lectura entre organizaciones usa la funcion de SOLO-SISTEMA `despachos.system_pagos_provisionales_por_vencer` (migracion 020): corre
// como sesion de sistema (userId null), que no tiene acceso por RLS a ninguna property, y solo devuelve organizacion + conteo. Se invoca
// desde el cron diario de cobranza (`/internal/despachos/cobranza-reminders`, notifications.ts) para no agregar un cron nuevo.
//
// Compatibilidad con la base sin migrar: la lectura corre en un SAVEPOINT (runWithSavepointFallback) y, sin la migracion 020 (42883/42P01),
// no emite nada (estado "no_disponible"). UNA transaccion POR organizacion al emitir: una emision fallida nunca afecta a las demas ni al cron.
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { AppDeps } from "../../../deps.ts";

/** Ventana de aviso: obligaciones que vencen hoy o en los proximos N dias. */
export const DIAS_AVISO_PAGO_PROVISIONAL = 3;

export interface ResultadoAvisoPagosProvisionales {
  readonly estado: "ok" | "no_disponible";
  readonly organizaciones: number;
  readonly emitidas: number;
}

export async function avisarPagosProvisionalesPorVencer(deps: AppDeps, hoy: string): Promise<ResultadoAvisoPagosProvisionales> {
  const filas = await deps.engine.withAppSession({ userId: null }, (db) =>
    runWithSavepointFallback<readonly { out_organization_id: string; out_cantidad: number }[] | null>({
      session: db,
      savepointName: "sp_aviso_pagos_provisionales",
      primary: async () => {
        const { rows } = await db.query<{ out_organization_id: string; out_cantidad: number }>("select out_organization_id, out_cantidad from despachos.system_pagos_provisionales_por_vencer($1::date, $2);", [hoy, DIAS_AVISO_PAGO_PROVISIONAL]);
        return rows;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    }),
  );
  if (filas === null) return { estado: "no_disponible", organizaciones: 0, emitidas: 0 };

  let emitidas = 0;
  for (const f of filas) {
    if (!(f.out_cantidad > 0)) continue;
    const r = await deps.engine
      .withAppSession({ userId: null }, (db) =>
        emitirNotificacion(db, {
          evento: "despachos.pago_provisional.por_vencer",
          organizationId: f.out_organization_id,
          clave: `${f.out_organization_id}:${hoy}`,
          parametros: { cantidad: Number(f.out_cantidad) },
        }),
      )
      .catch(() => undefined);
    if (r?.estado === "emitida") emitidas += 1;
  }
  return { estado: "ok", organizaciones: filas.length, emitidas };
}
