// Cliente web para los 3 endpoints de mensajería que Aprobaciones.tsx todavía no
// consumía (hallazgo de auditoría: "la mensajería con aprobación humana no es
// operable de punta a punta -- Aprobaciones.tsx solo aprueba/rechaza lo que YA
// existe, pero no hay forma de sembrar la bandeja"):
//   - POST .../unidades/:unidadId/conversaciones      (abrir conversación)
//   - POST .../conversaciones/:conversacionId/mensajes (registrar mensaje ENTRANTE)
//   - POST .../conversaciones/:conversacionId/borradores (pedirle al agente un borrador)
// Los 3 ya existían y estaban probados en el backend
// (apps/api/src/routes/verticals/rentas/mensajeria-conversaciones.ts,
// mensajeria-borradores.ts) desde antes de esta fase -- solo faltaba el cliente web,
// mismo hallazgo exacto que ya cerró mensajeria-client.ts para aprobar/rechazar.
//
// Archivo separado de mensajeria-client.ts (en vez de agregarle funciones) porque
// mensajeria-client.ts es sobre LEER la bandeja de aprobación ya poblada; este es
// sobre POBLARLA -- mismo criterio de separación lectura/escritura que
// calendario-client.ts (lee ocupación) vs. las mutaciones de reservas.ts/bloqueos.ts
// en ese mismo archivo. Los tipos de registro (`ConversacionRecord`, `BorradorRecord`,
// `CanalMensajeriaCodigo`, `CANALES_MENSAJERIA`) se REUSAN de mensajeria-client.ts en
// vez de redeclararse -- evita que ambos archivos diverjan en la forma del JSON que
// en realidad viaja por la misma conexión HTTP.
//
// `fetchJson`/`sendJson` (./admin-client.ts) ya envuelven cada llamada con
// `withAuthRefresh` -- mismo patrón exacto que el resto de lib/*.ts de este vertical,
// sin nada especial que hacer aquí para heredarlo.
import { sendJson } from "./admin-client.ts";
import type { BorradorRecord, CanalMensajeriaCodigo, ConversacionRecord } from "./mensajeria-client.ts";

/** Espejo de `DireccionMensaje`/`OrigenMensaje`
 * (packages/domain-rentas/src/mensajeria/tipos.ts) -- redeclarado aquí porque
 * apps/web no depende de @atiende/domain-rentas (ver cabecera de
 * calendario-client.ts). `"canal"` no es alcanzable desde este cliente: ningún
 * adaptador real de WhatsApp/Airbnb/Vrbo está conectado todavía (ver
 * SimuladorCanalMensajeria y el aviso de Aprobaciones.tsx) -- lo único que un
 * humano puede registrar aquí es `"manual"` (transcribe un mensaje recibido fuera
 * de banda) o dejar que el servidor use su default `"simulador"`. */
export type DireccionMensaje = "entrante" | "saliente";
export type OrigenMensajeRegistrable = "manual" | "simulador";

export interface MensajeRecord {
  readonly id: string;
  readonly conversacionId: string;
  readonly direccion: DireccionMensaje;
  readonly origen: OrigenMensajeRegistrable | "canal";
  readonly texto: string;
  readonly redactado: boolean;
  readonly creadoEn: string;
}

export type SenalEscalamiento = "queja" | "emergencia" | "reembolso" | "vip";

export interface BorradorGeneradoRecord extends BorradorRecord {
  readonly necesitaEscalamiento: boolean;
  readonly senales: readonly SenalEscalamiento[];
}

export interface NuevaConversacionInput {
  readonly canal: CanalMensajeriaCodigo;
  readonly propiedadNombre: string;
  readonly ocupacionId?: string | null;
  readonly huespedMinimoId?: string | null;
  readonly huespedNombre?: string | null;
  readonly fechaCheckIn?: string | null;
  readonly fechaCheckOut?: string | null;
}

/** POST .../unidades/:unidadId/conversaciones -- abre una conversación de
 * mensajería para una unidad+canal. Requiere `MENSAJERIA_ESCRITURA_ROLES`
 * (packages/domain-rentas/src/roles.ts) del lado del servidor -- este cliente no
 * repite esa lista, el caller (Aprobaciones.tsx) ya gatea el botón con la misma
 * constante que usa para aprobar/rechazar. */
export async function crearConversacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  input: NuevaConversacionInput,
): Promise<ConversacionRecord> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/conversaciones`, token, "POST", input);
}

/** POST .../unidades/:unidadId/conversaciones/:conversacionId/mensajes -- registra
 * un mensaje ENTRANTE del huésped. `origen` por defecto es `"manual"` (no
 * `"simulador"`): quien usa este cliente es SIEMPRE un humano transcribiendo un
 * mensaje que llegó fuera de banda -- no existe todavía un adaptador real de canal
 * que dispare esto por su cuenta (ver nota de Aprobaciones.tsx). */
export async function registrarMensajeEntrante(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  conversacionId: string,
  texto: string,
  origen: OrigenMensajeRegistrable = "manual",
): Promise<MensajeRecord> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/conversaciones/${conversacionId}/mensajes`, token, "POST", { texto, origen });
}

export interface GenerarBorradorInput {
  /** Mensaje entrante a partir del cual se redacta -- omitirlo genera un borrador
   * con texto de entrada vacío (ver GeneradorBorradorPlantillas), un estado legítimo
   * para plantillas proactivas, pero este cliente siempre lo manda: la UI que lo
   * consume siempre acaba de registrar el mensaje que quiere responder. */
  readonly mensajeEntranteId?: string;
  /** `true` conecta el generador respaldado por LLM en vez del motor determinista de
   * plantillas -- si el ambiente no tiene `deps.llmGateway` configurado, el servidor
   * responde 503 explícito en vez de degradar en silencio (ver cabecera de
   * mensajeria-borradores.ts). */
  readonly usarIa?: boolean;
}

/** POST .../conversaciones/:conversacionId/borradores -- le pide al agente (motor de
 * plantillas por defecto, o al LLM si `usarIa: true`) que redacte un borrador de
 * respuesta. El borrador SIEMPRE nace en `pendiente_aprobacion` -- este endpoint
 * nunca envía nada, solo llena la bandeja que Aprobaciones.tsx ya sabe aprobar o
 * rechazar. */
export async function generarBorrador(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  conversacionId: string,
  input: GenerarBorradorInput = {},
): Promise<BorradorGeneradoRecord> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/conversaciones/${conversacionId}/borradores`, token, "POST", input);
}
