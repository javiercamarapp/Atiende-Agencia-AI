// Barril de src/mensajeria (Fase 7 -- "un agente redacta la respuesta al huésped, y
// esa respuesta no sale hasta que alguien la aprueba"). Mismo patrón que
// ../ical/*, ../sync/*: solo reexporta lo público de esta subcarpeta.
export { CANALES_MENSAJERIA } from "./tipos.ts";
export type {
  CanalMensajeriaCodigo,
  ContextoBorrador,
  DireccionMensaje,
  EstadoBorrador,
  EventoPlantilla,
  IdiomaMensaje,
  MensajeEntradaHuesped,
  OrigenMensaje,
  ResultadoBorrador,
  SenalEscalamiento,
} from "./tipos.ts";

export { detectarSenalesEscalamiento } from "./escalamiento.ts";

export { EVENTOS_PLANTILLA, exigirPlantillaAprobadaParaProgramar, extraerVariables, PlantillaNoAprobadaError, renderizarPlantilla, VariablePlantillaFaltanteError } from "./plantillas.ts";
export type { PlantillaMensaje } from "./plantillas.ts";

export { contieneLenguajeExcluyente, ContenidoProhibidoError, detectarContactoOPago, MensajeExcedeLongitudError, politicaDeCanal, POLITICAS_POR_CANAL, validarMensajeSaliente } from "./politica.ts";
export type { EntradaValidarMensajeSaliente, HallazgosContactoPago, PoliticaCanalMensajeria, ResultadoValidarMensajeSaliente } from "./politica.ts";

export { SimuladorCanalMensajeria } from "./canalMensajeria.ts";
export type { CanalMensajeria, EntradaEnviarMensajeAprobado, EstadoConexionCanalMensajeria, MessagingChannelCapabilities, ResultadoEnvioMensaje } from "./canalMensajeria.ts";

export { GeneradorBorradorPlantillas } from "./borrador.ts";
export type { GeneradorBorrador } from "./borrador.ts";

export { AprobacionRequeridaError, aprobarBorrador, intentarEnvioAutomatico, marcarEnviadoTrasAprobacion, rechazarBorrador, TransicionBorradorInvalidaError } from "./colaAprobacion.ts";
export type { BorradorEstado, ResultadoAprobarBorrador, ResultadoMarcarEnviado, ResultadoRechazarBorrador } from "./colaAprobacion.ts";

export type { RentasMensajeriaRepository } from "./repository.ts";
export { InMemoryRentasMensajeriaRepository } from "./in-memory-repository.ts";
export { PostgresRentasMensajeriaRepository } from "./postgres-repository.ts";
export type {
  BorradorRecord,
  ConversacionRecord,
  GeneradoPorBorrador,
  MarcarBorradorAprobadoYEnviadoInput,
  MarcarBorradorRechazadoInput,
  MensajeRecord,
  NewBorradorInput,
  NewConversacionInput,
  NewMensajeInput,
  NewPlantillaInput,
  PlantillaRecord,
  UpdatePlantillaInput,
} from "./types.ts";
