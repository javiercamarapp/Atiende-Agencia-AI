// Captura de consentimiento (opt-in) de marketing EN LA CONVERSACION del agente (PM R23, F3). Sin presionar:
//   * se pregunta UNA sola vez, solo DESPUES de un pedido creado con exito (nunca a mitad de un pedido), solo si la bandera `optin_conversacional` esta prendida;
//   * nunca a quien tiene queja reciente, a quien ya otorgo, a quien ya REVOCO (BAJA) ni a quien ya contesto/ignoro la pregunta hace menos de 90 dias;
//   * solo un SI explicito (mensaje completo) otorga consentimiento (fuente `agente_whatsapp`, evento inmutable en la 052); un NO se registra y no se repite;
//   * el silencio no es consentimiento. BAJA/STOP lo atiende antes el webhook (revoca) y no llega aqui.
// Todo es best-effort: ningun error de este modulo altera el turno ni la respuesta del pedido. Base sin migrar = no pregunta.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";

export const PREGUNTA_OPTIN = "¿Quiere que le avisemos de promociones y de su favorito por este WhatsApp? Responda SÍ o NO. Puede escribir BAJA en cualquier momento para dejar de recibir avisos.";
export const OPTIN_ACEPTADO_TEXTO = "Listo, le avisaremos por aquí. Cuando quiera dejar de recibir avisos, escriba BAJA.";
export const OPTIN_RECHAZADO_TEXTO = "Sin problema, no le enviaremos promociones. Seguimos a sus órdenes.";

const SI = new Set(["si", "claro", "claro que si", "si quiero", "si por favor", "si gracias", "si acepto", "acepto", "dale", "va", "simon"]);
const NO = new Set(["no", "no gracias", "no por favor", "nel", "no quiero", "ahorita no", "no acepto"]);

/** Solo el mensaje COMPLETO cuenta: «sí, pero a qué hora abren» no es una respuesta al opt-in. */
export function clasificarRespuestaOptIn(texto: string): "si" | "no" | null {
  const limpio = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (SI.has(limpio)) return "si";
  if (NO.has(limpio)) return "no";
  return null;
}

export interface ContextoOptIn {
  readonly customerId: string;
  readonly habilitado: boolean;
  readonly preguntaAbierta: boolean;
  readonly puedePreguntar: boolean;
}

export interface OptInPuerto {
  contexto(organizationId: string, telefono: string, now: Date): Promise<ContextoOptIn | null>;
  marcarPregunta(organizationId: string, customerId: string, now: Date): Promise<boolean>;
  responder(organizationId: string, telefono: string, si: boolean, now: Date): Promise<"otorgado" | "rechazado" | "sin_pregunta">;
}

/** Antes del LLM: si el mensaje es un SI/NO explicito Y hay una pregunta abierta, responde en fijo. `null` = el turno sigue su camino normal. */
export async function responderOptInDeterminista(puerto: OptInPuerto, organizationId: string, telefono: string, texto: string, now: Date = new Date()): Promise<{ readonly reply: string } | null> {
  const clase = clasificarRespuestaOptIn(texto);
  if (clase === null) return null;
  try {
    const r = await puerto.responder(organizationId, telefono, clase === "si", now);
    if (r === "otorgado") return { reply: OPTIN_ACEPTADO_TEXTO };
    if (r === "rechazado") return { reply: OPTIN_RECHAZADO_TEXTO };
    return null;
  } catch {
    return null;
  }
}

/** Despues de un pedido creado: agrega la pregunta UNA vez a la respuesta. Nunca lanza; si algo falla devuelve la respuesta intacta. */
export async function anexarPreguntaOptIn(puerto: OptInPuerto, organizationId: string, telefono: string, reply: string, now: Date = new Date()): Promise<string> {
  try {
    const ctx = await puerto.contexto(organizationId, telefono, now);
    if (!ctx || !ctx.habilitado || !ctx.puedePreguntar || ctx.preguntaAbierta) return reply;
    if (!(await puerto.marcarPregunta(organizationId, ctx.customerId, now))) return reply;
    return `${reply}\n\n${PREGUNTA_OPTIN}`;
  } catch {
    return reply;
  }
}

export function crearOptInPostgres(session: TenantDbSession): OptInPuerto {
  return {
    contexto: (org, tel, now) =>
      runWithSavepointFallback<ContextoOptIn | null>({
        session,
        savepointName: "sp_optin_ctx",
        primary: async () => {
          const r = (await session.query<Record<string, unknown>>(`select * from restaurantes.reactivacion_optin_contexto($1::uuid, $2::text, $3::timestamptz);`, [org, tel, now.toISOString()])).rows[0];
          return r ? { customerId: String(r.customer_id), habilitado: r.habilitado === true, preguntaAbierta: r.pregunta_abierta === true, puedePreguntar: r.puede_preguntar === true } : null;
        },
        isRecoverable: isMigrationPendingError,
        fallback: async () => null,
      }),
    marcarPregunta: (org, cliente, now) =>
      runWithSavepointFallback<boolean>({
        session,
        savepointName: "sp_optin_marcar",
        primary: async () => (await session.query<{ ok: boolean }>(`select restaurantes.reactivacion_optin_marcar($1::uuid, $2::uuid, $3::timestamptz) as ok;`, [org, cliente, now.toISOString()])).rows[0]?.ok === true,
        isRecoverable: isMigrationPendingError,
        fallback: async () => false,
      }),
    responder: (org, tel, si, now) =>
      runWithSavepointFallback<"otorgado" | "rechazado" | "sin_pregunta">({
        session,
        savepointName: "sp_optin_responder",
        primary: async () => {
          const r = (await session.query<{ r: string }>(`select restaurantes.reactivacion_optin_responder($1::uuid, $2::text, $3::boolean, $4::timestamptz) as r;`, [org, tel, si, now.toISOString()])).rows[0]?.r;
          return r === "otorgado" || r === "rechazado" ? r : "sin_pregunta";
        },
        isRecoverable: isMigrationPendingError,
        fallback: async () => "sin_pregunta",
      }),
  };
}
