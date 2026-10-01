// Fabrica de `complete` REAL para el arnes: cada candidato pasa por el MISMO OpenRouterProvider que produccion (tool calling
// real, `usage.cost` real, privacidad deny/ZDR/only por modelo). La llave solo viaja en la cabecera Authorization: este
// modulo nunca la imprime ni la guarda.
import { OpenRouterProvider } from "../../gateway/providers/openrouter.js";
import type { DataChatCompletion } from "../types.js";
import type { ModeloCandidato } from "./candidatos.js";
import type { FabricaCompletion } from "./runner.js";

export interface OpcionesFabricaOpenRouter {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Espera base del backoff en ms (por omision 1500: los modelos baratos devuelven 429 "temporalmente limitado" con frecuencia). */
  readonly backoffBaseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function crearProveedorCandidato(apiKey: string, modelo: ModeloCandidato, o: OpcionesFabricaOpenRouter = {}): OpenRouterProvider {
  return new OpenRouterProvider({
    apiKey,
    model: modelo.id,
    id: `eval:${modelo.id}`,
    params: modelo.params,
    routing: modelo.routing,
    appName: "Atiende evals",
    timeoutMs: o.timeoutMs ?? 60_000,
    maxRetries: o.maxRetries ?? 3,
    backoffBaseMs: o.backoffBaseMs ?? 1_500,
    ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
}

export function crearFabricaOpenRouter(apiKey: string, o: OpcionesFabricaOpenRouter = {}): FabricaCompletion {
  if (!apiKey || apiKey.length < 10) throw new Error("falta la llave de OpenRouter (OPENROUTER_API_KEY o OPENROUTER_API_KEY_FILE)");
  const proveedores = new Map<string, OpenRouterProvider>();
  return (modelo): DataChatCompletion => {
    let p = proveedores.get(modelo.id);
    if (!p) {
      p = crearProveedorCandidato(apiKey, modelo, o);
      proveedores.set(modelo.id, p);
    }
    const prov = p;
    return (req) => prov.complete(req);
  };
}
