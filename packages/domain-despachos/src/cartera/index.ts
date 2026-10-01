export { validarRfcCliente, RFCS_GENERICOS } from "./rfc.ts";
export type { ResultadoRfc, TipoPersona } from "./rfc.ts";
export { validarFichaCliente, validarNombreCliente, PERIODICIDADES_PAGOS } from "./ficha.ts";
export type { ErrorCampo, FichaClienteNormalizada, PeriodicidadPagos, ResultadoFicha } from "./ficha.ts";
export {
  CarteraDatosInvalidosError,
  CarteraNoDisponibleError,
  CarteraSinPermisoError,
  CarteraTopeExcedidoError,
  ClienteRfcDuplicadoError,
} from "./types.ts";
export type { CarteraRepository, CarteraResultado, ClienteCarteraRow, ClienteFichaRecord } from "./types.ts";
export { PostgresCarteraRepository } from "./postgres-repository.ts";
export { InMemoryCarteraRepository, CARTERA_TOPE_POR_ORGANIZACION } from "./in-memory-repository.ts";
