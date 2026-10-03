export * from "./tipos.ts";
export { CerebroGuionado } from "./cerebro-guionado.ts";
export { correrGuionConAdaptador, proveedorFalsoGuionado } from "./correr-guion.ts";
export type { AdaptadorSimulador, OpcionesCorrida, ProveedorSimulable } from "./correr-guion.ts";
export { G_BARGE_IN, G_PREGRABADOS, G_RESULTADO, G_SIN_TARJETA, G_TONO_USTED, evaluarConGraders, graderSinPiiLog, graderTools, logContieneSensible, mal, ok } from "./graders-voz.ts";
export type { Grader, LlamadaGradeable } from "./graders-voz.ts";
