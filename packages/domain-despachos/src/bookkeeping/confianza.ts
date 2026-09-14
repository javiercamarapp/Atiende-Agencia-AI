// Umbrales de confianza — puerto de `b2b_ai/common/confidence.py` (fuente
// única de verdad del origen para estos 4 valores, antes triplicados e
// inconsistentes en 3 archivos). Los valores por defecto son configurables
// por variable de entorno en Python (`B2B_CONFIDENCE_*`); aquí se exponen
// como constantes — si en el futuro despachos necesita overridearlos por
// tenant, es una extensión aditiva sobre estas constantes, no un cambio de
// esta fase.
export const CONFIDENCE_FLOOR = 0.5;
export const CONFIDENCE_MEDIUM = 0.6;
export const CONFIDENCE_HIGH = 0.85;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

// Invariante verificada al cargar el módulo — igual que el origen
// (`raise ValueError` en import time si queda mal configurado) y mismo
// patrón que `migracion-catalogo/matching.ts` (verificación de invariante
// de módulo al cargar, ver `SUMA_PESOS`).
if (DEFAULT_CONFIDENCE_THRESHOLD < CONFIDENCE_FLOOR) {
  throw new Error(`Configuración de confianza inconsistente: DEFAULT_CONFIDENCE_THRESHOLD (${DEFAULT_CONFIDENCE_THRESHOLD}) no puede ser menor que CONFIDENCE_FLOOR (${CONFIDENCE_FLOOR}).`);
}
