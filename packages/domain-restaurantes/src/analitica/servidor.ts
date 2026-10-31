// Analítica del dueño · piezas de SERVIDOR (importan @atiende/db): barrido de alertas operativas (ETA alto y «¿ya salió?» sin contestar) y gancho
// determinista de sugerencia de combo para el agente.
//
// Alertas: el candidato lo decide la base (`analitica_alertas_candidatos`, migración 163, SOLO sistema); aquí se convierte en notificación in-app con
// `emitirNotificacion` (catálogo, dedupe, destinatarios y preferencias por usuario; texto sin PII: número de pedido y minutos). NO duplica la rama de
// «chat sin respuesta» (fix/r23-alertas). Se corre dentro del tick existente como unidad independiente: una falla no toca la promoción ni la comanda.
// Base sin migrar: 42883 dentro de un SAVEPOINT => `disponible: false`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export type TipoAlertaAnalitica = "restaurantes.pedido.eta_alta" | "restaurantes.chat.ya_salio_sin_respuesta";
const TIPOS: ReadonlySet<string> = new Set<TipoAlertaAnalitica>(["restaurantes.pedido.eta_alta", "restaurantes.chat.ya_salio_sin_respuesta"]);

export interface CandidatoAlerta {
  readonly tipo: TipoAlertaAnalitica;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly orderNumber: number;
  readonly conversationId: string | null;
  readonly referenciaAt: string;
  readonly minutos: number;
}
export interface ResultadoBarridoAnalitica {
  readonly disponible: boolean;
  readonly candidatos: number;
  readonly emitidas: number;
  readonly sinNuevas: number;
  readonly errores: number;
}
const SIN_BARRIDO: ResultadoBarridoAnalitica = { disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 };

export const ETA_MAX_MIN_POR_OMISION = 60;
export const YA_SALIO_MIN_POR_OMISION = 5;

interface FilaCandidato { tipo: string; organization_id: string; property_id: string; order_id: string; order_number: string | number; conversation_id: string | null; referencia_at: Date | string; minutos: string | number }

export async function listarCandidatosAnalitica(
  session: TenantDbSession,
  opciones: { readonly now?: Date; readonly etaMaxMin?: number; readonly yaSalioMin?: number } = {},
): Promise<{ readonly disponible: boolean; readonly candidatos: readonly CandidatoAlerta[] }> {
  return runWithSavepointFallback<{ readonly disponible: boolean; readonly candidatos: readonly CandidatoAlerta[] }>({
    session,
    primary: async () => {
      const { rows } = await session.query<FilaCandidato>(
        `select tipo, organization_id, property_id, order_id, order_number, conversation_id, referencia_at, minutos
           from restaurantes.analitica_alertas_candidatos($1::timestamptz, $2::integer, $3::integer);`,
        [opciones.now ? opciones.now.toISOString() : null, opciones.etaMaxMin ?? ETA_MAX_MIN_POR_OMISION, opciones.yaSalioMin ?? YA_SALIO_MIN_POR_OMISION],
      );
      return {
        disponible: true,
        candidatos: rows
          .filter((r) => TIPOS.has(r.tipo))
          .map((r) => ({
            tipo: r.tipo as TipoAlertaAnalitica,
            organizationId: r.organization_id,
            propertyId: r.property_id,
            orderId: r.order_id,
            orderNumber: Number(r.order_number),
            conversationId: r.conversation_id,
            referenciaAt: r.referencia_at instanceof Date ? r.referencia_at.toISOString() : String(r.referencia_at),
            minutos: Number(r.minutos),
          })),
      };
    },
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => ({ disponible: false, candidatos: [] }),
  });
}

/** Clave de dedupe: el ETA alto es UNA vez por pedido; el «¿ya salió?» una vez por mensaje (conversación + minuto UTC del mensaje, sin PII). */
export function claveDeAlerta(c: CandidatoAlerta): string {
  if (c.tipo === "restaurantes.pedido.eta_alta") return c.orderId;
  const minuto = c.referenciaAt.replace(/[^0-9]/g, "").slice(0, 12);
  return `${c.conversationId ?? c.orderId}:${minuto}`;
}

export async function barrerAlertasAnalitica(session: TenantDbSession, opciones: { readonly now?: Date } = {}): Promise<ResultadoBarridoAnalitica> {
  const { disponible, candidatos } = await listarCandidatosAnalitica(session, opciones);
  if (!disponible) return SIN_BARRIDO;
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  for (const c of candidatos) {
    const r = await emitirNotificacion(session, {
      evento: c.tipo,
      organizationId: c.organizationId,
      propertyId: c.propertyId,
      clave: claveDeAlerta(c),
      parametros: { numero: c.orderNumber, minutos: c.minutos },
      entidadTipo: "order",
      entidadId: c.orderId,
    });
    if (r.estado === "emitida") emitidas += 1;
    else if (r.estado === "sin_nuevas") sinNuevas += 1;
    else errores += 1;
  }
  return { disponible: true, candidatos: candidatos.length, emitidas, sinNuevas, errores };
}

// ---- Gancho de combo ---------------------------------------------------------------------------------------------------------------------------

export type MotivoCombo = "ok" | "sin_borrador" | "sin_combo_vigente" | "ya_incluido" | "agotado" | "no_disponible";
export interface ComboSugerido {
  readonly promocionCodigo: string;
  readonly promocionNombre: string;
  readonly productoId: string;
  readonly productoNombre: string;
}
export interface ResultadoCombo {
  readonly sugerencia: ComboSugerido | null;
  readonly motivo: MotivoCombo;
}

/**
 * Consulta DETERMINISTA para el agente: ¿hay un combo (promoción de cortesía vigente en ESTA sucursal y canal) que se pueda sugerir con lo que ya lleva el
 * borrador? Si no existe en el menú, `sugerencia` es null y el agente NO sugiere nada. El resultado no trae precios ni descuentos: el monto lo da solo
 * `cotizar_pedido`. Base sin migrar o error de la función => `no_disponible` (sin sugerencia), nunca una excepción hacia la conversación.
 */
export async function consultarComboSugerido(
  session: TenantDbSession,
  args: { readonly organizationId: string; readonly propertyId: string; readonly productIds: readonly string[]; readonly canal: "domicilio" | "recoger" | null; readonly now?: Date },
): Promise<ResultadoCombo> {
  try {
    return await runWithSavepointFallback<ResultadoCombo>({
      session,
      primary: async () => {
        const { rows } = await session.query<{ j: unknown }>(
          `select restaurantes.analitica_combo_sugerir($1::uuid, $2::uuid, $3::text[], $4::text, $5::timestamptz) as j;`,
          [args.organizationId, args.propertyId, [...args.productIds], args.canal, args.now ? args.now.toISOString() : null],
        );
        const j = (rows[0]?.j ?? null) as { sugerencia?: Record<string, unknown> | null; motivo?: string } | null;
        const s = j?.sugerencia ?? null;
        const motivo = (j?.motivo ?? "no_disponible") as MotivoCombo;
        if (s && j?.motivo === "ok") {
          return {
            sugerencia: { promocionCodigo: String(s["promocion_codigo"]), promocionNombre: String(s["promocion_nombre"]), productoId: String(s["producto_id"]), productoNombre: String(s["producto_nombre"]) },
            motivo: "ok",
          };
        }
        return { sugerencia: null, motivo };
      },
      isRecoverable: () => true,
      fallback: async () => ({ sugerencia: null, motivo: "no_disponible" }),
    });
  } catch {
    return { sugerencia: null, motivo: "no_disponible" };
  }
}
