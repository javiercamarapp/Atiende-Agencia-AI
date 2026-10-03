// Agente de VOZ de hoteles sobre @atiende/voice-core: perfil (prompt y pregrabados), registro de tools con la maquina de la reserva, transportes
// hacia el servidor, costo por llamada y el simulador con sus guiones es-MX. Ver README.md de la vertical y del core.
export { DEFINICIONES_VOZ_HOTELES, REGLAS_CIERRE_HOTELES, crearRegistroToolsHoteles } from "./registro-tools.ts";
export type { ResultadoVozHoteles } from "./registro-tools.ts";
export { MaquinaReservaVoz } from "./maquina-reserva.ts";
export type { CotizacionVoz, EstadoReservaVoz, RechazoMaquina } from "./maquina-reserva.ts";
export { instruccionVozHotel, mensajeSaludoRespaldo, mensajesPregrabadosHotel } from "./perfil-voz.ts";
export type { EntradaInstruccionVozHotel } from "./perfil-voz.ts";
export { canonicalizarTelefonoHoteles } from "./telefono.ts";
export {
  TOOLS_VOZ_HOTELES,
  VozToolValidacionError,
  crearTicketFnbVoz,
  ejecutarReservasVoz,
  ejecutarToolVozHoteles,
  esToolVozHoteles,
  registrarContactoNoOperativoVoz,
  rutaToolVozHoteles,
} from "./tools-servidor.ts";
export type { ContactoNoOperativoVozEntrada, ReservasVozContexto, TicketFnbVozEntrada, ToolVozHoteles } from "./tools-servidor.ts";
export { transporteEnProcesoHoteles, transporteHttpHoteles } from "./transporte.ts";
export type { TransporteHttpHotelesOpciones } from "./transporte.ts";
export { InMemoryCostoVozRepository, PostgresCostoVozRepository } from "./costo-repositorio.ts";
export type { RepositorioCostoVoz, ResultadoRegistroCosto } from "./costo-repositorio.ts";
