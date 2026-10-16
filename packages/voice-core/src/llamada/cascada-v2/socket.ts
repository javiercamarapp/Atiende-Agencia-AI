// WebSocket minimo que usan los adaptadores de Deepgram (STT y TTS). En produccion es el `WebSocket` global de Node >= 22 (undici, acepta `headers`);
// en pruebas, un doble. La llave viaja SOLO en la cabecera `Authorization: Token <llave>` y esa URL/cabecera nunca se loguea.
import { VozProveedorError } from "../../provider.ts";

export interface SocketDeepgram {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /** Node >= 26 entrega los mensajes binarios como `Blob` por defecto; con "arraybuffer" llegan ya decodificables. */
  binaryType?: string;
}

export interface OpcionesSocketDeepgram {
  readonly headers: Readonly<Record<string, string>>;
}

export type CrearSocketDeepgram = (url: string, opciones: OpcionesSocketDeepgram) => SocketDeepgram;

export function crearSocketDeepgramGlobal(url: string, opciones: OpcionesSocketDeepgram): SocketDeepgram {
  const WS = (globalThis as { WebSocket?: new (url: string, init?: unknown) => SocketDeepgram }).WebSocket;
  if (!WS) throw new VozProveedorError("Este entorno no trae WebSocket (se requiere Node 22 o superior).");
  return new WS(url, { headers: opciones.headers });
}

export type MensajeSocket = { readonly tipo: "texto"; readonly texto: string } | { readonly tipo: "binario"; readonly bytes: Uint8Array };

const esBlob = (data: unknown): data is Blob => typeof Blob !== "undefined" && data instanceof Blob;

function aMensaje(data: unknown): MensajeSocket | null {
  if (typeof data === "string") return { tipo: "texto", texto: data };
  if (data instanceof ArrayBuffer) return { tipo: "binario", bytes: new Uint8Array(data) };
  if (ArrayBuffer.isView(data)) return { tipo: "binario", bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  return null;
}

/**
 * Handler de `onmessage` que conserva el ORDEN de llegada aunque algun mensaje llegue como `Blob` (lectura asincrona): los que llegan despues de un Blob en
 * vuelo esperan su turno. Cada mensaje se entrega ya clasificado en texto o binario.
 */
export function crearLectorMensajes(alMensaje: (m: MensajeSocket) => void): (ev: { data: unknown }) => void {
  let cola: Promise<void> = Promise.resolve();
  let blobsEnVuelo = 0;
  return (ev) => {
    const data = ev.data;
    if (esBlob(data)) {
      blobsEnVuelo++;
      cola = cola
        .then(() => data.arrayBuffer())
        .then((buf) => {
          const m = aMensaje(buf);
          if (m) alMensaje(m);
        })
        .catch(() => undefined)
        .finally(() => {
          blobsEnVuelo--;
        });
      return;
    }
    const m = aMensaje(data);
    if (!m) return;
    if (blobsEnVuelo > 0) {
      cola = cola.then(() => alMensaje(m));
      return;
    }
    alMensaje(m);
  };
}
