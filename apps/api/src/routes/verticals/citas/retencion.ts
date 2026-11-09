// QA R1 (citas, automatizacion 07) -- purga por retencion de los datos de salud de citas (historial de chat de WhatsApp,
// escalaciones de crisis y notas internas de conversaciones transferidas). NO es un cron propio: vercel.json ya esta en el tope de 40
// crons del plan Pro, asi que `/internal/plataforma/privacidad-retencion` (diario, ver plataforma-retencion.ts) la ejecuta como
// un paso mas de su corrida, con la misma regla de ejecucion (GET con Authorization: Bearer = ejecuta; lo demas simula) y el mismo
// interruptor, latido y secreto.
//
// Una transaccion de sistema (`userId: null`) POR lote: un lote con un error no revierte los ya purgados. El SQL
// (`citas.system_purge_retencion`, migracion 033) aplica el plazo, respeta la retencion legal activa y a quien tenga una solicitud
// ARCO abierta, y devuelve solo conteos. Base sin migrar: `disponible:false`, no se toca nada y no hay 500. Los plazos (365 dias)
// son provisionales hasta que el asesor juridico decida (docs/PRIVACIDAD-PLATAFORMA.md).
import type { AppDeps } from "../../../deps.ts";

const LOTE = 500;
/** Tope de lotes por corrida (hasta 2500 filas por clase): acota el tiempo dentro de maxDuration (30 s). Lo que quede lo purga la corrida siguiente. */
const MAX_LOTES = 5;

export interface RetencionCitasResultado {
  /** `false` = la base todavia no tiene la migracion 033: no se toco nada. */
  readonly disponible: boolean;
  readonly lotes: number;
  readonly conversacionesVaciadas: number;
  readonly escalacionesBorradas: number;
  readonly notasBorradas: number;
  /** Vencidas que se conservan por retencion legal activa o por una solicitud ARCO abierta. */
  readonly protegidas: number;
  /** Presente si un lote lanzo un error real: lo ya purgado en lotes anteriores se conserva. */
  readonly error?: "fallo_inesperado";
}

export async function purgarRetencionCitas(deps: AppDeps, ejecutar: boolean): Promise<RetencionCitasResultado> {
  let disponible = true;
  let lotes = 0;
  let conversacionesVaciadas = 0;
  let escalacionesBorradas = 0;
  let notasBorradas = 0;
  let protegidas = 0;
  let error: RetencionCitasResultado["error"];
  // Simulacion: un solo lote (contar no reduce lo vencido, repetirlo no aporta nada).
  const maxLotes = ejecutar ? MAX_LOTES : 1;
  try {
    for (let i = 0; i < maxLotes; i += 1) {
      const lote = await deps.engine.withAppSession({ userId: null }, (db) => deps.citasRepo(db).purgeRetentionBatch(LOTE, !ejecutar));
      lotes += 1;
      if (!lote.disponible) {
        disponible = false;
        break;
      }
      conversacionesVaciadas += lote.conversacionesVaciadas;
      escalacionesBorradas += lote.escalacionesBorradas;
      notasBorradas += lote.notasBorradas;
      protegidas = lote.protegidas;
      // El lote se acota por clase: si ninguna lleno su tope, ya no queda nada vencido que purgar.
      if (Math.max(lote.conversacionesVaciadas, lote.escalacionesBorradas, lote.notasBorradas) < LOTE) break;
    }
  } catch {
    error = "fallo_inesperado";
  }
  return { disponible, lotes, conversacionesVaciadas, escalacionesBorradas, notasBorradas, protegidas, ...(error ? { error } : {}) };
}
