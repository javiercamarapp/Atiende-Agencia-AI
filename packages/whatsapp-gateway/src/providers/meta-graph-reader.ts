// MetaGraphWhatsAppReader — lector de SOLO LECTURA sobre Graph API de Meta (WhatsApp Business).
//
// Sirve para comprobar, sin enviar ningun mensaje, que lo conectado esta bien: que la WABA y los numeros existen, su
// calidad, plataforma (coexistencia), limite de mensajeria, plantillas y apps suscritas. Politica: SOLO GET. Cualquier
// otro metodo lanza una excepcion antes de tocar la red. Nada de registrar/verificar numeros, webhooks ni plantillas.
//
// Nunca se loguea ni se incluye el token en un mensaje o error: todo texto que sale de este archivo pasa por
// `redactarSecretos`. Los tests usan un `fetchImpl` falso; ningun test llama a graph.facebook.com.
//
// Este archivo evita a proposito sintaxis que Node no sabe quitar con --experimental-strip-types (propiedades de
// parametro, enums): lo importa directamente el script scripts/verificar-meta-whatsapp/verificar.ts.

/** Version de Graph API por defecto del lector (misma que el cliente de envio). */
export const DEFAULT_GRAPH_READER_API_VERSION = "v21.0";

/** Forma valida de una version de Graph API: `v` + dos digitos + `.0`, por ejemplo `v23.0`. */
export const GRAPH_API_VERSION_PATTERN = /^v\d{2}\.0$/;

export function esVersionGraphValida(valor: unknown): valor is string {
  return typeof valor === "string" && GRAPH_API_VERSION_PATTERN.test(valor);
}

/** Campos de un numero (no se exige ninguno: Meta puede omitirlos segun el tipo de cuenta). */
export const CAMPOS_NUMERO = [
  "display_phone_number",
  "verified_name",
  "quality_rating",
  "code_verification_status",
  "name_status",
  "status",
  "platform_type",
  "throughput",
  "is_on_biz_app",
  "account_mode",
] as const;

export const CAMPOS_WABA = ["name", "currency", "timezone_id", "message_template_namespace", "whatsapp_business_manager_messaging_limit"] as const;

export const CAMPOS_PLANTILLA = ["name", "language", "status", "category", "quality_score"] as const;

export interface MetaNumero {
  readonly id: string;
  readonly display_phone_number?: string;
  readonly verified_name?: string;
  /** GREEN | YELLOW | RED | UNKNOWN */
  readonly quality_rating?: string;
  readonly code_verification_status?: string;
  readonly name_status?: string;
  readonly status?: string;
  readonly platform_type?: string;
  readonly throughput?: { readonly level?: string };
  readonly is_on_biz_app?: boolean;
  readonly account_mode?: string;
}

export interface MetaWaba {
  readonly id: string;
  readonly name?: string;
  readonly currency?: string;
  readonly timezone_id?: string;
  readonly message_template_namespace?: string;
  /** No esta confirmado en todas las versiones/cuentas: siempre opcional. */
  readonly whatsapp_business_manager_messaging_limit?: string;
}

export interface MetaPlantilla {
  readonly id?: string;
  readonly name?: string;
  readonly language?: string;
  /** APPROVED | PENDING | REJECTED | PAUSED | DISABLED ... */
  readonly status?: string;
  readonly category?: string;
  readonly quality_score?: { readonly score?: string } | string;
}

export interface MetaAppSuscrita {
  readonly id?: string;
  readonly name?: string;
  readonly link?: string;
}

export interface MetaGraphReadErrorInfo {
  readonly httpStatus?: number;
  readonly graphCode?: number;
  readonly graphSubcode?: number;
  /** `true` si fue 429, 5xx o un fallo de red. */
  readonly retryable?: boolean;
}

/** Error de lectura de Graph: mismo contrato que `WhatsAppSendError` (`httpStatus`, `graphCode`, `message`) mas `tokenInvalido`. */
export class MetaGraphReadError extends Error {
  readonly httpStatus: number | undefined;
  readonly graphCode: number | undefined;
  readonly graphSubcode: number | undefined;
  readonly retryable: boolean;
  /** `true` con el codigo 190 de Graph (o un 401): token vencido, revocado o invalido. */
  readonly tokenInvalido: boolean;

