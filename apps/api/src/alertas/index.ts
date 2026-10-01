export { crearDespachadorAlertas, configAlertasDesdeEnv } from "./despachador.ts";
export type { ConfigAlertas, DependenciasDespachador } from "./despachador.ts";
export { redactarTexto, redactarValor, MARCA_REDACTADO } from "./redaccion.ts";
export { crearLimitadorAlertas, normalizarLimitePorHora, LIMITE_POR_HORA_POR_DEFECTO } from "./limite-horario.ts";
export type { AlertaSaliente, DespachadorAlertas, ResultadoAlerta, ResultadoCanalAlerta, SeveridadAlertaSaliente } from "./tipos.ts";
