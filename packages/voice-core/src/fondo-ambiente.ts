// Sonido de fondo de restaurante OPCIONAL para la llamada (apagado por omision). El generador vive en `ambiente-restaurante.ts` (SINTETIZADO: sin archivos con
// licencia, determinista por semilla, con presets 'cocina-taqueria', 'sala-tranquila' y 'calle-ocupada', y ducking bajo la voz). Aqui quedan los nombres
// historicos (`FondoRestaurante`, constantes de volumen) para no romper a quien ya los importa.
//
// Este modulo es PURO (PCM16 little-endian mono, el formato del agente de Gemini a 24 kHz). La mezcla en vivo de la llamada la hace `MezcladorSalida`
// (`mezclador-salida.ts`), que el worker de telefonia (apps/voice-worker) alimenta con el audio del agente.
//
// Seguridad de la llamada: el volumen se acota a `FONDO_VOLUMEN_MAX` (el fondo nunca tapa la voz del agente) y la suma se satura en vez
// de desbordar (un desborde de PCM16 suena como un chasquido).
import { AmbienteRestaurante } from "./ambiente-restaurante.ts";
import type { OpcionesAmbiente } from "./ambiente-restaurante.ts";

export { FONDO_VOLUMEN_MAX, FONDO_VOLUMEN_MIN, FONDO_VOLUMEN_POR_DEFECTO, HZ_AUDIO_AGENTE, esVolumenFondo } from "./ambiente-restaurante.ts";

export type OpcionesFondo = OpcionesAmbiente;

/** Murmullo de fondo de restaurante (alias historico de `AmbienteRestaurante`). */
export class FondoRestaurante extends AmbienteRestaurante {}
