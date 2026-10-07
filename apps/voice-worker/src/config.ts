// Configuracion del worker, leida SOLO de variables de entorno. Si falta algo imprescindible el worker arranca en modo NO CONFIGURADO: registra
// el motivo, responde 503 en /salud y NO contesta llamadas (nunca atiende a medias). Ningun valor secreto se registra ni se devuelve.
import type { MensajeId } from "@atiende/voice-core";

export type ModoEntrada = "desborde" | "total" | "prueba";
export const MODOS_ENTRADA: readonly ModoEntrada[] = ["desborde", "total", "prueba"];

/** Una linea (numero marcado) de la tabla DNIS -> sucursal. El secreto NO vive en el JSON: `secretoEnv` nombra la variable que lo trae. */
export interface EntradaDnis {
  readonly orgSlug: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly branchSlug: string;
  /** Secreto de la sucursal (de `.../voz/secreto`), ya leido de la variable `secretoEnv`. */
  readonly secreto: string;
  readonly secretoEnv: string;
  /** Sobreescritura del tope mensual de gasto de voz de la organizacion (USD); null = usa el de la plataforma. */
  readonly topeMensualUsd: number | null;
  /** Modo de entrada de la sucursal; un encabezado de desvio en la llamada lo vuelve `desborde` (salvo `prueba`). */
  readonly modoEntrada: ModoEntrada;
  /** Lineas propias de la sucursal que desvian al numero puente (Telmex/Telcel/conmutador), normalizadas a 10 digitos. Si el desvio re-origina la llamada, el
   * `From` que llega puede ser UNA DE ESTAS en lugar del cliente: no es un telefono confiable (ver `telefono-llamante.ts`). */
  readonly numerosSucursal: readonly string[];
}

export interface ConfigWorker {
  /** `configurado` = puede contestar llamadas. */
  readonly estado: "configurado" | "no_configurado";
  /** Por que no esta configurado (nombres de variables y problemas, nunca valores). */
  readonly motivos: readonly string[];
  readonly livekit: { readonly url: string; readonly apiKey: string; readonly apiSecret: string; readonly prefijoSala: string } | null;
  readonly apiBaseUrl: string;
  readonly internalSecret: string;
  readonly geminiApiKey: string | null;
  /** `vertex` = el escalon 1 va por Vertex AI (cuenta de servicio) en lugar de la Gemini API; hoy NO se activa (`GEMINI_BACKEND` ausente = `api`). */
  readonly geminiBackend: "api" | "vertex";
  readonly vertex: { readonly project: string; readonly location: string; readonly serviceAccountJson: string } | null;
  readonly openrouterApiKey: string | null;
  /** Ajuste fino del VAD de Gemini (`VOICE_VAD_SILENCIO_MS`, `VOICE_VAD_SENSIBILIDAD_FIN`); vacio = los valores de `VOZ_PLATAFORMA.gemini.vad`. */
  readonly vad: { readonly silencioFinMs?: number; readonly sensibilidadFin?: "END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW" | null };
  /** Tope de costo por llamada en micro-USD (`VOICE_COSTO_MAX_LLAMADA_USD`); null = el de la plataforma (US$0.50, `COSTO_MAX_LLAMADA_MICRO_USD`). */
  readonly costoMaxLlamadaMicroUsd: number | null;
  readonly dnis: ReadonlyMap<string, EntradaDnis>;
  /** Tope mensual de plataforma en micro-USD (null = sin tope de plataforma). */
  readonly topeMensualPlataformaMicroUsd: number | null;
  readonly assetsDir: string;
  readonly puertoSalud: number;
  readonly zonaHoraria: string;
}

