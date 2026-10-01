// Scrub de PII/secretos para texto libre, valores estructurados, errores y la consola del
// proceso (PL-10). Pura y sin I/O salvo `instalarScrubEnConsola`, que muta el objeto `console`
// recibido. Todos los patrones vienen de ./patrones.ts (fuente unica).
import { CLAVE_SENSIBLE, MARCA_REDACTADO, PATRONES_SCRUB, PATRON_UUID } from "./patrones.ts";

export interface OpcionesScrubTexto {
  /** Si se define, trunca el resultado (con "…") a este largo. */
  readonly maxLargo?: number;
  /** No tocar UUIDs (llave de correlacion de logs: tenant/request). Default false. */
  readonly preservarUuid?: boolean;
}

export interface OpcionesScrubValor extends OpcionesScrubTexto {
  readonly maxProfundidad?: number;
  readonly maxClaves?: number;
  readonly maxElementos?: number;
  /** Si es true, una clave sensible solo redacta valores de texto/objeto; un numero o booleano
   *  (p. ej. `inputTokens: 300`) se conserva. Default false (alertas: se redacta siempre). */
  readonly claveSensibleSoloTexto?: boolean;
  /** "mensaje": un Error se reduce a su mensaje redactado (alertas). "detallado": nombre,
   *  mensaje, stack y propiedades propias (code, detail...) redactados (logs). */
  readonly errores?: "mensaje" | "detallado";
}

/** Valores por defecto = el comportamiento historico de la redaccion de alertas. */
const DEFECTOS = { maxProfundidad: 4, maxClaves: 30, maxElementos: 20 } as const;

/** Preset para logs y errores: topes mas holgados, UUIDs intactos, errores con detalle. */
export const OPCIONES_LOGS: OpcionesScrubValor = {
  maxLargo: 4000,
  preservarUuid: true,
  maxProfundidad: 6,
  maxClaves: 100,
  maxElementos: 50,
  claveSensibleSoloTexto: true,
  errores: "detallado",
};

function aplicarPatrones(texto: string): string {
  let salida = texto;
  for (const [patron, reemplazo] of PATRONES_SCRUB) {
    salida = typeof reemplazo === "string" ? salida.replace(patron, reemplazo) : salida.replace(patron, reemplazo);
  }
  return salida;
}

export function scrubTexto(texto: string, opciones: OpcionesScrubTexto = {}): string {
  let salida: string;
  if (opciones.preservarUuid) {
    // split con grupo de captura: los indices impares son UUIDs y se dejan tal cual.
    const trozos = texto.split(new RegExp(`(${PATRON_UUID.source})`, "gi"));
    salida = trozos.map((trozo, i) => (i % 2 === 1 ? trozo : aplicarPatrones(trozo))).join("");
  } else {
    salida = aplicarPatrones(texto);
  }
  const max = opciones.maxLargo;
  return max !== undefined && salida.length > max ? `${salida.slice(0, max - 1)}…` : salida;
}

/** Error -> objeto plano redactado. Nunca lanza. */
export function scrubError(err: Error, opciones: OpcionesScrubValor = OPCIONES_LOGS): Record<string, unknown> {
  const salida: Record<string, unknown> = { name: err.name, message: scrubTexto(err.message, opciones) };
  if (err.stack) salida.stack = scrubTexto(err.stack, { ...opciones, maxLargo: 2000 });
  for (const [clave, valor] of Object.entries(err)) {
    if (clave === "name" || clave === "message" || clave === "stack") continue;
    salida[clave] = CLAVE_SENSIBLE.test(clave) ? MARCA_REDACTADO : scrubValor(valor, { ...opciones, maxProfundidad: 2 }, 1);
  }
  return salida;
}

/** Redacta recursivamente un valor arbitrario (objeto/array/primitivo) con topes de
 *  profundidad y tamano. Nunca lanza; los ciclos terminan por el tope de profundidad. */
