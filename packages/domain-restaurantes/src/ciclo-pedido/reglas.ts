// Reglas PURAS del ciclo operativo del pedido por la sucursal (F4b): aceptar/rechazar con tiempo prometido y motivo, textos al cliente,
// encuesta post-entrega (envio, respuesta, baja), recordatorios sin aceptar y ratios de operacion. Sin red, sin base, sin reloj propio
// (todo recibe el instante): lo prueban los tests deterministas y lo reutilizan el servicio y las rutas. Los criterios de la encuesta
// (2 a 3 h, silencio 23:00-9:00, una cada 14 dias, 1 a 5, sin incentivo de resena) viven en `../encuesta-reglas.ts` y NO se reescriben aqui.
import { redactSensitiveInfo } from "../whatsapp/inbound.ts";
import { ENCUESTA_ESCALA_MAX, ENCUESTA_ESCALA_MIN, accionSegunCalificacion, contieneIncentivoDeResena, decidirEnvioEncuesta, textoRecuperacionPrivada } from "../encuesta-reglas.ts";

// ---------------------------------------------------------------------------------------------------------------------------------------
// 1. Aceptar / rechazar
// ---------------------------------------------------------------------------------------------------------------------------------------
export const TIEMPO_PROMETIDO_MIN = 5;
export const TIEMPO_PROMETIDO_MAX = 240;
export const TIEMPO_PROMETIDO_POR_OMISION = { domicilio: 45, recoger: 20 } as const;

export const MOTIVOS_RECHAZO = ["sin_insumos", "cerrado", "fuera_de_zona", "saturado", "datos_incompletos", "otro"] as const;
export type MotivoRechazo = (typeof MOTIVOS_RECHAZO)[number];

/** Frase para el cliente por motivo (trato de usted, sin culpar y sin detalles internos). */
export const FRASE_RECHAZO: Readonly<Record<MotivoRechazo, string>> = {
  sin_insumos: "por el momento no contamos con algunos de los productos de su pedido",
  cerrado: "la sucursal ya cerró o aún no abre",
  fuera_de_zona: "su domicilio queda fuera de nuestra zona de entrega",
  saturado: "tenemos demasiados pedidos en cocina y no podemos cumplir con un tiempo razonable",
  datos_incompletos: "nos faltan datos para poder entregarle su pedido",
  otro: "no pudimos atenderlo en esta ocasión",
};

export function esMotivoRechazo(valor: unknown): valor is MotivoRechazo {
  return typeof valor === "string" && (MOTIVOS_RECHAZO as readonly string[]).includes(valor);
}

export function esTiempoPrometidoValido(minutos: unknown): minutos is number {
  return typeof minutos === "number" && Number.isInteger(minutos) && minutos >= TIEMPO_PROMETIDO_MIN && minutos <= TIEMPO_PROMETIDO_MAX;
}

export interface PedidoParaAviso {
  readonly customerName: string;
  readonly branch: string | null;
  readonly total: number;
}

function saludo(p: PedidoParaAviso): string {
  return p.customerName ? `Hola ${p.customerName}, ` : "Hola, ";
}
function sucursal(p: PedidoParaAviso): string {
  return p.branch ? ` de ${p.branch}` : "";
}
function mxn(n: number): string {
  return `$${n.toFixed(2)} MXN`;
}
/** "45 minutos" / "1 hora" / "1 hora 15 minutos": el tiempo prometido en lenguaje de cliente. */
export function describirMinutos(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  const horas = h === 0 ? "" : h === 1 ? "1 hora" : `${h} horas`;
  const mins = m === 0 ? "" : m === 1 ? "1 minuto" : `${m} minutos`;
  return [horas, mins].filter(Boolean).join(" ") || "0 minutos";
}

