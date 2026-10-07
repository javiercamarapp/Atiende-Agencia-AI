// Transporte unico del Copiloto ("Pregunta a tus datos") para apps/web: conecta el `ChatDatosShell` de @atiende/ui
// con las rutas reales de apps/api de CUALQUIER vertical (`<baseUrl>` = `.../chat-datos`, p. ej.
// `/v1/restaurantes/:propertyId/admin/chat-datos`). Es generico: no conoce restaurantes; cada vertical solo aporta su
// `baseUrl`, el token y (opcional) su envoltorio de refresh de sesion.
//
//   POST <baseUrl>                       Accept: application/x-ndjson -> eventos `paso` / `fin` / `error` (una linea JSON c/u)
//   GET  <baseUrl>/estado                -> { available, permitido, motivo, usoHoyPct }  (403 = rol sin acceso)
//   GET  <baseUrl>/conversaciones        -> { disponible, conversaciones }
//   GET/PATCH/DELETE <baseUrl>/conversaciones/:id
//   POST <baseUrl>/pins { conversationId, seq, bloque }   (fijar; el servidor deriva herramienta y argumentos del mensaje guardado)
//   POST <baseUrl>/conversaciones/:id/reporte?seq=N -> application/pdf (reporte del mensaje; "Descargar PDF")
//   POST <baseUrl>/adjuntos { nombre, contenidoBase64 } -> perfil del archivo (CSV / Excel / PDF analizado en el servidor; no se guarda)
//
// Reglas: el cliente solo manda la pregunta y el `conversationId` ("new" la primera vez, el uuid despues); el alcance
// (organizacion, sucursales, rol) lo decide SIEMPRE el servidor. Nada se inventa: cualquier fallo se traduce a un
// `CopilotoStatus` honesto. `fetchImpl` es inyectable (las pruebas nunca tocan la red).
import {
  CopilotoErrorTransporte,
  type ConversacionCompleta,
  type ConversacionResumen,
  type CopilotoBloque,
  type CopilotoEvento,
  type CopilotoFuente,
  type CopilotoMensaje,
  type CopilotoRespuesta,
  type CopilotoStatus,
  type CopilotoTransporte,
} from "@atiende/ui";

export const MAX_HISTORIAL_LOCAL = 12;
export const MAX_CARACTERES_TURNO = 600;
export const TEXTO_SIN_ACCESO = "Tu rol no tiene acceso al Copiloto. Pídele acceso al dueño.";
/** Adjuntar archivo: lo que el servidor sabe leer y su tope (el mismo de `ADJUNTO_MAX_BYTES` en apps/api). */
export const ADJUNTOS_CONFIG = { accept: ".csv,.tsv,.txt,.xlsx,.pdf", maxBytes: 5 * 1024 * 1024 } as const;

export interface CopilotoTransporteConfig {
  /** URL completa de la ruta de chat de la vertical, sin barra final (`.../chat-datos`). */
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  /** Token de acceso vigente. */
  readonly token: string;
  /** Envoltorio de refresh de sesion de la vertical (`withAuthRefresh`): reintenta UNA vez ante un 401. Por defecto, sin refresh. */
  readonly conAuth?: (hacer: (token: string) => Promise<Response>) => Promise<Response>;
  /** Entrega el PDF al usuario (por defecto, descarga del navegador). Inyectable: las pruebas nunca tocan el DOM. */
  readonly guardarArchivo?: (blob: Blob, nombre: string) => void;
  /** `false` = esta ruta de chat NO tiene `/pins`: el transporte no ofrece "Fijar" (el boton no se pinta; nunca un boton que responde 404). Por defecto, `true`. */
  readonly fijados?: boolean;
  /** `false` = esta ruta de chat NO tiene `/adjuntos`: el transporte no declara `adjuntos` y el compositor no pinta el clip. Por defecto, `true`. */
  readonly adjuntos?: boolean;
}

