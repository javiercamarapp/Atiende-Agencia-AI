// Formas mínimas compartidas del gateway de WhatsApp saliente. Deliberadamente
// desacoplado de cualquier esquema de `messaging_outbox` concreto — las 3
// verticales (citas/hoteles/restaurantes) adaptan su propio payload jsonb a esta
// forma en `outbox-port.ts` (ver ese archivo para el porqué de la validación ahí y
// no aquí).

/** Botón de respuesta rápida con id propio (C-01): el `id` vuelve tal cual en el
 *  `button_reply.id` del webhook entrante, así el recordatorio puede atar el toque a
 *  UNA cita concreta (p. ej. `cita:confirmar:<appointmentId>`) en vez del `btn_N`
 *  posicional que no identifica nada. Una cadena sola sigue siendo válida (título
 *  con id posicional `btn_N`, comportamiento anterior). */
export interface OutboundButton {
  /** 1-256 caracteres (límite de Graph API para `reply.id`). */
  readonly id: string;
  /** 1-20 caracteres (límite de Graph API para el título del botón). */
  readonly title: string;
}

/** Plantilla HSM de WhatsApp (R-27): un mensaje que el NEGOCIO inicia fuera de la ventana de 24 h de Meta solo
 *  se entrega si es una plantilla PRE-APROBADA por Meta. `name`/`language` son los de la plantilla aprobada en
 *  el Business Manager y `params` los valores de las variables `{{1}}`, `{{2}}`... de su cuerpo, en orden.
 *
 *  El encolador SOLO declara la plantilla que corresponde al evento; que se use de verdad lo decide el cliente
 *  de Graph API segun las plantillas que el operador declaro aprobadas (`approvedTemplates` de
 *  `MetaGraphWhatsAppClient`). Una plantilla no declarada aprobada NUNCA se envia como `type: "template"`:
 *  el mensaje sale como texto libre (comportamiento anterior, valido solo dentro de la ventana de 24 h). */
export interface OutboundTemplate {
  /** Nombre de la plantilla en Meta: minusculas, digitos y guion bajo, 1-512 caracteres. */
  readonly name: string;
  /** Codigo de idioma de la plantilla en Meta (por ejemplo `es_MX`). */
  readonly language: string;
  /** Valores de las variables del cuerpo, en orden. Maximo 10; cada uno 1-1024 caracteres sin saltos de linea. */
  readonly params: readonly string[];
  /** Plantillas de AUTENTICACION (codigo de un solo uso): Meta exige repetir el codigo como parametro del boton "copiar codigo"
   *  (`sub_type: "url"`, indice 0). 1-15 caracteres alfanumericos. Ausente = la plantilla no lleva boton de codigo. */
  readonly codigoBoton?: string;
}

export const TEMPLATE_CODE_BUTTON_PATTERN = /^[A-Za-z0-9]{1,15}$/;
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
export const TEMPLATE_LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const MAX_TEMPLATE_PARAMS = 10;
export const MAX_TEMPLATE_PARAM_LENGTH = 1024;

/** Documento adjunto (p. ej. el menu en PDF): Meta lo descarga del enlace PUBLICO https (`type: "document"` + `link`), no se suben binarios. Con documento,
 *  `body` es el pie (caption, 1-1024 caracteres). Exclusivo: no se combina con botones, plantilla ni solicitud de ubicacion. */
export interface OutboundDocument {
  /** https publico, hasta 2048 caracteres. */
  readonly url: string;
  /** Nombre que ve el cliente; debe terminar en `.pdf` (1-240 caracteres, sin `/`, `\\` ni saltos de linea). */
  readonly filename: string;
  /** Si Meta no puede traer el archivo (4xx de forma/medio), el cliente recibe `body` + este enlace como texto en vez de quedarse sin respuesta. Ausente = el propio `url`. */
  readonly fallbackUrl?: string;
}

export const DOCUMENT_URL_MAX_LENGTH = 2048;
export const DOCUMENT_FILENAME_PATTERN = /^[^/\\\r\n]{1,236}\.pdf$/i;

