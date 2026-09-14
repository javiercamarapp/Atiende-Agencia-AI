// Barril de src/agentes (Fase 7 -- automatización agéntica de mensajería). Mismo
// patrón que ../mensajeria/index.ts: solo reexporta lo público de esta subcarpeta.
export type { ActorAgente, ToolDefinicion } from "./tipos.ts";

export { CATALOGO_TOOLS_AGENTE, NOMBRE_TOOL_CONSULTAR_POLITICA_CANAL, NOMBRE_TOOL_PROPONER_BORRADOR } from "./catalogo.ts";

export { construirMatrizCompleta, toolPermitidaParaActor, toolsDisponiblesParaActor } from "./matrizRoles.ts";
export type { FilaMatrizRolTool } from "./matrizRoles.ts";

export { ActorSinPermisoParaProponerBorradorError, BorradorIASinPropuestaError, DEFAULT_RENTAS_MENSAJERIA_AGENT_ROLE, GeneracionBorradorIAFallidaError, GeneradorBorradorIA } from "./generadorBorradorIA.ts";
export type { GeneradorBorradorIAOptions } from "./generadorBorradorIA.ts";
