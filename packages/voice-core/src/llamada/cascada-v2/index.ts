// Cascada v2 en streaming (Deepgram STT + LLM por OpenRouter + Deepgram Aura-2 TTS), por puertos. Ver `sesion.ts`.
export { crearProveedorCascadaV2 } from "./sesion.ts";
export type { CascadaV2Opciones, ProveedorCascadaV2Llamada } from "./sesion.ts";
export { ColaAsync } from "./puertos.ts";
export type { ContextoTurnoLlm, EventosStt, OpcionesStt, OpcionesTts, PuertoSttVoz, PuertoTtsVoz, SesionStt, SesionTts } from "./puertos.ts";
export { DEEPGRAM_LISTEN_URL, crearSttDeepgram, keytermsDe, urlListenDeepgram } from "./deepgram-stt.ts";
export type { DeepgramSttOpciones } from "./deepgram-stt.ts";
export { DEEPGRAM_SPEAK_URL, VOCES_AURA2_ES, crearTtsDeepgram, partirTexto, resolverVozAura2, urlSpeakDeepgram } from "./deepgram-tts.ts";
export type { DeepgramTtsOpciones } from "./deepgram-tts.ts";
export { crearSegmentadorFrases, limpiarParaVoz } from "./frases.ts";
export type { OpcionesSegmentador, SegmentadorFrases } from "./frases.ts";
export { ejecutarHerramientas } from "./herramientas.ts";
export { crearSocketDeepgramGlobal } from "./socket.ts";
export type { CrearSocketDeepgram, OpcionesSocketDeepgram, SocketDeepgram } from "./socket.ts";
