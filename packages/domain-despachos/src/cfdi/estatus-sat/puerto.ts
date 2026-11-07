// D-27 -- puerto de consulta del estatus de un CFDI ante el SAT (servicio PUBLICO ConsultaCFDIService).
//
// Contrato (fail-safe): `consultar` NUNCA lanza y NUNCA devuelve 'vigente' por error. Ante timeout, red caida, HTTP no 2xx o
// respuesta ilegible devuelve `consultado: false` con `estado: 'pendiente'`; el llamador conserva el estado que ya tenia.
// 'vigente' / 'cancelado' / 'no_encontrado' solo se devuelven cuando el SAT respondio un <Estado> reconocido.
import type { EstadoSatCfdi } from "../modelo-cfdi.ts";

export interface ConsultaCfdiSatInput {
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  /** Total del comprobante en pesos (se formatea con 6 decimales en la expresion impresa). */
  readonly total: number;
  /** Folio fiscal (UUID del timbre). */
  readonly folioFiscal: string;
}

export type MotivoConsultaSatFallida = "datos_insuficientes" | "timeout" | "red" | "http" | "respuesta_invalida";

export interface ConsultaCfdiSatResultado {
  /** true = el SAT respondio un estado reconocido; false = la consulta no concluyo (el estado devuelto es 'pendiente'). */
  readonly consultado: boolean;
  readonly estado: EstadoSatCfdi;
  /** Texto del SAT (EsCancelable): "Cancelable sin aceptación", "Cancelable con aceptación", "No cancelable". */
  readonly esCancelable: string | null;
  /** Texto del SAT (EstatusCancelacion): "En proceso", "Plazo vencido", "Cancelado sin aceptación", ... */
  readonly estatusCancelacion: string | null;
  /** Texto del SAT (CodigoEstatus): "S - Comprobante obtenido satisfactoriamente.", "N - 601: La expresión impresa proporcionada no es válida.", ... */
  readonly codigoEstatus: string | null;
  /** Codigo del SAT (ValidacionEFOS): "200" = el emisor no esta en la lista 69-B, "100" = esta. Se guarda tal cual lo devuelve el SAT. */
  readonly validacionEfos: string | null;
  /** Solo cuando `consultado` es false. */
  readonly motivo?: MotivoConsultaSatFallida;
}

export interface ConsultaCfdiSatPort {
  consultar(input: ConsultaCfdiSatInput): Promise<ConsultaCfdiSatResultado>;
}

export function consultaNoConcluida(motivo: MotivoConsultaSatFallida): ConsultaCfdiSatResultado {
  return { consultado: false, estado: "pendiente", esCancelable: null, estatusCancelacion: null, codigoEstatus: null, validacionEfos: null, motivo };
}