/** `true` si es un https bien formado, sin credenciales incrustadas y dentro del tope de longitud (Meta descarga el archivo desde internet). */
export function esUrlHttpsPublica(valor: unknown): boolean {
  if (typeof valor !== "string" || valor.length === 0 || valor.length > DOCUMENT_URL_MAX_LENGTH) return false;
  try {
    const u = new URL(valor);
    return u.protocol === "https:" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

export interface OutboundWhatsAppMessagePayload {
  /** Número del destinatario en formato E.164 con o sin "+" (Graph API acepta
   *  ambos; se pasa tal cual llegó del encolador). */
  readonly to: string;
  /** `phone_number_id` de Meta Business — cuál número REMITENTE de la
   *  plataforma envía este mensaje (1 por organización/property según la
   *  vertical, ver `whatsapp_config`/`whatsapp_channel_config` de cada dominio). */
  readonly phoneNumberId: string;
  readonly body: string;
  /** Hasta 3 botones de respuesta rápida (interactive/button de Graph API) — usado
   *  hoy por el recordatorio 24h de citas (Confirmar/Cancelar/Reagendar). Sin
   *  botones, se manda como mensaje de texto plano. */
  readonly buttons?: readonly (string | OutboundButton)[];
  /** Plantilla HSM opcional (ver `OutboundTemplate`). `body` sigue siendo obligatorio: es el texto libre de
   *  respaldo cuando la plantilla no esta declarada como aprobada. */
  readonly template?: OutboundTemplate;
  /** PL-31: el despachador ya verifico que la organizacion duena del mensaje tiene ESTA plantilla en estado aprobada en su
   *  catalogo (`core.whatsapp_plantilla`). Con `true` el cliente la envia como `type: "template"` aunque no este en la lista
   *  global de plantillas aprobadas del entorno. Ausente o `false` = decide solo la lista global (comportamiento anterior). */
  readonly templateApproved?: boolean;
  /** Mensaje que SOLO puede salir como plantilla aprobada (p. ej. un codigo de acceso): si la plantilla no esta aprobada el cliente lanza
   *  `WhatsAppInvalidPayloadError` (no reintentable) y NUNCA cae a texto libre, botones ni ningun otro tipo de mensaje. */
  readonly soloPlantilla?: boolean;
  /** Mensaje interactivo `location_request_message` de la Cloud API: el cliente comparte su ubicacion con un toque. `body` es el texto que
   *  acompana al boton. Exclusivo (no se combina con botones ni plantilla) y solo vale dentro de la ventana de 24 h del cliente. */
  readonly solicitarUbicacion?: boolean;
  /** Documento adjunto por enlace publico (ver `OutboundDocument`); `body` es su pie. Exclusivo. Solo vale dentro de la ventana de 24 h del cliente. */
  readonly documento?: OutboundDocument;
}

/** Como salio de verdad el mensaje hacia Meta. Sirve para explicar un fallo de entrega: un 131047 (fuera de la ventana de 24 h) con
 *  `texto` y una plantilla disponible en el payload significa "habia plantilla pero no se uso" (no estaba declarada aprobada). */
export type EnviadoComo = "texto" | "plantilla" | "botones" | "ubicacion";
// Un documento NO tiene valor propio: la columna `enviado_como` tiene un check de 4 valores (migracion 066) y no se tocan migraciones; el envio de un documento
// devuelve `enviadoComo` ausente (se guarda NULL) salvo cuando degrada a texto.

export interface WhatsAppSendResult {
  /** `messages[0].id` (wamid) que devuelve Graph API en un envío exitoso. El despachador lo entrega a `MessagingOutboxPort.markSent`
   *  para guardarlo en el outbox: es la llave con la que los `statuses` del webhook (delivered/read/failed) encuentran el mensaje. */
  readonly providerMessageId: string;
  /** Tipo de mensaje que se envio. Opcional: un cliente que no lo informa (dobles de prueba antiguos) no rompe nada. */
  readonly enviadoComo?: EnviadoComo;
}

/** Puerto que el dispatcher consume — `MetaGraphWhatsAppClient` es el adaptador de
 *  producción real; `FakeWhatsAppGraphClient` (providers/fake-graph-client.ts) es
 *  el doble determinista para tests, NUNCA toca la red. */
export interface WhatsAppGraphClient {
  sendMessage(message: OutboundWhatsAppMessagePayload): Promise<WhatsAppSendResult>;
}
