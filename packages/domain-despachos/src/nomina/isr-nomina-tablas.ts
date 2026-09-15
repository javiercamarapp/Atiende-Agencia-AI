// ═══════════════════════════════════════════════════════════════════════════
// TABLAS ISR DE NÓMINA — CORRECCIÓN FISCAL (auditoría, hallazgo CRÍTICO #1):
// este archivo ya NO mantiene su propia copia de la tarifa Art. 96 LISR. La
// nómina se retiene bajo la MISMA tarifa que cualquier otra retención
// periódica del Art. 96 — no existe en la ley una "tabla de nómina"
// distinta de la tabla general de personas físicas; tener dos copias con
// valores diferentes (esta antes decía "2026" con cifras que ni siquiera
// coincidían con el Anexo 8 real de ningún ejercicio) es exactamente la
// contradicción que el hallazgo reportó: la misma base gravable producía un
// ISR distinto según si pasaba por `isr-engine.ts` (declaraciones/PF) o por
// `isr-nomina-engine.ts` (nómina).
//
// Fuente única de verdad: declaraciones/isr-tablas.ts (`ISR_MENSUAL_2026`/
// `ISR_ANUAL_2026`, ya verificadas contra el Anexo 8 RMF 2026, DOF
// 28-dic-2025). Este archivo solo re-exporta esas mismas constantes bajo
// los nombres que `isr-nomina-engine.ts` y el resto del paquete ya
// importaban, para no romper ningún consumidor existente.
export type { TablaIsr, FilaTablaIsr } from "../declaraciones/isr-tablas.ts";
export { ISR_MENSUAL_2026 as ISR_NOMINA_MENSUAL_2026, ISR_ANUAL_2026 as ISR_NOMINA_ANUAL_2026 } from "../declaraciones/isr-tablas.ts";
