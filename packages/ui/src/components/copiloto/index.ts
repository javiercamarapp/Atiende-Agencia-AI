export { ChatDatosShell } from "./ChatDatosShell";
export { SeccionFijadosCopiloto, MAX_FIJADOS_VISIBLES } from "./SeccionFijadosCopiloto";
export { useIdiomaCopiloto, traductorCopiloto, type ClaveCopiloto, type TraducirCopiloto } from "./idioma";
export type { SeccionFijadosCopilotoProps } from "./SeccionFijadosCopiloto";
export { CopilotoAccionError, CopilotoErrorTransporte, FijadosErrorCliente, MOTIVOS_VALORACION_COPILOTO } from "./tipos";
export { CopilotoTarjetaAccion, TOOL_PROPONER_ACCION, propuestaDeBloque } from "./CopilotoTarjetaAccion";
export type {
  ChatDatosShellProps,
  CopilotoAccionEstado,
  CopilotoAccionFalla,
  CopilotoAccionPropuesta,
  CopilotoAccionVista,
  CopilotoAccionesCliente,
  ConversacionCompleta,
  ConversacionResumen,
  CopilotoBloque,
  CopilotoCategoria,
  CopilotoCelda,
  CopilotoCobertura,
  CopilotoColumna,
  CopilotoColumnaTipo,
  CopilotoDirecta,
  CopilotoEvento,
  CopilotoFuente,
  CopilotoMensaje,
  CopilotoRespuesta,
  CopilotoStatus,
  CopilotoTextos,
  CopilotoTransporte,
  CopilotoValoracion,
  MotivoValoracionCopiloto,
  FijadoResultado,
  FijadoResumen,
  FijadosCliente,
  FijadosFalla,
} from "./tipos";
export { faseSegunTiempo } from "./fases";
export { textoAviso } from "./CopilotoMensaje";
export { GraficaBloque, Kpi, Sparkline, planGrafica } from "./CopilotoGraficas";
export { bloqueACsv, nombreArchivoCsv } from "./formato";
