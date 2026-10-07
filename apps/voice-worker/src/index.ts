// Barrel de @atiende/voice-worker: lo que reutilizan las pruebas y el verify. El proceso real arranca en `main.ts`.
export { ClienteApi, ErrorApi } from "./api-cliente.ts";
export type { ContextoLlamada, TurnoRegistro } from "./api-cliente.ts";
export { cargarConfig, parsearTablaDnis, normalizarNumero, resolverTopeMensualMicroUsd, modoEntradaDeLlamada, franjaDeHora } from "./config.ts";
export type { ConfigWorker, EntradaDnis, ModoEntrada } from "./config.ts";
export { atenderLlamada, DISPARADOR_SALUDO } from "./llamada.ts";
export type { DepsAtencion, ResumenAtencion } from "./llamada.ts";
export { PuenteAudio } from "./puente-audio.ts";
export { Worker, crearServidorSalud } from "./worker.ts";
export { cargarPregrabados } from "./pregrabados.ts";
export { Remuestreador, remuestrearPcm16 } from "./audio/remuestreo.ts";
export { TelefoniaFalsa, LlamadaFalsa } from "./telefonia/falsa.ts";
export type { LlamadaTelefonica, TelefoniaPort } from "./telefonia/puerto.ts";
