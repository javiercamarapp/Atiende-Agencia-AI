export * from "./tipos.ts";
export { decidirCanal, normalizarCorreo, normalizarTelefonoWhatsapp } from "./canal.ts";
export type { DecisionCanal, EntradaDecisionCanal } from "./canal.ts";
export {
  EVENTOS_PLANTILLA_HOTELES,
  PLANTILLA_ESTADOS,
  VARIABLES_HUESPED,
  armarParametrosPlantilla,
  claveCatalogoPlantilla,
  eventoDeClaveCatalogo,
  eventoPlantillaHoteles,
  validarPlantillaWhatsapp,
} from "./plantillas.ts";
export type {
  EstadoPlantillaWhatsapp,
  EventoPlantillaHoteles,
  PlantillaParaEncolar,
  PlantillaWhatsappAprobada,
  PlantillaWhatsappInput,
  PlantillaWhatsappRecord,
  ResultadoValidacionPlantilla,
  VariableHuesped,
} from "./plantillas.ts";
export { componerMensaje, formatearFechaCalendario, formatearInstanteLocal, formatearMontoCentavos, nombreCorto, urlAvisoPrivacidad, valoresDelCandidato } from "./textos.ts";
export type { ContextoTextos, MensajeComponido, ValoresMensaje } from "./textos.ts";
export type { EmitirMensajeEntrada, MensajesHuespedSistemaRepository, MensajesHuespedStaffRepository } from "./repository.ts";
export { ejecutarMensajesHuesped } from "./ejecutor.ts";
export type { ContextoMensajesHuesped, OpcionesMensajesHuesped, WithMensajesHuespedTx } from "./ejecutor.ts";
export { PostgresMensajesHuespedStaffRepository, PostgresMensajesHuespedSistemaRepository } from "./postgres-repository.ts";
export { InMemoryMensajesHuespedRepository } from "./in-memory-repository.ts";
export type { EnvioEnMemoria, OpcionesInMemoryMensajesHuesped } from "./in-memory-repository.ts";
