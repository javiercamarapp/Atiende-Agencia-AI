// C-16 -- avisos in-app (campana) del ciclo de citas que NO nacen de un evento puntual sino de un barrido: citas por confirmar,
// recordatorios que agotaron sus reintentos y escalaciones de crisis que nadie ha tomado. Los invoca el cron de recordatorios
// (`reminders.ts`, cada 30 min) una vez por organizacion; cada emision pasa por el productor compartido de @atiende/db
// (`emitirNotificacion`: catalogo, dedupe, tope de volumen, destinatarios resueltos en la base, sin PII).
//
// Contratos:
//   * UNA transaccion POR organizacion (`withAppSession` por unidad): un error SQL real en una organizacion no deja abortada la
//     transaccion de las siguientes ni revierte lo ya emitido.
//   * Nunca cambia la respuesta ni el latido del cron: cualquier fallo se traga (los avisos son best-effort).
//   * Base sin migrar: `systemAvisosResumen` (029) devuelve null dentro de un SAVEPOINT y no se emite nada; `emitirNotificacion` (0039) devuelve
//     "no_disponible" por el mismo camino. Ninguno aborta la transaccion.
//   * Dedupe: "por confirmar" y "escalaciones sin seguimiento" una por dia; "recordatorios agotados" usa como clave el instante del ULTIMO
//     agotado, asi que solo vuelve a avisar cuando aparece uno nuevo (no repite el mismo conteo todos los dias).
import { emitirNotificacion } from "@atiende/db";
import type { AppDeps } from "../../../deps.ts";

export interface ResumenAvisosCiclo {
  readonly organizaciones: number;
  readonly emitidas: number;
}

export async function emitirAvisosDeCitas(deps: Pick<AppDeps, "engine" | "citasRepo">, organizationIds: readonly string[], ahora: Date = new Date()): Promise<ResumenAvisosCiclo> {
  const hoy = ahora.toISOString().slice(0, 10);
  let emitidas = 0;
  for (const organizationId of organizationIds) {
    try {
      emitidas += await deps.engine.withAppSession({ userId: null }, async (db) => {
        const resumen = await deps.citasRepo(db).systemAvisosResumen(organizationId);
        if (!resumen) return 0;
        const emisiones = [
          resumen.porConfirmar > 0 ? { evento: "citas.cita.por_confirmar", clave: `${organizationId}:${hoy}`, cantidad: resumen.porConfirmar } : null,
          resumen.recordatoriosAgotados > 0 && resumen.ultimoAgotadoEpoch !== null
            ? { evento: "citas.recordatorio.agotado", clave: `${organizationId}:${resumen.ultimoAgotadoEpoch}`, cantidad: resumen.recordatoriosAgotados }
            : null,
          resumen.escalacionesSinSeguimiento > 0 ? { evento: "citas.escalacion.sin_seguimiento", clave: `${organizationId}:${hoy}`, cantidad: resumen.escalacionesSinSeguimiento } : null,
        ];
        let n = 0;
        for (const e of emisiones) {
          if (!e) continue;
          const r = await emitirNotificacion(db, { evento: e.evento, organizationId, clave: e.clave, parametros: { cantidad: e.cantidad } });
          if (r.estado === "emitida") n += 1;
        }
        return n;
      });
    } catch {
      // best-effort: una organizacion con un error real no frena a las demas ni toca la respuesta del cron.
    }
  }
  return { organizaciones: organizationIds.length, emitidas };
}
