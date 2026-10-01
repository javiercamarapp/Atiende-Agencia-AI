// PM PR-9 (restaurantes) -- aviso de privacidad SIMPLIFICADO, aviso de "asistente virtual" (IA) y
// consentimiento de grabacion de la llamada. Documentacion operativa, NO asesoria legal: cada
// responsable debe validar el texto de su aviso de privacidad con su asesor juridico.
//
// El aviso INTEGRAL vive en una URL que el restaurante configura (`privacy_config.notice_url`);
// aqui solo se redacta el simplificado: quien es el responsable, para que se usan los datos, que
// se conserva y por cuanto tiempo, como ejercer derechos ARCO y donde esta el integral.

export const PRIVACY_NOTICE_DEFAULT_VERSION = "v1";
export const CONVERSATION_RETENTION_DAYS_DEFAULT = 180;
export const CONVERSATION_RETENTION_DAYS_MIN = 30;
export const CONVERSATION_RETENTION_DAYS_MAX = 1095;
export const VOICE_RETENTION_DAYS_DEFAULT = 30;
export const VOICE_RETENTION_DAYS_MIN = 0;
export const VOICE_RETENTION_DAYS_MAX = 365;

export interface PrivacyConfig {
  /** Responsable del tratamiento que nombra el aviso; `null` = "este restaurante". */
  readonly responsibleName: string | null;
  /** URL https del aviso de privacidad integral; `null` = el restaurante aun no la configuro. */
  readonly noticeUrl: string | null;
  readonly noticeVersion: string;
  readonly conversationRetentionDays: number;
  /** 0 = no se persiste ninguna transcripcion de voz. */
  readonly voiceRetentionDays: number;
  readonly recordingConsentRequired: boolean;
  /** `false` cuando la organizacion nunca guardo configuracion (o la base no esta migrada): los
   * valores son los de partida y SON los que aplica la base por defecto. */
  readonly configurada: boolean;
}

export type PrivacyConfigEntrada = Omit<PrivacyConfig, "configurada">;

export const PRIVACY_CONFIG_POR_DEFECTO: PrivacyConfig = {
  responsibleName: null,
  noticeUrl: null,
  noticeVersion: PRIVACY_NOTICE_DEFAULT_VERSION,
  conversationRetentionDays: CONVERSATION_RETENTION_DAYS_DEFAULT,
  voiceRetentionDays: VOICE_RETENTION_DAYS_DEFAULT,
  recordingConsentRequired: true,
  configurada: false,
};

const NOTICE_URL_RE = /^https:\/\/\S+$/;
const NOTICE_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** Validacion de la configuracion (espeja los CHECK de la tabla). Devuelve el primer error o null. */
export function validatePrivacyConfig(entrada: PrivacyConfigEntrada): string | null {
  if (entrada.responsibleName !== null && (entrada.responsibleName.length < 1 || entrada.responsibleName.length > 200)) {
    return "responsibleName: de 1 a 200 caracteres.";
  }
  if (entrada.noticeUrl !== null && (!NOTICE_URL_RE.test(entrada.noticeUrl) || entrada.noticeUrl.length > 500)) {
    return "noticeUrl: se esperaba una URL https de hasta 500 caracteres.";
  }
  if (!NOTICE_VERSION_RE.test(entrada.noticeVersion)) return "noticeVersion: de 1 a 32 caracteres (letras, números, punto, guion).";
  if (!Number.isInteger(entrada.conversationRetentionDays) || entrada.conversationRetentionDays < CONVERSATION_RETENTION_DAYS_MIN || entrada.conversationRetentionDays > CONVERSATION_RETENTION_DAYS_MAX) {
    return `conversationRetentionDays: entero entre ${CONVERSATION_RETENTION_DAYS_MIN} y ${CONVERSATION_RETENTION_DAYS_MAX}.`;
  }
  if (!Number.isInteger(entrada.voiceRetentionDays) || entrada.voiceRetentionDays < VOICE_RETENTION_DAYS_MIN || entrada.voiceRetentionDays > VOICE_RETENTION_DAYS_MAX) {
    return `voiceRetentionDays: entero entre ${VOICE_RETENTION_DAYS_MIN} y ${VOICE_RETENTION_DAYS_MAX}.`;
  }
  return null;
}