export function textoPedidoAceptado(p: PedidoParaAviso, minutos: number, canal: "domicilio" | "recoger" | null): string {
  const verbo = canal === "recoger" ? "estará listo para recoger" : "le llegará";
  return `${saludo(p)}su pedido${sucursal(p)} (${mxn(p.total)}) fue aceptado y ya lo estamos preparando. Tiempo estimado: ${describirMinutos(minutos)}; ${verbo} en ese lapso.`;
}

export function textoPedidoRechazado(p: PedidoParaAviso, motivo: MotivoRechazo): string {
  return `${saludo(p)}lamentamos informarle que no podemos atender su pedido${sucursal(p)}: ${FRASE_RECHAZO[motivo]}. Si lo desea, escríbanos y con gusto le ayudamos con otra opción.`;
}

/** Plantillas HSM nuevas (a crear y aprobar en Meta, idioma es_MX). Variables del cuerpo en el orden que dice `parametros*`. */
export const PLANTILLA_PEDIDO_ACEPTADO = { name: "pedido_aceptado_con_tiempo", language: "es_MX" } as const;
export const PLANTILLA_PEDIDO_RECHAZADO = { name: "pedido_rechazado", language: "es_MX" } as const;
export const PLANTILLA_ENCUESTA_ENTREGA = { name: "encuesta_entrega", language: "es_MX" } as const;