/** Numero marcado en una forma canonica comparable: solo digitos, ultimos 10 (el plan de numeracion mexicano: 52 + 10 digitos). */
export function normalizarNumero(numero: string | null | undefined): string | null {
  if (typeof numero !== "string") return null;
  const digitos = numero.replace(/\D/g, "");
  if (digitos.length < 10) return null;
  return digitos.slice(-10);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const ENV_NOMBRE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ResultadoTablaDnis {
  readonly tabla: ReadonlyMap<string, EntradaDnis>;
  readonly problemas: readonly string[];
}

/** Parsea `VOICE_DNIS_MAP` (JSON `{ "<numero>": { orgSlug, organizationId, propertyId, branchSlug, secretoEnv, topeMensualUsd?, modoEntrada?, numerosSucursal? } }`). */
export function parsearTablaDnis(json: string | undefined, env: Readonly<Record<string, string | undefined>>): ResultadoTablaDnis {
  const problemas: string[] = [];
  const tabla = new Map<string, EntradaDnis>();
  if (!json || json.trim() === "") return { tabla, problemas: ["VOICE_DNIS_MAP: falta (tabla numero marcado -> sucursal)."] };
  let crudo: unknown;
  try {
    crudo = JSON.parse(json);
  } catch {
    return { tabla, problemas: ["VOICE_DNIS_MAP: no es JSON valido."] };
  }
  if (!crudo || typeof crudo !== "object" || Array.isArray(crudo)) return { tabla, problemas: ["VOICE_DNIS_MAP: debe ser un objeto numero -> sucursal."] };
  for (const [numero, valor] of Object.entries(crudo as Record<string, unknown>)) {
    const clave = normalizarNumero(numero);
    const donde = `VOICE_DNIS_MAP[${numero.length > 4 ? `...${numero.slice(-4)}` : numero}]`;
    if (!clave) {
      problemas.push(`${donde}: numero invalido (se esperan al menos 10 digitos).`);
      continue;
    }
    if (tabla.has(clave)) {
      problemas.push(`${donde}: numero repetido.`);
      continue;
    }
    const v = (valor ?? {}) as Record<string, unknown>;
    const orgSlug = typeof v.orgSlug === "string" && SLUG_RE.test(v.orgSlug) ? v.orgSlug : null;
    const organizationId = typeof v.organizationId === "string" && UUID_RE.test(v.organizationId) ? v.organizationId : null;
    const propertyId = typeof v.propertyId === "string" && UUID_RE.test(v.propertyId) ? v.propertyId : null;
    const branchSlug = typeof v.branchSlug === "string" && SLUG_RE.test(v.branchSlug) ? v.branchSlug : null;
    const secretoEnv = typeof v.secretoEnv === "string" && ENV_NOMBRE_RE.test(v.secretoEnv) ? v.secretoEnv : null;
    if (!orgSlug || !organizationId || !propertyId || !branchSlug || !secretoEnv) {
      problemas.push(`${donde}: faltan o son invalidos orgSlug, organizationId, propertyId, branchSlug o secretoEnv.`);
      continue;
    }
    const secreto = env[secretoEnv];
    if (!secreto || secreto.trim() === "") {
      problemas.push(`${donde}: la variable ${secretoEnv} (secreto de la sucursal) no tiene valor.`);
      continue;
    }
    const topeUsd = v.topeMensualUsd === undefined || v.topeMensualUsd === null ? null : typeof v.topeMensualUsd === "number" && Number.isFinite(v.topeMensualUsd) && v.topeMensualUsd > 0 ? v.topeMensualUsd : Number.NaN;
    if (Number.isNaN(topeUsd)) {
      problemas.push(`${donde}: topeMensualUsd debe ser un numero mayor que 0.`);
      continue;
    }
    const modo = v.modoEntrada === undefined ? "total" : v.modoEntrada;
    if (typeof modo !== "string" || !(MODOS_ENTRADA as readonly string[]).includes(modo)) {
      problemas.push(`${donde}: modoEntrada debe ser desborde, total o prueba.`);
      continue;
    }
    let numerosSucursal: string[] = [];
    if (v.numerosSucursal !== undefined && v.numerosSucursal !== null) {
      const lista = Array.isArray(v.numerosSucursal) ? (v.numerosSucursal as unknown[]) : null;
      const normalizados = lista === null ? null : lista.map((n) => (typeof n === "string" ? normalizarNumero(n) : null));
      if (normalizados === null || normalizados.length > 20 || normalizados.some((n) => n === null)) {
        problemas.push(`${donde}: numerosSucursal debe ser una lista (hasta 20) de numeros de al menos 10 digitos.`);
        continue;
      }
      numerosSucursal = [...new Set(normalizados as string[])];
    }
    tabla.set(clave, { orgSlug, organizationId, propertyId, branchSlug, secreto, secretoEnv, topeMensualUsd: topeUsd, modoEntrada: modo as ModoEntrada, numerosSucursal });
  }
  if (tabla.size === 0 && problemas.length === 0) problemas.push("VOICE_DNIS_MAP: no trae ningun numero.");
  return { tabla, problemas };
}

const lleno = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/** Quita las diagonales finales de una URL base. Con un bucle y no con una expresion regular (`/\/+$/` es de tiempo polinomial ante muchas diagonales). */
export function sinDiagonalFinal(url: string): string {
  let fin = url.length;
  while (fin > 0 && url[fin - 1] === "/") fin -= 1;
  return url.slice(0, fin);
}

export interface OpcionesCarga {
  /** Ids de pregrabados que faltan en `assetsDir` (los calcula quien arranca; vacio = completos). */
  readonly pregrabadosFaltantes?: readonly MensajeId[];
}

export function cargarConfig(env: Readonly<Record<string, string | undefined>>, opts: OpcionesCarga = {}): ConfigWorker {
  const motivos: string[] = [];
  const livekitOk = lleno(env.LIVEKIT_URL) && lleno(env.LIVEKIT_API_KEY) && lleno(env.LIVEKIT_API_SECRET);
  if (!lleno(env.LIVEKIT_URL)) motivos.push("Falta LIVEKIT_URL.");
  if (!lleno(env.LIVEKIT_API_KEY)) motivos.push("Falta LIVEKIT_API_KEY.");
  if (!lleno(env.LIVEKIT_API_SECRET)) motivos.push("Falta LIVEKIT_API_SECRET.");
  const apiBaseUrl = sinDiagonalFinal((env.ATIENDE_API_URL ?? "").trim());
  if (!apiBaseUrl) motivos.push("Falta ATIENDE_API_URL (URL base de la API de Atiende).");
  else if (!/^https?:\/\//.test(apiBaseUrl)) motivos.push("ATIENDE_API_URL debe empezar con http:// o https://.");
  const internalSecret = (env.INTERNAL_SECRET ?? "").trim();
  if (!internalSecret) motivos.push("Falta INTERNAL_SECRET (el mismo de la API; registra conversaciones y costos).");
  const gemini = lleno(env.GEMINI_API_KEY) ? env.GEMINI_API_KEY.trim() : null;
  const openrouter = lleno(env.OPENROUTER_API_KEY) ? env.OPENROUTER_API_KEY.trim() : null;
  const backendCrudo = lleno(env.GEMINI_BACKEND) ? env.GEMINI_BACKEND.trim().toLowerCase() : "api";
  let geminiBackend: "api" | "vertex" = "api";
  let vertex: ConfigWorker["vertex"] = null;
  if (backendCrudo === "vertex") {
    geminiBackend = "vertex";
    if (!lleno(env.VERTEX_PROJECT)) motivos.push("GEMINI_BACKEND=vertex: falta VERTEX_PROJECT.");
    if (!lleno(env.VERTEX_SERVICE_ACCOUNT_JSON)) motivos.push("GEMINI_BACKEND=vertex: falta VERTEX_SERVICE_ACCOUNT_JSON (cuenta de servicio con permiso de Vertex AI).");
    const location = lleno(env.VERTEX_LOCATION) ? env.VERTEX_LOCATION.trim() : "us-central1";
    if (!/^[a-z]+-[a-z]+[0-9]+$|^us$|^eu$/.test(location)) motivos.push("VERTEX_LOCATION no parece una region de Google Cloud (ej. us-central1).");
    if (lleno(env.VERTEX_PROJECT) && lleno(env.VERTEX_SERVICE_ACCOUNT_JSON)) vertex = { project: env.VERTEX_PROJECT.trim(), location, serviceAccountJson: env.VERTEX_SERVICE_ACCOUNT_JSON };
  } else if (backendCrudo !== "api") {
    motivos.push("GEMINI_BACKEND debe ser api o vertex.");
  }
  if (!gemini && !vertex && !openrouter) motivos.push("Falta GEMINI_API_KEY u OPENROUTER_API_KEY (ninguna escalera de voz puede abrir).");
  const vad: { silencioFinMs?: number; sensibilidadFin?: "END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW" | null } = {};
  if (lleno(env.VOICE_VAD_SILENCIO_MS)) {
    const ms = Number(env.VOICE_VAD_SILENCIO_MS);
    if (!Number.isInteger(ms) || ms < 100 || ms > 3000) motivos.push("VOICE_VAD_SILENCIO_MS debe ser un entero entre 100 y 3000.");
    else vad.silencioFinMs = ms;
  }
  if (lleno(env.VOICE_VAD_SENSIBILIDAD_FIN)) {
    const v = env.VOICE_VAD_SENSIBILIDAD_FIN.trim().toLowerCase();
    if (v === "alta") vad.sensibilidadFin = "END_SENSITIVITY_HIGH";
    else if (v === "baja") vad.sensibilidadFin = "END_SENSITIVITY_LOW";
    else if (v === "omitir") vad.sensibilidadFin = null;
    else motivos.push("VOICE_VAD_SENSIBILIDAD_FIN debe ser alta, baja u omitir.");
  }
  let costoMax: number | null = null;
  if (lleno(env.VOICE_COSTO_MAX_LLAMADA_USD)) {
    const usd = Number(env.VOICE_COSTO_MAX_LLAMADA_USD);
    if (!Number.isFinite(usd) || usd <= 0 || usd > 20) motivos.push("VOICE_COSTO_MAX_LLAMADA_USD debe ser un numero entre 0 y 20.");
    else costoMax = Math.round(usd * 1_000_000);
  }
  const { tabla, problemas } = parsearTablaDnis(env.VOICE_DNIS_MAP, env);
  motivos.push(...problemas);
  let tope: number | null = null;
  if (lleno(env.VOICE_TOPE_MENSUAL_USD)) {
    const usd = Number(env.VOICE_TOPE_MENSUAL_USD);
    if (!Number.isFinite(usd) || usd <= 0) motivos.push("VOICE_TOPE_MENSUAL_USD debe ser un numero mayor que 0.");
    else tope = Math.round(usd * 1_000_000);
  }
  if ((opts.pregrabadosFaltantes?.length ?? 0) > 0) motivos.push(`Faltan ${opts.pregrabadosFaltantes?.length} audios pregrabados en assets/ (corre scripts/voz-pregrabados.ts).`);
  const puerto = Number(env.PORT ?? env.VOICE_WORKER_PORT ?? 8080);
  return {
    estado: motivos.length === 0 ? "configurado" : "no_configurado",
    motivos,
    livekit: livekitOk ? { url: env.LIVEKIT_URL!.trim(), apiKey: env.LIVEKIT_API_KEY!.trim(), apiSecret: env.LIVEKIT_API_SECRET!.trim(), prefijoSala: (env.VOICE_ROOM_PREFIX ?? "llamada-").trim() || "llamada-" } : null,
    apiBaseUrl,
    internalSecret,
    geminiApiKey: gemini,
    geminiBackend,
    vertex,
    openrouterApiKey: openrouter,
    vad,
    costoMaxLlamadaMicroUsd: costoMax,
    dnis: tabla,
    topeMensualPlataformaMicroUsd: tope,
    assetsDir: lleno(env.VOICE_ASSETS_DIR) ? env.VOICE_ASSETS_DIR.trim() : "assets",
    puertoSalud: Number.isInteger(puerto) && puerto > 0 && puerto < 65536 ? puerto : 8080,
    zonaHoraria: lleno(env.VOICE_TIMEZONE) ? env.VOICE_TIMEZONE.trim() : "America/Merida",
  };
}

/** Tope mensual efectivo en micro-USD: la sobreescritura de la organizacion gana; sin ella, el de plataforma; sin ninguno, sin tope. */
export function resolverTopeMensualMicroUsd(plataformaMicroUsd: number | null, organizacionUsd: number | null): number | null {
  if (organizacionUsd !== null && Number.isFinite(organizacionUsd) && organizacionUsd > 0) return Math.round(organizacionUsd * 1_000_000);
  return plataformaMicroUsd !== null && plataformaMicroUsd > 0 ? plataformaMicroUsd : null;
}

/** Modo de entrada de UNA llamada: la sucursal `prueba` manda; un desvio de Twilio/conmutador la vuelve `desborde`; si no, lo configurado. */
export function modoEntradaDeLlamada(configurado: ModoEntrada, desviadaDesde: string | null): ModoEntrada {
  if (configurado === "prueba") return "prueba";
  if (desviadaDesde !== null && desviadaDesde.trim() !== "") return "desborde";
  return configurado;
}

/** Franja del dia (hora local de la sucursal) para segmentar las llamadas; las mismas franjas que el saludo pregrabado mas el pico del fin de semana. */
export function franjaDeHora(hora: number): "manana" | "tarde" | "noche" {
  if (hora >= 5 && hora < 12) return "manana";
  if (hora >= 12 && hora < 19) return "tarde";
  return "noche";
}