  constructor(message: string, info: MetaGraphReadErrorInfo = {}) {
    super(message);
    this.name = "MetaGraphReadError";
    this.httpStatus = info.httpStatus;
    this.graphCode = info.graphCode;
    this.graphSubcode = info.graphSubcode;
    this.retryable = info.retryable === true;
    this.tokenInvalido = info.graphCode === 190 || info.httpStatus === 401;
  }
}

/** Falla de CONFIGURACION (falta token, id vacio, metodo prohibido). */
export class MetaGraphReaderConfigError extends MetaGraphReadError {
  constructor(message: string) {
    super(message);
    this.name = "MetaGraphReaderConfigError";
  }
}

/** Quita de un texto cualquier rastro de credenciales: el token exacto, `Bearer ...`, `access_token=...` y cadenas con forma de token de Meta. */
export function redactarSecretos(texto: string, token?: string): string {
  let limpio = texto;
  if (token && token.length > 0) limpio = limpio.split(token).join("[REDACTADO]");
  return limpio
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTADO]")
    .replace(/(access_token|client_secret|appsecret_proof)=([^&\s"']+)/gi, "$1=[REDACTADO]")
    .replace(/\bEA[A-Za-z0-9]{20,}\b/g, "[REDACTADO]");
}

export interface MetaGraphWhatsAppReaderOptions {
  readonly accessToken: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  /** Solo para tests. Default: `https://graph.facebook.com`. */
  readonly baseUrl?: string;
  /** Tope de paginas por consulta paginada (defensa contra ciclos). Default 50. */
  readonly maxPaginas?: number;
}

interface GraphErrorBody {
  readonly error?: { readonly message?: string; readonly code?: number; readonly error_subcode?: number };
}

interface GraphListBody<T> {
  readonly data?: readonly T[];
  readonly paging?: { readonly next?: string };
}

export class MetaGraphWhatsAppReader {
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxPaginas: number;

  constructor(opts: MetaGraphWhatsAppReaderOptions) {
    if (!opts.accessToken || opts.accessToken.trim().length === 0) {
      throw new MetaGraphReaderConfigError("MetaGraphWhatsAppReader requiere WHATSAPP_ACCESS_TOKEN: sin el no se lee nada de Meta.");
    }
    if (opts.apiVersion !== undefined && !esVersionGraphValida(opts.apiVersion)) {
      throw new MetaGraphReaderConfigError("version de Graph API invalida: se espera el formato v23.0");
    }
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? DEFAULT_GRAPH_READER_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.maxPaginas = opts.maxPaginas ?? 50;
  }

  /** Version de Graph que usa este lector (no es secreta). */
  get version(): string {
    return this.apiVersion;
  }

  async numero(phoneNumberId: string): Promise<MetaNumero> {
    return this.pedirObjeto<MetaNumero>(`/${this.id(phoneNumberId)}?fields=${CAMPOS_NUMERO.join(",")}`);
  }

  async numerosDeWaba(wabaId: string): Promise<MetaNumero[]> {
    return this.pedirLista<MetaNumero>(`/${this.id(wabaId)}/phone_numbers?fields=${CAMPOS_NUMERO.join(",")}`);
  }

  async waba(wabaId: string): Promise<MetaWaba> {
    return this.pedirObjeto<MetaWaba>(`/${this.id(wabaId)}?fields=${CAMPOS_WABA.join(",")}`);
  }

  async plantillas(wabaId: string): Promise<MetaPlantilla[]> {
    return this.pedirLista<MetaPlantilla>(`/${this.id(wabaId)}/message_templates?fields=${CAMPOS_PLANTILLA.join(",")}&limit=100`);
  }

  async appsSuscritas(wabaId: string): Promise<MetaAppSuscrita[]> {
    const filas = await this.pedirLista<{ whatsapp_business_api_data?: MetaAppSuscrita }>(`/${this.id(wabaId)}/subscribed_apps`);
    return filas.map((fila) => fila.whatsapp_business_api_data ?? {});
  }

  /** Unica puerta a la red. Rechaza todo metodo distinto de GET ANTES de llamar a `fetch`. */
  async solicitar(method: string, rutaOUrl: string): Promise<unknown> {
    if (method !== "GET") {
      throw new MetaGraphReaderConfigError(`MetaGraphWhatsAppReader es de solo lectura: el metodo ${redactarSecretos(String(method), this.accessToken)} no esta permitido (solo GET).`);
    }
    const url = rutaOUrl.startsWith("http") ? rutaOUrl : `${this.baseUrl}/${this.apiVersion}${rutaOUrl}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${this.accessToken}` } });
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      throw new MetaGraphReadError(`fallo de red al llamar Graph API: ${this.limpiar(detalle)}`, { retryable: true });
    }

    if (!response.ok) {
      let parsed: GraphErrorBody | null = null;
      try {
        parsed = (await response.json()) as GraphErrorBody;
      } catch {
        /* cuerpo sin JSON: se informa solo el status */
      }
      const graphCode = typeof parsed?.error?.code === "number" ? parsed.error.code : undefined;
      const graphSubcode = typeof parsed?.error?.error_subcode === "number" ? parsed.error.error_subcode : undefined;
      const detalle = this.limpiar(typeof parsed?.error?.message === "string" ? parsed.error.message : "(sin detalle)");
      throw new MetaGraphReadError(`Graph API respondio ${response.status}${graphCode !== undefined ? ` (codigo ${graphCode})` : ""}: ${detalle}`, {
        httpStatus: response.status,
        ...(graphCode !== undefined ? { graphCode } : {}),
        ...(graphSubcode !== undefined ? { graphSubcode } : {}),
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    try {
      return await response.json();
    } catch {
      throw new MetaGraphReadError("Graph API respondio 2xx con cuerpo que no es JSON", { httpStatus: response.status });
    }
  }

  private async pedirObjeto<T>(ruta: string): Promise<T> {
    const cuerpo = await this.solicitar("GET", ruta);
    if (cuerpo === null || typeof cuerpo !== "object" || Array.isArray(cuerpo)) {
      throw new MetaGraphReadError("Graph API respondio 2xx con un cuerpo inesperado (se esperaba un objeto)");
    }
    return cuerpo as T;
  }

  private async pedirLista<T>(ruta: string): Promise<T[]> {
    const salida: T[] = [];
    const vistas = new Set<string>();
    let siguiente: string | undefined = ruta;
    for (let pagina = 0; siguiente !== undefined; pagina += 1) {
      if (pagina >= this.maxPaginas) throw new MetaGraphReadError(`paginacion de Graph API excedio ${this.maxPaginas} paginas`);
      if (vistas.has(siguiente)) throw new MetaGraphReadError("paginacion de Graph API en ciclo (paging.next repetido)");
      vistas.add(siguiente);
      const cuerpo = (await this.solicitar("GET", siguiente)) as GraphListBody<T> | null;
      if (cuerpo !== null && typeof cuerpo === "object" && Array.isArray(cuerpo.data)) salida.push(...cuerpo.data);
      const next = cuerpo !== null && typeof cuerpo === "object" ? cuerpo.paging?.next : undefined;
      siguiente = typeof next === "string" && next.length > 0 ? this.urlSiguiente(next) : undefined;
    }
    return salida;
  }

  /** `paging.next` solo se sigue si apunta al mismo origen (el token viaja en la cabecera: jamas a otro host) y sin credenciales en la URL. */
  private urlSiguiente(next: string): string {
    let destino: URL;
    let base: URL;
    try {
      destino = new URL(next);
      base = new URL(this.baseUrl);
    } catch {
      throw new MetaGraphReadError("paging.next no es una URL valida");
    }
    if (destino.origin !== base.origin) throw new MetaGraphReadError("paging.next apunta a otro host: no se sigue");
    destino.searchParams.delete("access_token");
    return destino.toString();
  }

  private id(valor: string): string {
    if (typeof valor !== "string" || valor.trim().length === 0) throw new MetaGraphReaderConfigError("falta el id (phone_number_id o waba_id)");
    return encodeURIComponent(valor.trim());
  }

  private limpiar(texto: string): string {
    return redactarSecretos(texto, this.accessToken);
  }
}