/** Nombre del archivo que sugiere el servidor (`attachment; filename="..."`), solo si es un `.pdf` simple y seguro. */
export function nombreArchivoPdf(res: Pick<Response, "headers">): string {
  const m = /filename="([A-Za-z0-9._-]{1,80}\.pdf)"/.exec(res.headers.get("content-disposition") ?? "");
  return m?.[1] ?? "reporte.pdf";
}

function descargarEnNavegador(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Mensaje legible de un fallo al pedir el reporte (el servidor manda `{ code, message }`; nunca se muestra un 500 crudo). */
async function errorReporte(res: Response): Promise<Error> {
  if (res.status === 403) return new Error(TEXTO_SIN_ACCESO);
  if (res.status === 404) return new Error("No encontré esa conversación. Puede que ya se haya borrado.");
  if (res.status === 429) return new Error("Pediste muchos reportes en poco tiempo. Espera unos minutos e inténtalo de nuevo.");
  if (res.status === 422) {
    try {
      const json: unknown = await res.json();
      if (esObjeto(json) && typeof json["message"] === "string" && json["message"]) return new Error(json["message"].slice(0, 200));
    } catch {
      // cuerpo ilegible: mensaje generico
    }
    return new Error("Esta respuesta no tiene cifras para armar un reporte.");
  }
  if (res.status === 503) return new Error("Los reportes todavía no están disponibles para tu cuenta.");
  return new Error("No pude generar el reporte en este momento. Inténtalo de nuevo en unos minutos.");
}

export type EstadoCopiloto =
  | { readonly tipo: "ok"; readonly available: boolean; readonly permitido: boolean; readonly motivo: "no_activado" | "tope_diario" | null; readonly usoHoyPct: number | null }
  | { readonly tipo: "sin_acceso" }
  | { readonly tipo: "error" };

export interface CopilotoTransporteVertical extends CopilotoTransporte {
  /** Olvida el hilo local (solo se usa cuando el servidor no guarda la conversacion). Llamalo al iniciar un chat nuevo. */
  reiniciar(): void;
}

const STATUS_VALIDOS: ReadonlySet<string> = new Set<CopilotoStatus>([
  "ok",
  "no_data",
  "clarify",
  "out_of_catalog",
  "rate_limited",
  "budget_exceeded",
  "unavailable",
  "invalid_input",
  "apagado",
  "forbidden",
]);

/** Estado desconocido del servidor (incluido el "error" del evento NDJSON) = "unavailable", nunca un estado inventado. */
export function normalizarStatus(raw: unknown): CopilotoStatus {
  return typeof raw === "string" && STATUS_VALIDOS.has(raw) ? (raw as CopilotoStatus) : "unavailable";
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Traduce `DataChatAnswer` del servidor a `CopilotoRespuesta`. Defensivo: el JSON viene de la red. */
export function normalizarRespuesta(raw: unknown, seq?: number): CopilotoRespuesta {
  const r = esObjeto(raw) ? raw : {};
  const noAi = esObjeto(r["noAi"]) ? r["noAi"] : undefined;
  // El interruptor de plataforma apagado se muestra con su aviso propio ("apagado"), no como un error generico.
  const status = noAi?.["reason"] === "kill_switch" ? "apagado" : normalizarStatus(r["status"]);
  const blocks = Array.isArray(r["blocks"]) ? (r["blocks"] as CopilotoBloque[]) : undefined;
  const sources = Array.isArray(r["sources"]) ? (r["sources"] as CopilotoFuente[]) : undefined;
  const seqFinal = typeof r["seq"] === "number" ? r["seq"] : seq;
  return {
    text: typeof r["text"] === "string" ? r["text"] : "",
    status,
    ...(blocks && blocks.length > 0 ? { blocks } : {}),
    ...(sources && sources.length > 0 ? { sources } : {}),
    ...(seqFinal !== undefined ? { seq: seqFinal } : {}),
  };
}

/** Parsea UNA linea NDJSON a un evento del contrato; `null` si no es un evento valido (linea corrupta o desconocida). */
export function parsearLinea(linea: string): CopilotoEvento | null {
  const texto = linea.trim();
  if (!texto) return null;
  let v: unknown;
  try {
    v = JSON.parse(texto);
  } catch {
    return null;
  }
  if (!esObjeto(v)) return null;
  if (v["t"] === "paso") {
    if ((v["fase"] !== "inicio" && v["fase"] !== "fin") || typeof v["herramienta"] !== "string") return null;
    return { t: "paso", fase: v["fase"], herramienta: v["herramienta"] };
  }
  if (v["t"] === "fin") {
    if (!esObjeto(v["respuesta"])) return null;
    const seq = typeof v["seq"] === "number" ? v["seq"] : undefined;
    return {
      t: "fin",
      respuesta: normalizarRespuesta(v["respuesta"], seq),
      ...(typeof v["conversacionId"] === "string" ? { conversacionId: v["conversacionId"] } : {}),
      ...(seq !== undefined ? { seq } : {}),
    };
  }
  if (v["t"] === "error") {
    return {
      t: "error",
      status: normalizarStatus(v["status"]),
      mensaje: typeof v["mensaje"] === "string" && v["mensaje"] ? v["mensaje"] : "No pude completar la consulta en este momento. Inténtalo de nuevo en un momento.",
      ...(typeof v["reintentarEnSeg"] === "number" ? { reintentarEnSeg: v["reintentarEnSeg"] } : {}),
    };
  }
  return null;
}

/** Lee un flujo NDJSON completo y entrega cada evento valido en orden. Respeta `senal`: al abortar cancela el lector. */
export async function leerNdjson(cuerpo: ReadableStream<Uint8Array>, onEvento: (e: CopilotoEvento) => void, senal: AbortSignal): Promise<void> {
  const lector = cuerpo.getReader();
  const decodificador = new TextDecoder();
  const alAbortar = (): void => {
    void lector.cancel().catch(() => undefined);
  };
  if (senal.aborted) alAbortar();
  else senal.addEventListener("abort", alAbortar, { once: true });
  let pendiente = "";
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (senal.aborted) throw new DOMException("cancelado", "AbortError");
      if (done) break;
      pendiente += decodificador.decode(value, { stream: true });
      let corte = pendiente.indexOf("\n");
      while (corte >= 0) {
        const evento = parsearLinea(pendiente.slice(0, corte));
        if (evento) onEvento(evento);
        pendiente = pendiente.slice(corte + 1);
        corte = pendiente.indexOf("\n");
      }
    }
    pendiente += decodificador.decode();
    const ultimo = parsearLinea(pendiente);
    if (ultimo) onEvento(ultimo);
  } finally {
    senal.removeEventListener("abort", alAbortar);
  }
}

