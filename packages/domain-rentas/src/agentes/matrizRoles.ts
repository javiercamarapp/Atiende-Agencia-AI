import { RENTAS_VERTICAL_ROLES } from "../roles.ts";
import type { RentasVerticalRole } from "../roles.ts";
import { CATALOGO_TOOLS_AGENTE } from "./catalogo.ts";
import type { ActorAgente, ToolDefinicion } from "./tipos.ts";

/**
 * Matriz rol×tool resuelta en SERVIDOR — port de rentas/packages/domain/src/agentes/
 * matrizRoles.ts (H-078: "el backend decide qué tool puede invocar cada rol ANTES de
 * construir la lista de tools que se pasa al modelo — nunca como filtro posterior
 * sobre lo que el modelo 'decidió' pedir"). `toolsDisponiblesParaActor` es el único
 * punto que arma esa lista para una invocación real (ver
 * ../agentes/generadorBorradorIA.ts); las funciones de aquí son puras y las usa tanto
 * el generador de borradores IA como el endpoint de solo-lectura de catálogo si
 * apps/api decide exponer uno (`GET .../agentes/matriz`, fuera de este lote).
 */
export function toolPermitidaParaActor(tool: ToolDefinicion, actor: ActorAgente): boolean {
  return tool.rolesPermitidos.includes(actor.rol);
}

/** Lista de tools que el servidor debe incluir en la invocación al modelo para este
 * actor — SIEMPRE calculada antes de llamar al proveedor, nunca después. */
export function toolsDisponiblesParaActor(actor: ActorAgente): ToolDefinicion[] {
  return CATALOGO_TOOLS_AGENTE.filter((tool) => toolPermitidaParaActor(tool, actor));
}

/** Matriz completa (rol × tool) como tabla plana — usada por la prueba de "matriz
 * rol×tool" (tests/agentes/matrizRoles.spec.ts) y por cualquier endpoint operativo
 * futuro de documentación (nunca expuesta al modelo). */
export interface FilaMatrizRolTool {
  readonly tool: string;
  readonly rol: RentasVerticalRole;
  readonly permitido: boolean;
}

export function construirMatrizCompleta(roles: readonly RentasVerticalRole[] = RENTAS_VERTICAL_ROLES): FilaMatrizRolTool[] {
  const filas: FilaMatrizRolTool[] = [];
  for (const tool of CATALOGO_TOOLS_AGENTE) {
    for (const rol of roles) {
      filas.push({ tool: tool.nombre, rol, permitido: toolPermitidaParaActor(tool, { usuarioId: "matriz", rol }) });
    }
  }
  return filas;
}