export function scrubValor(valor: unknown, opciones: OpcionesScrubValor = {}, profundidad = 0): unknown {
  const maxProfundidad = opciones.maxProfundidad ?? DEFECTOS.maxProfundidad;
  const maxClaves = opciones.maxClaves ?? DEFECTOS.maxClaves;
  const maxElementos = opciones.maxElementos ?? DEFECTOS.maxElementos;
  if (valor === null || valor === undefined) return valor ?? null;
  if (typeof valor === "string") return scrubTexto(valor, opciones);
  if (typeof valor === "number" || typeof valor === "boolean") return valor;
  if (typeof valor === "bigint") return valor.toString();
  if (typeof valor === "function" || typeof valor === "symbol") return "[no_serializable]";
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? "[fecha_invalida]" : valor.toISOString();
  if (valor instanceof Error) return opciones.errores === "detallado" ? scrubError(valor, opciones) : scrubTexto(valor.message, opciones);
  if (ArrayBuffer.isView(valor)) return "[binario]";
  if (profundidad >= maxProfundidad) return "[truncado]";
  if (Array.isArray(valor)) return valor.slice(0, maxElementos).map((v) => scrubValor(v, opciones, profundidad + 1));
  if (typeof valor === "object") {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>).slice(0, maxClaves)) {
      const sensible = CLAVE_SENSIBLE.test(clave) && (!opciones.claveSensibleSoloTexto || typeof v === "string" || (typeof v === "object" && v !== null));
      salida[clave] = sensible ? MARCA_REDACTADO : scrubValor(v, opciones, profundidad + 1);
    }
    return salida;
  }
  return "[no_serializable]";
}

// ---- consola del proceso ----

type MetodoConsola = "log" | "info" | "warn" | "error" | "debug";
const METODOS: readonly MetodoConsola[] = ["log", "info", "warn", "error", "debug"];
const MARCA_INSTALADO = Symbol.for("atiende.core-pii.consola-instalada");

/** Subconjunto de `Console` que se envuelve (permite probar con un doble). */
export type ConsolaLike = { [M in MetodoConsola]: (...args: unknown[]) => void };

/** Un argumento de console.* -> su version redactada. Una linea JSON (lo que emite `logEvent`)
 *  se redacta de forma ESTRUCTURAL para no corromper el JSON con reemplazos de texto. */
export function scrubArgumentoConsola(arg: unknown, opciones: OpcionesScrubValor = OPCIONES_LOGS): unknown {
  if (typeof arg === "string") {
    const t = arg.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.stringify(scrubValor(JSON.parse(arg) as unknown, opciones));
      } catch {
        // no era JSON valido: cae al scrub de texto
      }
    }
    return scrubTexto(arg, opciones);
  }
  if (arg instanceof Error) {
    const d = scrubError(arg, opciones);
    const { name, message, stack, ...resto } = d as { name: string; message: string; stack?: string } & Record<string, unknown>;
    const extra = Object.keys(resto).length > 0 ? ` ${JSON.stringify(resto)}` : "";
    return `${stack ?? `${name}: ${message}`}${extra}`;
  }
  if (typeof arg === "object" && arg !== null) return scrubValor(arg, opciones);
  return arg;
}

/**
 * Envuelve console.log/info/warn/error/debug para que NADA salga del proceso sin pasar por el
 * scrub: cubre los call sites crudos (`console.error("...", err)`) de apps y dominios sin
 * tocarlos uno por uno. Idempotente (una segunda llamada no envuelve dos veces) y devuelve una
 * funcion que restaura los metodos originales. Nunca lanza: si el scrub falla, el argumento se
 * sustituye por una marca en vez de dejar pasar el original.
 */
export function instalarScrubEnConsola(consola: ConsolaLike = console as unknown as ConsolaLike, opciones: OpcionesScrubValor = OPCIONES_LOGS): () => void {
  const marcada = consola as unknown as Record<symbol, unknown>;
  if (marcada[MARCA_INSTALADO]) return () => undefined;
  const originales = new Map<MetodoConsola, (...args: unknown[]) => void>();
  for (const metodo of METODOS) {
    const original = consola[metodo];
    if (typeof original !== "function") continue;
    originales.set(metodo, original);
    consola[metodo] = (...args: unknown[]) => {
      let limpios: unknown[];
      try {
        limpios = args.map((a) => scrubArgumentoConsola(a, opciones));
      } catch {
        limpios = ["[scrub_fallido: salida omitida]"];
      }
      original.apply(consola, limpios);
    };
  }
  marcada[MARCA_INSTALADO] = true;
  return () => {
    for (const [metodo, original] of originales) consola[metodo] = original;
    delete marcada[MARCA_INSTALADO];
  };
}
