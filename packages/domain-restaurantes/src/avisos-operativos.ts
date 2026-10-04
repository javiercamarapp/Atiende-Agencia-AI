// R-16 -- alertas operativas de restaurantes: "entrega tardia" y "programado por vencer". El candidato lo decide la
// base (`restaurantes.avisos_operativos_candidatos`, migracion 041, SOLO sistema); este modulo lo convierte en
// notificaciones in-app por el productor compartido (`emitirNotificacion`: catalogo, dedupe, destinatarios en SQL,
// preferencias por usuario y texto sin PII: solo el numero de pedido).
//
// Idempotente: la clave de dedupe es el id del pedido, asi que dos barridos (o dos ticks) dejan UNA alerta por
// pedido y tipo; el segundo cuenta `sinNuevas`. El barrido corre dentro del tick existente
// /internal/restaurantes/promover-programados como unidad INDEPENDIENTE (su propia sesion de sistema): cada
// emision va en su SAVEPOINT (emitirNotificacion) y una falla jamas toca la promocion ni la comanda.
//
// Base sin migrar: el candidato lanza 42883 dentro de un SAVEPOINT y el barrido devuelve `disponible: false`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export type TipoAvisoOperativo = "restaurantes.pedido.entrega_tardia" | "restaurantes.pedido.programado_por_vencer";

export interface CandidatoAviso {
  readonly tipo: TipoAvisoOperativo;
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderNumber: number;
}

export interface ResultadoBarridoAvisos {
  /** `false` = la base aun no tiene la migracion 041 (no hay nada que barrer). */
  readonly disponible: boolean;
  readonly candidatos: number;
  readonly emitidas: number;
  /** Ya existia (dedupe), nadie a quien avisar o tope de volumen. */
  readonly sinNuevas: number;
  readonly errores: number;
}

const SIN_BARRIDO: ResultadoBarridoAvisos = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 };

export async function listarCandidatosAvisos(session: TenantDbSession, now?: Date): Promise<{ readonly disponible: boolean; readonly candidatos: readonly CandidatoAviso[] }> {
  return runWithSavepointFallback<{ readonly disponible: boolean; readonly candidatos: readonly CandidatoAviso[] }>({
    session,
    primary: async () => {
      const { rows } = await session.query<{ tipo: TipoAvisoOperativo; order_id: string; organization_id: string; property_id: string; order_number: string | number }>(
        `select tipo, order_id, organization_id, property_id, order_number from restaurantes.avisos_operativos_candidatos($1::timestamptz);`,
        [now ? now.toISOString() : null],
      );
      return {
        disponible: true,
        candidatos: rows.map((r) => ({ tipo: r.tipo, orderId: r.order_id, organizationId: r.organization_id, propertyId: r.property_id, orderNumber: Number(r.order_number) })),
      };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, candidatos: [] }),
  });
}

/** Emite las alertas de los candidatos de hoy. `now` es solo para pruebas (en produccion manda el reloj de la base). */
export async function barrerAvisosOperativos(session: TenantDbSession, options: { readonly now?: Date } = {}): Promise<ResultadoBarridoAvisos> {
  const { disponible, candidatos } = await listarCandidatosAvisos(session, options.now);
  if (!disponible) return SIN_BARRIDO;
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  for (const c of candidatos) {
    const base = { organizationId: c.organizationId, propertyId: c.propertyId, clave: c.orderId, parametros: { numero: c.orderNumber }, entidadTipo: "order", entidadId: c.orderId } as const;
    const r =
      c.tipo === "restaurantes.pedido.entrega_tardia"
        ? await emitirNotificacion(session, { evento: "restaurantes.pedido.entrega_tardia", ...base })
        : await emitirNotificacion(session, { evento: "restaurantes.pedido.programado_por_vencer", ...base });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas") sinNuevas += 1;
    else errores += 1;
  }
  return { disponible: true, candidatos: candidatos.length, emitidas, sinNuevas, errores };
}
