// Utilidades compartidas por las fixtures del panel del operador (encargado y chofer). Su proposito: que ninguna respuesta simulada se
// desvie del contrato real. `conContrato` valida el cuerpo contra el esquema de `contratos.ts` ANTES de enviarlo; si no cumple, lanza y
// el servidor simulado responde 500 con el detalle («error en la fixture»), de modo que un mock desfasado rompe el e2e en vez de
// ocultar el desajuste. Import relativo (no el alias del workspace): el mock corre en Node puro (`--experimental-strip-types`).
import { describirErrores } from "../../../../../packages/domain-restaurantes/src/operacion/esquema.ts";
import type { Esquema } from "../../../../../packages/domain-restaurantes/src/operacion/esquema.ts";
import { MENSAJE_NO_IMPLEMENTADO } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import { conStatus } from "../respuestas.ts";
import type { RespuestaMarcada } from "../respuestas.ts";

export { RUTAS_OPERACION } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";

/** Devuelve `cuerpo` (con el status pedido) solo si cumple el esquema; si no, lanza con los errores por campo. */
export function conContrato<T>(esquema: Esquema<T>, cuerpo: unknown, status = 200): RespuestaMarcada {
  const r = esquema.validar(cuerpo);
  if (!r.ok) throw new Error(`la respuesta simulada no cumple el contrato: ${describirErrores(r.errores)}`);
  return conStatus(status, r.valor);
}

/** Error de la API real: `{ code, message }` (ver apps/api/src/app.ts onError). */
export function errorApi(status: number, code: string, message: string): RespuestaMarcada {
  return conStatus(status, { code, message });
}

/** Lo que responde hoy el servidor para las rutas del panel que aun no tienen backend (501 honesto). */
export function respuestaNoImplementada(): RespuestaMarcada {
  return errorApi(501, "no_implementado", MENSAJE_NO_IMPLEMENTADO);
}
