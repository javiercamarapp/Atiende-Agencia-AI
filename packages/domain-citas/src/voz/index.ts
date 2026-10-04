// Agente de VOZ de citas sobre @atiende/voice-core: perfil (prompt y pregrabados), registro de tools con la maquina de la cita, guardia de crisis,
// transportes hacia el servidor, costo por llamada y el simulador con sus guiones es-MX. Ver README.md de la vertical y del core.
export { DEFINICIONES_VOZ_CITAS, REGLAS_CIERRE_CITAS, crearRegistroToolsCitas } from "./registro-tools.ts";
export type { ResultadoVozCitas } from "./registro-tools.ts";
export { MaquinaCitaVoz, TOOLS_ESCRITURA_CITAS } from "./maquina-cita.ts";
export type { EstadoCitaVoz, RechazoMaquinaCita } from "./maquina-cita.ts";
export { TONO_VOZ_INSTRUCCION, instruccionVozCita, mensajeSaludoRespaldo, mensajesPregrabadosCita } from "./perfil-voz.ts";
export type { EntradaInstruccionVozCita } from "./perfil-voz.ts";
export { MOTIVO_CRISIS_VOZ, PREFIJO_PALABRA_CLAVE, crearGuardiaCrisisVoz, evaluarCrisisVoz } from "./guardia-crisis.ts";
export { canonicalizarTelefonoCitas } from "./telefono.ts";
export { TOOLS_VOZ_CITAS, VozToolValidacionError, derivarAHumanoVoz, ejecutarToolVozCitas, esToolVozCitas, rutaToolVozCitas } from "./tools-servidor.ts";
export type { CitasVozContexto, ResultadoDerivacion, ToolVozCitas } from "./tools-servidor.ts";
export { transporteEnProcesoCitas, transporteHttpCitas } from "./transporte.ts";
export type { TransporteHttpCitasOpciones } from "./transporte.ts";
export { InMemoryCostoVozRepository, PostgresCostoVozRepository } from "./costo-repositorio.ts";
export type { RepositorioCostoVoz, ResultadoRegistroCosto } from "./costo-repositorio.ts";
export { obtenerContextoLlamadaVoz } from "./contexto-llamada.ts";
export type { ContextoLlamadaVoz } from "./contexto-llamada.ts";