function integralNotice(config: PrivacyConfig): string {
  return config.noticeUrl ? `Aviso de privacidad integral: ${config.noticeUrl}` : "Pide el aviso de privacidad integral al restaurante.";
}

export function businessNameOf(config: PrivacyConfig): string {
  return config.responsibleName ?? "este restaurante";
}

/** Aviso simplificado + aviso de IA para el PRIMER mensaje de WhatsApp. Breve a proposito. */
export function privacyNoticeWhatsApp(config: PrivacyConfig): string {
  const businessName = businessNameOf(config);
  return (
    `Soy el asistente virtual (una inteligencia artificial) de ${businessName}. ` +
    "Aviso de privacidad: uso tu nombre, teléfono, dirección y pedidos solo para tomar y entregar tu pedido y darte atención; " +
    `guardo esta conversación ${config.conversationRetentionDays} días. ` +
    "Puedes acceder, rectificar, cancelar u oponerte al uso de tus datos (ARCO) escribiendo \"mis datos personales\". " +
    integralNotice(config)
  );
}

/** Antepone el aviso a la respuesta del turno (el aviso va primero y la respuesta sigue). */
export function composeWithPrivacyNotice(notice: string, reply: string): string {
  const body = reply.trim();
  return body ? `${notice}\n\n${body}` : notice;
}

/** Guion de apertura de la llamada: asistente virtual (IA) + aviso simplificado + consentimiento
 * de grabacion. Con retencion de voz 0 la llamada NUNCA se graba y no se pide consentimiento. */
export function voiceOpeningScript(config: PrivacyConfig): string {
  const businessName = businessNameOf(config);
  const intro =
    `Hola, soy el asistente virtual de ${businessName}; soy una inteligencia artificial, no una persona. ` +
    "Aviso de privacidad: uso tus datos solo para tomar y entregar tu pedido. " +
    (config.noticeUrl ? "El aviso integral está en nuestra página; también puedes pedirlo en la sucursal. " : "Puedes pedir el aviso integral en la sucursal. ") +
    "Para ejercer tus derechos sobre tus datos, escribe por WhatsApp o dile a la sucursal. ";
  if (config.voiceRetentionDays === 0) return `${intro}Esta llamada no se graba.`;
  if (!config.recordingConsentRequired) {
    return `${intro}Esta llamada se transcribe y se guarda ${config.voiceRetentionDays} días para mejorar el servicio.`;
  }
  return (
    `${intro}¿Autorizas que esta llamada se grabe y se transcriba para mejorar el servicio? ` +
    `Se guarda ${config.voiceRetentionDays} días. Si dices que no, te atiendo igual, sin grabar.`
  );
}

export const VOICE_CONSENT_GRANTED_REPLY = "Gracias, queda registrado. ¿Qué te gustaría pedir?";
export const VOICE_CONSENT_DENIED_REPLY = "Sin problema: esta llamada no se graba. ¿Qué te gustaría pedir?";
export const VOICE_CONSENT_REPEAT_REPLY = "No te escuché bien: ¿autorizas que se grabe la llamada? Puedes decir sí o no; si no respondes, no se graba.";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CONSENT_NO_RE = /^(no|nel|no gracias|no autorizo|no lo autorizo|no acepto|no quiero|no quiero que (se )?(grabe|graben|me graben)|prefiero que no|mejor no|no grabes|no graben|no me grabes)\b/;
const CONSENT_YES_RE = /^(si|sip|claro|por supuesto|de acuerdo|ok|esta bien|acepto|si acepto|si autorizo|autorizo|si lo autorizo|adelante|si graba|si grabe|puedes grabar|si pueden grabar)\b/;

/** Interpreta la respuesta a la pregunta de grabacion. CONSERVADORA: cualquier cosa ambigua es
 * `null` (se trata como NO consentimiento: no se graba). "No" siempre gana sobre "si". */
export function interpretRecordingConsent(text: string): "otorgado" | "negado" | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  if (CONSENT_NO_RE.test(normalized) || /\bno\b.*\b(grab|autoriz|acept)/.test(normalized)) return "negado";
  // Un "no" suelto junto a un "si" ("si no quiero") es ambiguo: no se graba.
  if (/\bno\b/.test(normalized)) return null;
  if (CONSENT_YES_RE.test(normalized)) return "otorgado";
  return null;
}
