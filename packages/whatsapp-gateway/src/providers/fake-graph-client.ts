// FakeWhatsAppGraphClient — doble determinista para tests, NUNCA toca la red. Mismo
// rol que providers/fake-provider.ts en agent-core: registra cada llamada
// (`sent`) y deja que el test decida, por llamada, si falla y con qué error vía
// `onSend`.
import type { WhatsAppSendError } from "../errors.ts";
import type { OutboundWhatsAppMessagePayload, WhatsAppGraphClient, WhatsAppSendResult } from "../types.ts";

export interface FakeWhatsAppGraphClientOptions {
  /** Se llama en CADA envío (antes de "aceptarlo"), con el índice de llamada
   *  (0-based). Devolver un `WhatsAppSendError` hace que `sendMessage` lo lance;
   *  devolver `undefined`/no devolver nada deja pasar el envío como éxito. */
  readonly onSend?: (message: OutboundWhatsAppMessagePayload, callIndex: number) => WhatsAppSendError | void;
}

export class FakeWhatsAppGraphClient implements WhatsAppGraphClient {
  readonly sent: OutboundWhatsAppMessagePayload[] = [];

  constructor(private readonly opts: FakeWhatsAppGraphClientOptions = {}) {}

  async sendMessage(message: OutboundWhatsAppMessagePayload): Promise<WhatsAppSendResult> {
    const callIndex = this.sent.length;
    this.sent.push(message);
    const err = this.opts.onSend?.(message, callIndex);
    if (err) throw err;
    return { providerMessageId: `fake-msg-${callIndex}` };
  }
}