function esAbort(e: unknown): boolean {
  return (e instanceof DOMException && e.name === "AbortError") || (e instanceof Error && e.name === "AbortError");
}

function reintentarEn(res: Response): number | undefined {
  const n = Number(res.headers.get("retry-after"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 3600) : undefined;
}

function errorHttp(res: Response): CopilotoErrorTransporte {
  if (res.status === 403) return new CopilotoErrorTransporte("forbidden", TEXTO_SIN_ACCESO);
  if (res.status === 429) return new CopilotoErrorTransporte("rate_limited", "Has hecho muchas preguntas en poco tiempo. Espera unos minutos e inténtalo de nuevo.", reintentarEn(res));
  if (res.status === 400) return new CopilotoErrorTransporte("invalid_input", "No pude entender esa pregunta. Reescríbela e inténtalo de nuevo.");
  return new CopilotoErrorTransporte("unavailable", "No pude consultar tus datos en este momento. Inténtalo de nuevo en unos minutos.");
}

export function crearTransporteCopiloto(cfg: CopilotoTransporteConfig): CopilotoTransporteVertical {
  let transporte = crearTransporteCompleto(cfg);
  if (cfg.fijados === false) {
    const { fijar: _sinFijar, ...resto } = transporte;
    transporte = resto;
  }
  if (cfg.adjuntos === false) {
    const { adjuntos: _sinAdjuntos, ...resto } = transporte;
    transporte = resto;
  }
  return transporte;
}

/** Archivo -> base64 sin reventar la pila (por trozos). */
async function aBase64(archivo: File): Promise<string> {
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}

function crearTransporteCompleto(cfg: CopilotoTransporteConfig): CopilotoTransporteVertical {
  const conAuth = cfg.conAuth ?? ((hacer: (token: string) => Promise<Response>) => hacer(cfg.token));
  const url = (sufijo = ""): string => `${cfg.baseUrl}${sufijo}`;
  const idUrl = (id: string): string => url(`/conversaciones/${encodeURIComponent(id)}`);
  const cabecera = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${token}`, ...extra });

  // Hilo local SOLO para cuando el servidor no puede guardar la conversacion (p. ej. base sin migrar): sin esto, cada pregunta
  // perderia el contexto de la anterior. Con conversacion guardada el historial sale de la base y esto no se usa.
  let hilo: { role: "user" | "assistant"; text: string }[] = [];

  async function llamar(hacer: (token: string) => Promise<Response>): Promise<Response> {
    try {
      return await conAuth(hacer);
    } catch (e) {
      if (esAbort(e)) throw e;
      throw new CopilotoErrorTransporte("unavailable", "No pude conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
    }
  }

  // Adjuntar archivo: el servidor lo analiza (sin modelo) y responde con la forma de siempre; no entra al hilo local ni a la conversacion guardada.
  async function enviarAdjunto(adjunto: File, senal: AbortSignal, onEvento: (e: CopilotoEvento) => void): Promise<CopilotoRespuesta> {
    if (adjunto.size > ADJUNTOS_CONFIG.maxBytes) throw new CopilotoErrorTransporte("invalid_input", "El archivo supera los 5 MB.");
    const contenidoBase64 = await aBase64(adjunto);
    const res = await llamar((t) =>
      cfg.fetchImpl(url("/adjuntos"), { method: "POST", headers: cabecera(t, { "content-type": "application/json" }), body: JSON.stringify({ nombre: adjunto.name, contenidoBase64 }), signal: senal }),
    );
    if (res.status === 413) throw new CopilotoErrorTransporte("invalid_input", "El archivo supera los 5 MB.");
    // Los avisos de `invalid_input` muestran el texto del error tal cual (el de `unavailable`/`rate_limited` es generico y hablaria de "preguntas").
    if (res.status === 404 || res.status === 503) throw new CopilotoErrorTransporte("invalid_input", "Adjuntar archivos todavía no está disponible en tu cuenta.");
    if (res.status === 429) throw new CopilotoErrorTransporte("invalid_input", "Adjuntaste muchos archivos en poco tiempo. Espera unos minutos e inténtalo de nuevo.");
    if (!res.ok) throw errorHttp(res);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new CopilotoErrorTransporte("unavailable", "La respuesta del servidor no se pudo leer. Inténtalo de nuevo.");
    }
    const respuesta = normalizarRespuesta(json);
    onEvento({ t: "fin", respuesta });
    return respuesta;
  }

  return {
    adjuntos: ADJUNTOS_CONFIG,

    reiniciar() {
      hilo = [];
    },

    async enviar({ pregunta, conversacionId, directa, adjunto, senal, onEvento }) {
      if (adjunto) return enviarAdjunto(adjunto, senal, onEvento);
      // Consulta directa (chip): el servidor ejecuta la herramienta SIN modelo; `label` es solo el texto del mensaje del usuario.
      const cuerpo: Record<string, unknown> = directa ? { tool: directa.tool, ...(directa.args ? { args: directa.args } : {}), label: pregunta } : { question: pregunta };
      if (conversacionId) cuerpo["conversationId"] = conversacionId;
      else if (hilo.length === 0) cuerpo["conversationId"] = "new";
      else cuerpo["history"] = hilo.slice(-MAX_HISTORIAL_LOCAL).map((m) => ({ role: m.role, text: m.text.slice(0, MAX_CARACTERES_TURNO) }));

      const res = await llamar((t) =>
        cfg.fetchImpl(url(), {
          method: "POST",
          headers: cabecera(t, { accept: "application/x-ndjson", "content-type": "application/json" }),
          body: JSON.stringify(cuerpo),
          signal: senal,
        }),
      );
      if (!res.ok) throw errorHttp(res);

      let fin: Extract<CopilotoEvento, { t: "fin" }> | undefined;
      let fallo: Extract<CopilotoEvento, { t: "error" }> | undefined;
      const alEvento = (e: CopilotoEvento): void => {
        if (e.t === "fin") fin = e;
        else if (e.t === "error") fallo = e;
        onEvento(e);
      };

      const tipo = res.headers.get("content-type") ?? "";
      if (!tipo.includes("ndjson") || !res.body) {
        // Servidor sin NDJSON: el JSON de siempre (`DataChatAnswer`).
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new CopilotoErrorTransporte("unavailable", "La respuesta del servidor no se pudo leer. Inténtalo de nuevo.");
        }
        const respuesta = normalizarRespuesta(json);
        const conv = esObjeto(json) && typeof json["conversationId"] === "string" ? json["conversationId"] : undefined;
        alEvento({ t: "fin", respuesta, ...(conv ? { conversacionId: conv } : {}) });
      } else {
        try {
          await leerNdjson(res.body, alEvento, senal);
        } catch (e) {
          if (esAbort(e)) throw e;
          throw new CopilotoErrorTransporte("unavailable", "Se cortó la conexión mientras respondía. Inténtalo de nuevo.");
        }
      }

      if (fallo && !fin) throw new CopilotoErrorTransporte(fallo.status, fallo.mensaje, fallo.reintentarEnSeg);
      if (!fin) throw new CopilotoErrorTransporte("unavailable", "La respuesta llegó incompleta. Inténtalo de nuevo.");

      if (!fin.conversacionId && fin.respuesta.status === "ok") {
        hilo = [...hilo, { role: "user" as const, text: pregunta }, { role: "assistant" as const, text: fin.respuesta.text }].slice(-MAX_HISTORIAL_LOCAL);
      }
      return fin.respuesta;
    },

    async listar(senal) {
      const res = await llamar((t) => cfg.fetchImpl(url("/conversaciones"), { headers: cabecera(t), signal: senal }));
      if (!res.ok) throw errorHttp(res);
      const json: unknown = await res.json();
      if (!esObjeto(json) || json["disponible"] === false || !Array.isArray(json["conversaciones"])) return [];
      const items: ConversacionResumen[] = [];
      for (const c of json["conversaciones"] as unknown[]) {
        if (!esObjeto(c) || typeof c["id"] !== "string" || typeof c["actualizadaEn"] !== "string") continue;
        items.push({ id: c["id"], titulo: typeof c["titulo"] === "string" ? c["titulo"] : "Conversación", actualizadaEn: c["actualizadaEn"] });
      }
      return items;
    },

    async abrir(id, senal): Promise<ConversacionCompleta> {
      const res = await llamar((t) => cfg.fetchImpl(idUrl(id), { headers: cabecera(t), signal: senal }));
      if (!res.ok) throw errorHttp(res);
      const json: unknown = await res.json();
      if (!esObjeto(json) || typeof json["id"] !== "string" || !Array.isArray(json["mensajes"])) throw new CopilotoErrorTransporte("unavailable", "Conversación inválida.");
      const mensajes: CopilotoMensaje[] = [];
      for (const m of json["mensajes"] as unknown[]) {
        if (!esObjeto(m) || (m["role"] !== "user" && m["role"] !== "assistant") || typeof m["text"] !== "string") continue;
        const seq = typeof m["seq"] === "number" ? m["seq"] : undefined;
        const blocks = Array.isArray(m["blocks"]) && m["blocks"].length > 0 ? (m["blocks"] as CopilotoBloque[]) : undefined;
        const sources = Array.isArray(m["sources"]) && m["sources"].length > 0 ? (m["sources"] as CopilotoFuente[]) : undefined;
        mensajes.push({
          id: typeof m["id"] === "string" ? m["id"] : `m-${seq ?? mensajes.length}`,
          role: m["role"],
          text: m["text"],
          ...(m["role"] === "assistant" ? { status: normalizarStatus(m["status"]) } : {}),
          ...(blocks ? { blocks } : {}),
          ...(sources ? { sources } : {}),
          ...(seq !== undefined ? { seq } : {}),
        });
      }
      return { id: json["id"], titulo: typeof json["titulo"] === "string" ? json["titulo"] : "Conversación", mensajes };
    },

    async fijar(id, seq, bloque) {
      const res = await llamar((t) =>
        cfg.fetchImpl(url("/pins"), { method: "POST", headers: cabecera(t, { "content-type": "application/json" }), body: JSON.stringify({ conversationId: id, seq, bloque }) }),
      );
      // 409 = tope de fijados; 503 = el servidor todavia no tiene los fijados; 404 = ese resultado ya no se puede fijar.
      if (!res.ok) throw errorHttp(res);
    },

    async renombrar(id, titulo) {
      const res = await llamar((t) => cfg.fetchImpl(idUrl(id), { method: "PATCH", headers: cabecera(t, { "content-type": "application/json" }), body: JSON.stringify({ titulo }) }));
      if (!res.ok) throw errorHttp(res);
    },

    async descargarPdf(id, seq) {
      const res = await llamar((t) => cfg.fetchImpl(`${idUrl(id)}/reporte?seq=${encodeURIComponent(String(seq))}`, { method: "POST", headers: cabecera(t) }));
      if (!res.ok) throw await errorReporte(res);
      if (!(res.headers.get("content-type") ?? "").includes("application/pdf")) throw new Error("La respuesta del servidor no es un PDF. Inténtalo de nuevo.");
      const blob = await res.blob();
      (cfg.guardarArchivo ?? descargarEnNavegador)(blob, nombreArchivoPdf(res));
    },

    async borrar(id) {
      const res = await llamar((t) => cfg.fetchImpl(idUrl(id), { method: "DELETE", headers: cabecera(t) }));
      if (!res.ok) throw errorHttp(res);
    },
  };
}

/** Estado del Copiloto para esta cuenta: 403 = rol sin acceso; cualquier otro fallo = "error" (nunca se asume disponible). */
export async function consultarEstadoCopiloto(cfg: CopilotoTransporteConfig, senal?: AbortSignal): Promise<EstadoCopiloto> {
  const conAuth = cfg.conAuth ?? ((hacer: (token: string) => Promise<Response>) => hacer(cfg.token));
  try {
    const res = await conAuth((t) => cfg.fetchImpl(`${cfg.baseUrl}/estado`, { headers: { authorization: `Bearer ${t}` }, ...(senal ? { signal: senal } : {}) }));
    if (res.status === 403) return { tipo: "sin_acceso" };
    if (!res.ok) return { tipo: "error" };
    const json: unknown = await res.json();
    if (!esObjeto(json) || typeof json["available"] !== "boolean") return { tipo: "error" };
    const available = json["available"];
    const permitido = json["permitido"] === undefined ? available : json["permitido"] === true;
    const motivo = json["motivo"] === "no_activado" || json["motivo"] === "tope_diario" ? json["motivo"] : null;
    const uso = json["usoHoyPct"];
    return { tipo: "ok", available, permitido, motivo, usoHoyPct: typeof uso === "number" && Number.isFinite(uso) ? Math.min(100, Math.max(0, uso)) : null };
  } catch {
    return { tipo: "error" };
  }
}
