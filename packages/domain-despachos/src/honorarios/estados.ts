// D-32 -- maquina de estados de una prefactura. La base repite estas reglas en sus funciones (migracion 023); esta tabla es la verdad del
// dominio TypeScript y del doble en memoria, y una prueba la contrasta con la matriz documentada.
import type { EstadoPrefactura } from "./types.ts";

export type AccionPrefactura = "aprobar" | "reservar_timbrado" | "registrar_timbre" | "registrar_fallo" | "cancelar";

export const TRANSICIONES: Readonly<Record<AccionPrefactura, { readonly desde: readonly EstadoPrefactura[]; readonly hacia: EstadoPrefactura }>> = {
  aprobar: { desde: ["borrador"], hacia: "aprobada" },
  // Una reserva vieja (`timbrando` expirada) tambien se reclama; la expiracion la decide la base/el doble con el reloj.
  reservar_timbrado: { desde: ["aprobada", "fallida"], hacia: "timbrando" },
  registrar_timbre: { desde: ["timbrando"], hacia: "timbrada" },
  registrar_fallo: { desde: ["timbrando"], hacia: "fallida" },
  // Desde `timbrando` nunca; una timbrada solo con acuse del PAC (ver `CancelacionDatos.acusePac`).
  cancelar: { desde: ["borrador", "aprobada", "fallida", "timbrada"], hacia: "cancelada" },
};

export function puedeTransicionar(estado: EstadoPrefactura, accion: AccionPrefactura): boolean {
  return TRANSICIONES[accion].desde.includes(estado);
}

/** Etiqueta y tono para la pantalla (sin colores: el tono lo traduce la UI). */
export const ETIQUETAS_ESTADO_PREFACTURA: Readonly<Record<EstadoPrefactura, string>> = {
  borrador: "Borrador",
  aprobada: "Aprobada",
  timbrando: "Timbrando",
  timbrada: "Timbrada",
  cancelada: "Cancelada",
  fallida: "Fallida",
};
