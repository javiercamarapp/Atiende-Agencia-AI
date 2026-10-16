// Alerta "comanda esperando captura manual": una comanda que lleva mas que el umbral de su sucursal (5 min por omision, migracion 054)
// en `captura_manual` sin que nadie la capture en el POS. La decide la base (`pos_comandas_captura_manual_vencidas`, solo sistema); aqui:
// la emision por el productor compartido (`emitirNotificacion`: catalogo, dedupe, destinatarios en SQL y texto sin PII: solo los minutos).
//
// Idempotente: la clave de dedupe es el id de la comanda, asi que dos ticks dejan UNA alerta por comanda (el segundo cuenta `sinNuevas`).
// Corre dentro del tick existente `/internal/restaurantes/softrestaurant-dispatch` como unidad INDEPENDIENTE (su propia sesion de sistema):
// una falla aqui jamas toca el envio de comandas. Base sin migrar: el store devuelve `disponible: false` dentro de un SAVEPOINT.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import type { ComandaOutboxStore } from "./outbox-store.ts";

export interface ResultadoBarridoCapturaManual {
  /** `false` = la base aun no tiene la migracion 054 (no hay nada que barrer). */
  readonly disponible: boolean;
  readonly candidatas: number;
  readonly emitidas: number;
  /** Ya existia (dedupe), nadie a quien avisar o tope de volumen. */
  readonly sinNuevas: number;
  readonly errores: number;
}

export const SIN_BARRIDO_CAPTURA_MANUAL: ResultadoBarridoCapturaManual = { disponible: false, candidatas: 0, emitidas: 0, sinNuevas: 0, errores: 0 };

export async function barrerCapturaManualVencida(session: TenantDbSession, store: ComandaOutboxStore, options: { readonly now?: Date } = {}): Promise<ResultadoBarridoCapturaManual> {
  const { disponible, filas } = await store.listarCapturaManualVencidas(options.now ?? new Date());
  if (!disponible) return SIN_BARRIDO_CAPTURA_MANUAL;
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  for (const c of filas) {
    const r = await emitirNotificacion(session, {
      evento: "restaurantes.comanda.captura_manual_vencida",
      organizationId: c.organizationId,
      propertyId: c.propertyId,
      clave: c.comandaId,
      parametros: { minutos: c.minutos },
      entidadTipo: "pos_comanda",
      entidadId: c.comandaId,
    });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas") sinNuevas += 1;
    else errores += 1;
  }
  return { disponible: true, candidatas: filas.length, emitidas, sinNuevas, errores };
}
