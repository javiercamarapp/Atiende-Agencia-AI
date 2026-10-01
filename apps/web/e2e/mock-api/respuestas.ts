import { MARCA_RESPUESTA } from "./tipos.ts";

export interface RespuestaMarcada {
  readonly [MARCA_RESPUESTA]: true;
  readonly status: number;
  readonly cuerpo: unknown;
}

/** 200 con JSON (es el comportamiento por defecto de un manejador que devuelve un valor cualquiera). */
export function ok(cuerpo: unknown): RespuestaMarcada {
  return { [MARCA_RESPUESTA]: true, status: 200, cuerpo };
}

export function conStatus(status: number, cuerpo: unknown): RespuestaMarcada {
  return { [MARCA_RESPUESTA]: true, status, cuerpo };
}

/** Error JSON con la forma `{ message }` que lee el cliente HTTP de la SPA. */
export function fallo(status: number, message: string): RespuestaMarcada {
  return conStatus(status, { message });
}

export function esRespuestaMarcada(valor: unknown): valor is RespuestaMarcada {
  return typeof valor === "object" && valor !== null && (valor as Record<symbol, unknown>)[MARCA_RESPUESTA] === true;
}
