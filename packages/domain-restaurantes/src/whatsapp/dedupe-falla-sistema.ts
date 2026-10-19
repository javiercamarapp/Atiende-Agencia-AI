// PM Ronda 12 (seguimiento de #593): durante una caida larga del proveedor SIN toma de handoff, cada mensaje del cliente producia un aviso `falla_sistema` nuevo. Aqui se
// acota a UNO por organizacion y telefono cada `VENTANA_DEDUPE_FALLA_SISTEMA_MIN` minutos. Es memoria del proceso (sin migracion ni lectura de `callback_requests`, que la sesion
// de sistema no ve por RLS): en una instancia fria o distinta puede haber un segundo intento, y ahi manda la agrupacion de la base (migracion 047: un aviso abierto del mismo
// telefono y motivo recibe una nota en vez de crear otro). El turno SIGUE contando como fallo para la alerta de racha: esto solo evita repetir el aviso al equipo.

/** Un aviso `falla_sistema` por telefono en esta ventana. */
export const VENTANA_DEDUPE_FALLA_SISTEMA_MIN = 15;
/** Tope de entradas: se purgan las vencidas al pasarlo (la memoria nunca crece sin limite). */
const MAX_ENTRADAS = 2000;

const ultimoAviso = new Map<string, number>();

const llave = (organizationId: string, phone: string) => `${organizationId}|${phone.replace(/\D/g, "").slice(-10)}`;

/** ¿Ya se aviso la falla del sistema de este telefono dentro de la ventana? */
export function avisoFallaSistemaReciente(organizationId: string, phone: string, ahoraMs: number = Date.now()): boolean {
  const t = ultimoAviso.get(llave(organizationId, phone));
  return t !== undefined && ahoraMs - t < VENTANA_DEDUPE_FALLA_SISTEMA_MIN * 60_000;
}

/** Marca que el aviso quedo registrado (solo despues de que de verdad se registro). */
export function marcarAvisoFallaSistema(organizationId: string, phone: string, ahoraMs: number = Date.now()): void {
  if (ultimoAviso.size >= MAX_ENTRADAS) {
    for (const [k, t] of ultimoAviso) if (ahoraMs - t >= VENTANA_DEDUPE_FALLA_SISTEMA_MIN * 60_000) ultimoAviso.delete(k);
    if (ultimoAviso.size >= MAX_ENTRADAS) ultimoAviso.clear();
  }
  ultimoAviso.set(llave(organizationId, phone), ahoraMs);
}

/** Solo para pruebas. */
export function reiniciarDedupeFallaSistema(): void {
  ultimoAviso.clear();
}
