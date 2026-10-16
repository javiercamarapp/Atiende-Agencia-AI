// Consultas que el SERVIDOR ya hizo antes de la primera vuelta del turno y cuyo resultado es el mismo que devolveria la herramienta (R10 P1, latencia).
//
// Cada vuelta del modelo cuesta ~3.3 s y una herramienta de lectura cuesta 2-40 ms: el cuello de botella son las vueltas, no las herramientas. Cuando el servidor ya sabe la
// respuesta de una herramienta SIN ambiguedad, decirselo al modelo evita una vuelta entera (llamar -> leer el resultado -> escribir).
//
// Solo se precarga lo que es IDENTICO a lo que devolveria la herramienta:
//   - `buscar_cliente` de un cliente NUEVO: el webhook usa la misma consulta (`lookupCustomerConPedidoReciente`) que la herramienta y su resultado es `{ isNew: true }`.
//     El prompt ya dice «Cliente nuevo» (pmCustomerContextBlock), pero el paso 3 de perfil-pm.ts manda llamar buscar_cliente siempre: una ida al modelo para leer «cliente nuevo».
//
// Lo que NO se precarga (a proposito):
//   - `buscar_cliente` de un cliente conocido: la direccion guardada no se inyecta en el prompt (privacidad, ver pmCustomerContextBlock); el modelo solo la ve si llama la herramienta.
//   - `buscar_sucursal_cercana`: depende de la colonia que dice el cliente y, con un pin compartido DESPUES de la colonia, del cruce colonia/pin (#556); precargarla con el pin solo se
//     saltaria ese cruce. Ver tests/whatsapp/vueltas-por-turno.spec.ts (medicion y por que no).
import type { CustomerLookupResult } from "../types.ts";

export interface OpcionesDatosYaConsultados {
  /** Solo el perfil PM: es el unico cuyo prompt manda llamar buscar_cliente en el paso 3. */
  readonly perfil: string;
  /** La vista previa del panel puede simular un cliente conocido en la herramienta (`previewCustomerId`): ahi el resultado de la herramienta NO es el del webhook. */
  readonly preview: boolean;
}

/** Marca estable del bloque (la usan las pruebas y el arnes de vueltas). */
export const MARCA_DATOS_YA_CONSULTADOS = "DATOS YA CONSULTADOS POR EL SISTEMA";

/** Bloque que se agrega al prompt del turno; `""` = no hay nada que precargar (el prompt queda exactamente como antes). */
export function bloqueDatosYaConsultados(customer: CustomerLookupResult, { perfil, preview }: OpcionesDatosYaConsultados): string {
  if (perfil !== "taqueria_pm" || preview) return "";
  if (!customer.isNew) return "";
  return `${MARCA_DATOS_YA_CONSULTADOS} (este bloque manda sobre el paso 3 en lo de llamar buscar_cliente):\n- buscar_cliente ya se consultó y devolvió cliente nuevo: sin nombre, sin direcciones guardadas y sin pedido reciente. No la llame en este turno; siga con el paso 3 sin esa llamada.`;
}
