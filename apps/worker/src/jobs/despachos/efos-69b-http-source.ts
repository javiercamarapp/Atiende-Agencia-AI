// HttpEfos69bSource -- adaptador HTTP de `Efos69bSource` (D-28): baja el CSV publico "Listado completo 69-B" del SAT.
//
// NO VERIFICADO: la URL por defecto es la ruta historica del SAT (cifras_sat/Documents/Listado_Completo_69-B.csv) y no se pudo
// comprobar desde este entorno (sin llamadas al SAT ni salida de red desde Vercel verificada). Se configura con la variable
// EFOS_69B_URL; si el SAT mueve el archivo basta cambiarla, sin tocar codigo.
//
// Defensas: lectura por STREAMING con tope de bytes (se cancela el cuerpo en cuanto lo supera: un archivo gigante no llena la
// memoria de la funcion), timeout total, solo http(s), y decodificacion UTF-8 con respaldo a Windows-1252 (decodificarListado69B).
// La descarga ocurre dentro del cron, no por el cuerpo de una peticion, asi que no aplica el tope de 4 MB de la subida manual.
import { decodificarListado69B } from "@atiende/domain-despachos";
import type { Efos69bSource } from "./efos-69b-ingestion.ts";

export const EFOS_69B_URL_DEFECTO = "https://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv";
/** La edicion completa pesa del orden de 10-20 MB; 40 MB deja holgura sin permitir un archivo arbitrario. */
export const EFOS_69B_MAX_BYTES_DEFECTO = 40 * 1024 * 1024;
export const EFOS_69B_TIMEOUT_MS_DEFECTO = 20_000;

export class Efos69bDescargaError extends Error {
  constructor(
    readonly motivo: "url_invalida" | "http" | "red" | "timeout" | "demasiado_grande" | "vacio",
    mensaje: string,
  ) {
    super(mensaje);
    this.name = "Efos69bDescargaError";
  }
}

export interface HttpEfos69bSourceOpciones {
  readonly url?: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class HttpEfos69bSource implements Efos69bSource {
  private readonly url: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opciones: HttpEfos69bSourceOpciones = {}) {
    this.url = (opciones.url ?? "").trim() || EFOS_69B_URL_DEFECTO;
    this.maxBytes = opciones.maxBytes ?? EFOS_69B_MAX_BYTES_DEFECTO;
    this.timeoutMs = opciones.timeoutMs ?? EFOS_69B_TIMEOUT_MS_DEFECTO;
    this.fetchImpl = opciones.fetchImpl ?? fetch;
  }

  /** La URL no distingue periodo: el SAT publica SIEMPRE la edicion vigente; el periodo solo etiqueta la ingesta. */
  async obtenerListado(_periodo: string): Promise<string> {
    let destino: URL;
    try {
      destino = new URL(this.url);
    } catch {
      throw new Efos69bDescargaError("url_invalida", "EFOS_69B_URL no es una URL valida.");
    }
    if (destino.protocol !== "https:" && destino.protocol !== "http:") throw new Efos69bDescargaError("url_invalida", "EFOS_69B_URL debe ser http(s).");

    let res: Response;
    try {
      res = await this.fetchImpl(destino, { method: "GET", headers: { Accept: "text/csv,*/*" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const nombre = err && typeof err === "object" ? (err as { name?: string }).name : undefined;
      if (nombre === "TimeoutError" || nombre === "AbortError") throw new Efos69bDescargaError("timeout", "Se agoto el tiempo de descarga de la lista 69-B.");
      throw new Efos69bDescargaError("red", "No se pudo conectar para descargar la lista 69-B.");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Efos69bDescargaError("http", `El SAT respondio HTTP ${res.status} al descargar la lista 69-B.`);
    }
    const declarado = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declarado) && declarado > this.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Efos69bDescargaError("demasiado_grande", `El archivo declara ${declarado} bytes; el tope es ${this.maxBytes}.`);
    }

    const bytes = await this.leerConTope(res);
    if (bytes.byteLength === 0) throw new Efos69bDescargaError("vacio", "La descarga de la lista 69-B llego vacia.");
    return decodificarListado69B(bytes);
  }

  private async leerConTope(res: Response): Promise<Uint8Array> {
    if (!res.body) {
      const todo = new Uint8Array(await res.arrayBuffer());
      if (todo.byteLength > this.maxBytes) throw new Efos69bDescargaError("demasiado_grande", `El archivo supera el tope de ${this.maxBytes} bytes.`);
      return todo;
    }
    const lector = res.body.getReader();
    const trozos: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBytes) {
          await lector.cancel().catch(() => undefined);
          throw new Efos69bDescargaError("demasiado_grande", `El archivo supera el tope de ${this.maxBytes} bytes.`);
        }
        trozos.push(value);
      }
    } catch (err) {
      if (err instanceof Efos69bDescargaError) throw err;
      const nombre = err && typeof err === "object" ? (err as { name?: string }).name : undefined;
      throw new Efos69bDescargaError(nombre === "TimeoutError" || nombre === "AbortError" ? "timeout" : "red", "Se interrumpio la descarga de la lista 69-B.");
    }
    const salida = new Uint8Array(total);
    let offset = 0;
    for (const t of trozos) {
      salida.set(t, offset);
      offset += t.byteLength;
    }
    return salida;
  }
}
