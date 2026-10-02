// Piezas comunes de las seis rutas de "Chatea con tus datos" para la RUTA DIRECTA (CHAT-06): un chip o boton ejecuta UNA herramienta
// del catalogo con argumentos validados, sin llamar al modelo. Por eso la ruta directa NO exige proveedor de IA: funciona aunque
// el modelo este caido, apagado o sin configurar (es justo el caso en que el usuario mas la necesita).
import type { DataChatCache, DataChatCompletion, RunDataChatTurnOptions } from "@atiende/agent-core/data-chat";

/** Completador que nunca se usa en la ruta directa (el motor no llama al modelo cuando hay `directTool`). Si algo lo llamara, falla fuerte. */
export const NO_LLM_COMPLETION: DataChatCompletion = async () => {
  throw new Error("data_chat_no_llm: la ruta directa no usa modelo.");
};

/** Opciones del motor que aportan la ruta directa y la cache; se esparcen en `runDataChatTurn({...})`. */
export function directTurnOptions(
  dataChat: { readonly cache?: DataChatCache | undefined },
  tool: string | undefined,
  toolArgs: Readonly<Record<string, string | number>> | undefined,
): Pick<RunDataChatTurnOptions, "directTool" | "directArgs" | "cache"> {
  return {
    ...(tool ? { directTool: tool, ...(toolArgs ? { directArgs: toolArgs } : {}) } : {}),
    ...(dataChat.cache ? { cache: dataChat.cache } : {}),
  };
}
