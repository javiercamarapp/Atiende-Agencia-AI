export { PREFIJO_HASH_SUPRESION, hashearContacto, hashearNormalizado, normalizarContacto, normalizarCorreo, normalizarTelefono } from "./normalizar.ts";
export type { TipoContacto } from "./normalizar.ts";
export { avisarSupresionNoMigrada, crearGuardCorreo, crearGuardSupresion, crearGuardTelefono, esSupresionNoMigrada, registrarSupresion } from "./acceso.ts";
export type { GuardSupresion, MotivoSupresion, ResultadoRegistro } from "./acceso.ts";
export { BAJA_CONFIRMADA_TEXTO, esPalabraBaja, procesarMensajeBaja } from "./baja.ts";
export type { ResultadoBaja } from "./baja.ts";