function variable(valor: string | null | undefined, respaldo: string): string {
  const limpio = (valor ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
  return limpio.length > 0 ? limpio : respaldo;
}
/** {{1}} nombre, {{2}} sucursal, {{3}} total, {{4}} tiempo ("45 minutos"). */
export function parametrosPedidoAceptado(p: PedidoParaAviso, minutos: number): readonly string[] {
  return [variable(p.customerName, "cliente"), variable(p.branch, "la sucursal"), mxn(p.total), describirMinutos(minutos)];
}
/** {{1}} nombre, {{2}} sucursal, {{3}} motivo en una frase. */
export function parametrosPedidoRechazado(p: PedidoParaAviso, motivo: MotivoRechazo): readonly string[] {
  return [variable(p.customerName, "cliente"), variable(p.branch, "la sucursal"), FRASE_RECHAZO[motivo]];
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 2. Encuesta post-entrega
// ---------------------------------------------------------------------------------------------------------------------------------------
/** Margen bajo las 24 h de WhatsApp: con 23 h ya no se manda texto libre (el reloj de Meta corre desde el ultimo mensaje del cliente). */
export const VENTANA_WHATSAPP_MS = 23 * 60 * 60 * 1000;

export function ventanaDeTextoAbierta(ultimoEntrante: Date | null, ahora: Date): boolean {
  if (!ultimoEntrante) return false;
  const edad = ahora.getTime() - ultimoEntrante.getTime();
  return edad >= 0 && edad < VENTANA_WHATSAPP_MS;
}

export type MotivoOmision = "opt_out" | "cliente_reciente" | "sin_ventana_ni_plantilla" | "sin_canal" | "sin_telefono";

export type DecisionEncuesta =
  | { readonly accion: "esperar" }
  | { readonly accion: "omitir"; readonly motivo: MotivoOmision }
  | { readonly accion: "enviar"; readonly canal: "texto" | "plantilla" };

export interface EntradaDecisionEncuesta {
  readonly ahora: Date;
  readonly deliveredAt: Date;
  readonly zonaHoraria: string | null;
  readonly telefonoValido: boolean;
  readonly optOut: boolean;
  readonly ultimaEncuestaCliente: Date | null;
  /** Ultimo mensaje ENTRANTE del cliente (para la ventana de 24 h). */
  readonly ultimoEntrante: Date | null;
  /** La plantilla `encuesta_entrega` esta declarada aprobada por el operador. */
  readonly plantillaAprobada: boolean;
  /** Consentimiento de avisos vigente (091): requisito para escribirle FUERA de la ventana. */
  readonly consentimiento: boolean;
  /** Hay numero de WhatsApp activo para la sucursal. */
  readonly hayCanal: boolean;
}

/**
 * Cuando y como encuestar. Orden: sin telefono / baja / cliente encuestado hace < 14 dias => omitir (queda registrado, nunca se reintenta);
 * antes de `delivered_at + 2 h` (o dentro del silencio 23:00-9:00) => esperar; sin canal => omitir; ventana de 24 h abierta => texto libre;
 * si no, plantilla SOLO con plantilla aprobada Y consentimiento vigente; si no, omitir (nunca se escribe fuera de la ventana sin plantilla).
 */
export function decidirEncuesta(e: EntradaDecisionEncuesta): DecisionEncuesta {
  if (!e.telefonoValido) return { accion: "omitir", motivo: "sin_telefono" };
  if (e.optOut) return { accion: "omitir", motivo: "opt_out" };
  const base = decidirEnvioEncuesta({ deliveredAt: e.deliveredAt, zonaHoraria: e.zonaHoraria, pedidoYaEncuestado: false, ultimaEncuestaCliente: e.ultimaEncuestaCliente });
  if (!base.enviar) return { accion: "omitir", motivo: "cliente_reciente" };
  if (e.ahora.getTime() < base.enviarDespuesDe.getTime()) return { accion: "esperar" };
  if (!e.hayCanal) return { accion: "omitir", motivo: "sin_canal" };
  if (ventanaDeTextoAbierta(e.ultimoEntrante, e.ahora)) return { accion: "enviar", canal: "texto" };
  if (e.plantillaAprobada && e.consentimiento) return { accion: "enviar", canal: "plantilla" };
  return { accion: "omitir", motivo: "sin_ventana_ni_plantilla" };
}

export function textoEncuesta(nombreSucursal: string | null): string {
  const lugar = nombreSucursal ? ` en ${nombreSucursal}` : "";
  return `¿Cómo calificaría su pedido${lugar}? Responda con un número del ${ENCUESTA_ESCALA_MIN} (muy mal) al ${ENCUESTA_ESCALA_MAX} (excelente). Si no desea recibir más encuestas, responda BAJA.`;
}
/** Plantilla encuesta_entrega: {{1}} nombre, {{2}} sucursal. El cuerpo aprobado debe pedir 1 a 5 y ofrecer BAJA. */
export function parametrosEncuesta(nombre: string | null, sucursalNombre: string | null): readonly string[] {
  return [variable(nombre, "cliente"), variable(sucursalNombre, "la sucursal")];
}

export type RespuestaEncuesta =
  | { readonly tipo: "calificacion"; readonly valor: number }
  | { readonly tipo: "baja" }
  | { readonly tipo: "otro" };

const SIN_ACENTOS = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const PALABRAS: Readonly<Record<string, number>> = { uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
/** BAJA de encuestas: solo frases inequivocas. "no gracias" y "alto" ya NO cuentan (P1-1 de la revision de #713: eran respuestas normales a una pregunta del agente). */
const BAJA = /^(baja|stop|no mas encuestas|no quiero (mas )?encuestas|ya no (quiero )?(mas )?encuestas|cancelar encuestas)\W*$/;

/** Minutos, tras enviar la pregunta, en que un "1 a 5" se toma como respuesta de la encuesta (antes 48 h). Pasado ese lapso el mensaje es del agente. */
export const ENCUESTA_VENTANA_RESPUESTA_MIN = 30;
/** Minutos, tras calificar, en que el siguiente mensaje se guarda como comentario opcional. */
export const ENCUESTA_VENTANA_COMENTARIO_MIN = 30;

/**
 * Interpreta la respuesta a la pregunta de 1 a 5: "4", "4.", "cuatro", "5 estrellas", "un 3"; "BAJA"/"STOP" es la baja; cualquier otra cosa es `otro` (no se adivina).
 * Sin encuesta abierta (`encuestaAbierta: false`) SOLO se reconoce una baja inequivoca ("baja", "no quiero mas encuestas"): ni "stop" ni un numero (P2 de la revision de #713).
 */
export function interpretarRespuestaEncuesta(texto: string, opciones: { readonly encuestaAbierta?: boolean } = {}): RespuestaEncuesta {
  const abierta = opciones.encuestaAbierta !== false;
  const t = SIN_ACENTOS(texto);
  if (BAJA.test(t)) return !abierta && /^stop\W*$/.test(t) ? { tipo: "otro" } : { tipo: "baja" };
  if (!abierta) return { tipo: "otro" };
  const m = /^(?:un |una |le doy |doy |un )?([1-5]|uno|dos|tres|cuatro|cinco)(?:\s*(?:\/\s*5|de 5|estrellas?|puntos?|\.|!|,))?\W*$/.exec(t);
  if (!m) return { tipo: "otro" };
  const v = m[1]!;
  return { tipo: "calificacion", valor: /^\d$/.test(v) ? Number(v) : PALABRAS[v]! };
}

export interface TextosRespuestaEncuesta {
  /** Mensaje al cliente tras calificar. */
  readonly cliente: string;
  readonly esBaja: boolean;
}

/**
 * Mensaje de cierre segun la nota. SIN filtrado de resenas (P1-2 de la revision de #713; politicas de Google y FTC 16 CFR 465): el enlace de resena NO depende de la calificacion y
 * esta encuesta no ofrece ninguno (a nadie). <= 3 abre un seguimiento INTERNO (devolver llamada) como paso adicional, sin mencionar Google ni resenas.
 */
export function textosTrasCalificar(calificacion: number, nombreSucursal: string): TextosRespuestaEncuesta {
  const accion = accionSegunCalificacion(calificacion);
  const pedirComentario = "Si quiere agregar un comentario, escríbalo ahora en un solo mensaje.";
  if (accion.tipo === "invitar_resena_google") return { cliente: `¡Gracias por su calificación! ${pedirComentario}`, esBaja: false };
  return { cliente: textoRecuperacionPrivada(nombreSucursal), esBaja: true };
}
/**
 * Redaccion del comentario libre ANTES de guardarlo (P1-3 de la revision de #713). Primero la MISMA redaccion que la conversacion (`redactSensitiveInfo`: tarjetas, vencimientos, CVV) y
 * ademas lo que la conversacion conserva pero un comentario de encuesta no necesita: telefonos, correos y direcciones (calle/avenida/colonia con numero, "#123", cruzamientos "por 21 y 23").
 * Es deliberadamente agresiva: prefiere perder un dato inofensivo a guardar PII.
 */
export function redactarComentarioEncuesta(texto: string): string {
  return redactSensitiveInfo(texto)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[correo]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[número]")
    .replace(/\b(?:calle|c\.|avenida|av\.?|colonia|col\.|fracc(?:ionamiento)?\.?|andador|privada|priv\.|carretera|km|manzana|mza\.?|lote)\s+[^,;\n]{0,60}/gi, "[dirección]")
    .replace(/#\s*\d+[\w-]*(?:\s*(?:por|x|entre)\s*\d+[\w]*(?:\s*(?:y|e)\s*\d+[\w]*)?)?/gi, "[dirección]")
    .slice(0, 500);
}

export const TEXTO_GRACIAS_COMENTARIO = "Gracias, su comentario quedó registrado.";
export const TEXTO_BAJA_ENCUESTA = "Listo, no le enviaremos más encuestas. Gracias.";

/** Verifica que un texto saliente de la encuesta no condicione ni incentive la resena (lo usa la bateria de tests y el servicio antes de enviar). */
export function textoEncuestaSeguro(texto: string): boolean {
  return !contieneIncentivoDeResena(texto);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 3. Recordatorios de pedidos sin aceptar
// ---------------------------------------------------------------------------------------------------------------------------------------
export interface ConfigRecordatorio {
  readonly habilitado: boolean;
  readonly primeroMin: number;
  readonly repetirMin: number;
  readonly maximo: number;
}
export const RECORDATORIO_POR_OMISION: ConfigRecordatorio = { habilitado: true, primeroMin: 10, repetirMin: 10, maximo: 3 };

/** Numero de recordatorio (1..maximo) que toca a un pedido de `edadMin` minutos sin aceptar, o `null` si aun no toca. Mismo calculo que la funcion SQL 172. */
export function numeroRecordatorio(edadMin: number, cfg: ConfigRecordatorio): number | null {
  if (!cfg.habilitado || !Number.isFinite(edadMin) || edadMin < cfg.primeroMin) return null;
  return Math.min(cfg.maximo, 1 + Math.floor((edadMin - cfg.primeroMin) / cfg.repetirMin));
}
/** El ultimo recordatorio se escala tambien a owner/admin (un recordatorio mas ya no cambia nada). */
export function esUltimoRecordatorio(n: number, maximo: number): boolean {
  return n >= maximo;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 4. Ratios de operacion (tiempo real vs prometido y encuesta)
// ---------------------------------------------------------------------------------------------------------------------------------------
export interface TiemposCrudos {
  readonly pedidos: number;
  readonly aceptados: number;
  readonly rechazados: number;
  readonly entregadosConPromesa: number;
  readonly aTiempo: number;
  readonly realMinProm: number | null;
  readonly prometidoMinProm: number | null;
  readonly aceptacionSegProm: number | null;
  readonly salidaMinProm: number | null;
  readonly rechazosPorMotivo: Readonly<Record<string, number>>;
}
export interface EncuestaCruda {
  readonly enviadas: number;
  readonly respondidas: number;
  readonly omitidas: number;
  readonly conComentario: number;
  readonly sumaCalificacion: number;
  readonly bajas: number;
  readonly distribucion: Readonly<Record<string, number>>;
  readonly omitidasPorMotivo: Readonly<Record<string, number>>;
  readonly optouts: number;
}
export interface RatiosOperacion {
  /** % de pedidos aceptados (de los que ya no estan pendientes de decision). */
  readonly tasaAceptacionPct: number | null;
  readonly tasaRechazoPct: number | null;
  /** % de entregas dentro del tiempo prometido (sobre las que tenian promesa). */
  readonly cumplimientoPromesaPct: number | null;
  /** real - prometido en minutos (positivo = tardo mas de lo prometido). */
  readonly desvioMinProm: number | null;
  readonly aceptacionSegProm: number | null;
  readonly salidaMinProm: number | null;
  readonly encuesta: {
    readonly tasaRespuestaPct: number | null;
    readonly promedio: number | null;
    readonly pctBajas: number | null;
    readonly tasaOptOutPct: number | null;
    readonly enviadas: number;
    readonly respondidas: number;
  };
}

function pct(parte: number, total: number): number | null {
  return total > 0 ? Math.round((parte / total) * 1000) / 10 : null;
}
function redondear(n: number | null, d = 1): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function calcularRatiosOperacion(t: TiemposCrudos, e: EncuestaCruda): RatiosOperacion {
  const decididos = t.aceptados + t.rechazados;
  return {
    tasaAceptacionPct: pct(t.aceptados, decididos),
    tasaRechazoPct: pct(t.rechazados, decididos),
    cumplimientoPromesaPct: pct(t.aTiempo, t.entregadosConPromesa),
    desvioMinProm: t.realMinProm !== null && t.prometidoMinProm !== null ? redondear(t.realMinProm - t.prometidoMinProm) : null,
    aceptacionSegProm: redondear(t.aceptacionSegProm, 0),
    salidaMinProm: redondear(t.salidaMinProm),
    encuesta: {
      tasaRespuestaPct: pct(e.respondidas, e.enviadas),
      promedio: e.respondidas > 0 ? redondear(e.sumaCalificacion / e.respondidas, 2) : null,
      pctBajas: pct(e.bajas, e.respondidas),
      tasaOptOutPct: pct(e.optouts, e.enviadas + e.omitidas),
      enviadas: e.enviadas,
      respondidas: e.respondidas,
    },
  };
}
