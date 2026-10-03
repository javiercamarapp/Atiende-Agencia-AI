import { MARCA_RESPUESTA } from "./tipos.ts";

export interface RespuestaMarcada {
  readonly [MARCA_RESPUESTA]: true;
  readonly status: number;
  readonly cuerpo: unknown;
  /** Si viene, se envia tal cual con este Content-Type en lugar de serializar `cuerpo` como JSON (p. ej. un flujo NDJSON). */
  readonly crudo?: { readonly tipo: string; readonly texto: string };
}

/** 200 con JSON (es el comportamiento por defecto de un manejador que devuelve un valor cualquiera). */
export function ok(cuerpo: unknown): RespuestaMarcada {
  return { [MARCA_RESPUESTA]: true, status: 200, cuerpo };
}

export function conStatus(status: number, cuerpo: unknown): RespuestaMarcada {
  return { [MARCA_RESPUESTA]: true, status, cuerpo };
}

/** Flujo NDJSON (una linea JSON por evento), como el POST de chat-datos de la API real con `Accept: application/x-ndjson`. */
export function ndjson(eventos: readonly unknown[]): RespuestaMarcada {
  return { [MARCA_RESPUESTA]: true, status: 200, cuerpo: undefined, crudo: { tipo: "application/x-ndjson; charset=utf-8", texto: eventos.map((e) => `${JSON.stringify(e)}\n`).join("") } };
}

/** Cuerpo no JSON (p. ej. la descarga binaria del paquete en un ZIP de texto simulado). */
export function crudo(tipo: string, texto: string): RespuestaMarcada {
  return { [MARCA_RESPUESTA]: true, status: 200, cuerpo: undefined, crudo: { tipo, texto } };
}

/** Error JSON con la forma `{ message }` que lee el cliente HTTP de la SPA. */
export function fallo(status: number, message: string): RespuestaMarcada {
  return conStatus(status, { message });
}

export function esRespuestaMarcada(valor: unknown): valor is RespuestaMarcada {
  return typeof valor === "object" && valor !== null && (valor as Record<symbol, unknown>)[MARCA_RESPUESTA] === true;
}
