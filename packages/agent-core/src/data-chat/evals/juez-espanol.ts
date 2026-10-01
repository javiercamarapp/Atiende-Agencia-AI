// Juez de espanol barato (Qwen3-235B-A22B por Parasail via OpenRouter; NUNCA Sonnet). Califica de 1 a 5 el TEXTO que ve el usuario
// con una rubrica fija. Es un complemento de las reglas deterministas (graders.reglasEspanol), no parte de la
// exactitud, y su costo cuenta contra el mismo tope de gasto.
import { OpenRouterError, OpenRouterProvider } from "../../gateway/providers/openrouter.js";
import type { LlmCompletionResult } from "../../gateway/types.js";
import { JUEZ_ESPANOL_CADENA } from "./candidatos.js";
import type { PresupuestoDuro } from "./presupuesto.js";
import { objetoJsonDe } from "./texto.js";

export interface NotaJuez {
  /** 1 a 5; null = el juez no pudo calificar (error de ruta/formato). */
  readonly nota: number | null;
  readonly razon: string;
  readonly modelo: string;
  readonly costoUsd: number;
}

export interface JuezEspanol {
  juzgar(entrada: { readonly pregunta: string; readonly texto: string }): Promise<NotaJuez>;
}

export const RUBRICA_JUEZ = [
  "Eres un revisor de espanol de Mexico. Califica de 1 a 5 SOLO el texto de la respuesta de un asistente de datos de negocio.",
  "5 = natural, claro, conciso (maximo 3 frases), montos como $1,234.56 MXN, sin markdown ni enlaces, tuteo mexicano.",
  "4 = bien con un defecto menor. 3 = entendible pero acartonado, largo o con formato dudoso. 2 = errores claros (peninsularismos, ingles mezclado, formato de montos raro).",
  "1 = incomprensible, en otro idioma o con instrucciones raras. Si el texto esta vacio, nota 1.",
  'Responde SOLO un JSON: {"nota": <1-5>, "razon": "<maximo 15 palabras>"}.',
].join("\n");

export function parsearNotaJuez(texto: string): { nota: number | null; razon: string } {
  const crudo = objetoJsonDe(texto);
  if (!crudo) return { nota: null, razon: "sin JSON" };
  try {
    const o = JSON.parse(crudo) as { nota?: unknown; razon?: unknown };
    const n = typeof o.nota === "number" ? o.nota : Number(o.nota);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { nota: null, razon: "nota fuera de 1-5" };
    return { nota: n, razon: typeof o.razon === "string" ? o.razon.slice(0, 160) : "" };
  } catch {
    return { nota: null, razon: "JSON invalido" };
  }
}

export interface OpcionesJuezOpenRouter {
  readonly apiKey: string;
  /** Rubrica alterna (el juez de calidad de analisis del bake-off); por omision la de espanol. */
  readonly rubrica?: string;
  readonly presupuesto: PresupuestoDuro;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Juez real: prueba la cadena de rutas (Qwen3-235B por Parasail, Qwen3-235B por DeepInfra/Vertex, DeepSeek V4.1 Flash, Gemini Flash-Lite; todas con la politica EE.UU./ZDR) y se queda con la
 *  primera que responde; si una ruta devuelve 400/404/422 (sin endpoint) pasa a la siguiente. */
export function crearJuezOpenRouter(o: OpcionesJuezOpenRouter): JuezEspanol {
  let rutaViva = 0;
  const proveedores = JUEZ_ESPANOL_CADENA.map(
    (r) =>
      new OpenRouterProvider({
        apiKey: o.apiKey,
        model: r.id,
        id: `juez:${r.etiqueta}`,
        params: r.params,
        routing: r.routing,
        appName: "Atiende evals (juez)",
        maxRetries: 1,
        ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      }),
  );
  return {
    async juzgar({ pregunta, texto }) {
      for (let i = rutaViva; i < proveedores.length; i += 1) {
        const reserva = o.presupuesto.reservar(JUEZ_ESPANOL_CADENA[i]!.id);
        let r: LlmCompletionResult | null = null;
        let transitorios = 0;
        for (;;) {
          try {
            r = await proveedores[i]!.complete({
              system: o.rubrica ?? RUBRICA_JUEZ,
              messages: [{ role: "user", content: `Pregunta del usuario: ${pregunta}\nRespuesta a calificar: ${texto || "(vacia)"}` }],
              maxOutputTokens: 400,
            });
            break;
          } catch (err) {
            const e = err instanceof OpenRouterError ? err : null;
            if (e?.transient && transitorios < 2) {
              transitorios += 1; // falla pasajera (red, 5xx, 429): reintenta la misma ruta, sin gastar mas reserva
              continue;
            }
            reserva.liberar(0);
            // sin endpoint para esa politica: probar la siguiente ruta; cualquier otro error se propaga (cuenta, red).
            if (e && (e.status === 400 || e.status === 404 || e.status === 422) && i < proveedores.length - 1) {
              rutaViva = i + 1;
              r = null;
              break;
            }
            return { nota: null, razon: "juez no disponible", modelo: JUEZ_ESPANOL_CADENA[i]!.etiqueta, costoUsd: 0 };
          }
        }
        if (r === null) continue;
        reserva.liberar(r.costUsd);
        const p = parsearNotaJuez(r.text);
        return { ...p, modelo: JUEZ_ESPANOL_CADENA[i]!.etiqueta, costoUsd: r.costUsd };
      }
      return { nota: null, razon: "ninguna ruta del juez disponible", modelo: "ninguno", costoUsd: 0 };
    },
  };
}

/** Juez guionado (CI sin costo): nota fija o calculada por una funcion. */
export function crearJuezGuionado(fn: (e: { pregunta: string; texto: string }) => number | null = () => 5): JuezEspanol {
  return {
    async juzgar(e) {
      return { nota: fn(e), razon: "guionado", modelo: "guionado", costoUsd: 0 };
    },
  };
}
