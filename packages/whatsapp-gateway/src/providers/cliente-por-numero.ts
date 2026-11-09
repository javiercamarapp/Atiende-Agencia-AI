// WhatsAppGraphClientPorNumero — elige el token de Meta por el numero REMITENTE (`phoneNumberId`) del mensaje.
//
// Credenciales por organizacion (migracion 0090 de packages/db): un negocio que registra sus numeros en SU propio portafolio de
// Meta trae su propio token de usuario de sistema. Para un numero con credencial propia el mensaje sale con un
// `WhatsAppGraphClient` de ESE token; para cualquier otro numero, con el cliente de plataforma (WHATSAPP_ACCESS_TOKEN), igual que
// antes. Sin credencial ni plataforma: `WhatsAppConfigError` (no reintentable), nunca un envio fingido.
//
// Si la credencial no se puede leer (base caida), el error es REINTENTABLE y nunca cae al token de plataforma: mandar el mensaje de
// un numero ajeno con el token equivocado solo produce un rechazo de Meta y gasta un intento.
import { WhatsAppConfigError, WhatsAppSendError } from "../errors.ts";
import type { OutboundWhatsAppMessagePayload, WhatsAppGraphClient, WhatsAppSendResult } from "../types.ts";

export interface ResolutorTokenPorNumero {
  /** Token de la credencial propia del numero, o `null` si el numero usa la plataforma. Puede lanzar si la fuente falla. */
  tokenDeNumero(phoneNumberId: string): Promise<string | null>;
}

export interface WhatsAppGraphClientPorNumeroOptions {
  /** Cliente con el token de plataforma; ausente si WHATSAPP_ACCESS_TOKEN no esta configurado. */
  readonly plataforma?: WhatsAppGraphClient;
  readonly resolutor: ResolutorTokenPorNumero;
  /** Construye el cliente real de un token (en produccion, `MetaGraphWhatsAppClient`). */
  readonly crearCliente: (accessToken: string) => WhatsAppGraphClient;
}

/** Tope de clientes en memoria: al rotar tokens no crece sin limite (se vacia y se reconstruye bajo demanda). */
const MAX_CLIENTES = 64;

export class WhatsAppGraphClientPorNumero implements WhatsAppGraphClient {
  private readonly clientes = new Map<string, WhatsAppGraphClient>();

  constructor(private readonly opts: WhatsAppGraphClientPorNumeroOptions) {}

  async sendMessage(message: OutboundWhatsAppMessagePayload): Promise<WhatsAppSendResult> {
    let token: string | null;
    try {
      token = await this.opts.resolutor.tokenDeNumero(message.phoneNumberId);
    } catch {
      throw new WhatsAppSendError("no se pudo leer la credencial de Meta del numero remitente", true);
    }
    if (token) return this.clienteDe(token).sendMessage(message);
    if (this.opts.plataforma) return this.opts.plataforma.sendMessage(message);
    throw new WhatsAppConfigError("el numero remitente no tiene credencial de Meta propia y WHATSAPP_ACCESS_TOKEN no esta configurado");
  }

  private clienteDe(token: string): WhatsAppGraphClient {
    const existente = this.clientes.get(token);
    if (existente) return existente;
    if (this.clientes.size >= MAX_CLIENTES) this.clientes.clear();
    const nuevo = this.opts.crearCliente(token);
    this.clientes.set(token, nuevo);
    return nuevo;
  }
}
