// D-27 -- adaptador SOAP al servicio PUBLICO ConsultaCFDIService del SAT (accion `Consulta`). Referencia: la consulta de
// estatus de Likida (src/lib/likida/intake/sat.ts). NO VERIFICADO contra el servicio real desde Vercel: la URL y el formato
// de la respuesta se transcribieron del servicio publico conocido y se cubren con fixtures XML; el SAT cambia rutas sin aviso.
//
// Seguridad: la expresion impresa se arma SOLO con valores validados (RFC, UUID, total finito), asi que ninguna entrada puede
// cerrar el CDATA ni inyectar XML. La respuesta se lee con tope de tamano y se interpreta con expresiones regulares
// tolerantes al prefijo de namespace (no se evalua XML ni se resuelven entidades).
import { consultaNoConcluida } from "./puerto.ts";
import type { ConsultaCfdiSatInput, ConsultaCfdiSatPort, ConsultaCfdiSatResultado } from "./puerto.ts";

export const SAT_CONSULTA_CFDI_URL = "https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc";
export const SAT_CONSULTA_CFDI_SOAP_ACTION = "http://tempuri.org/IConsultaCFDIService/Consulta";
export const SAT_TIMEOUT_MS_DEFECTO = 4000;
/** Una respuesta legitima mide ~1 KB; mas de esto es basura o un ataque de agotamiento de memoria. */
const MAX_BYTES_RESPUESTA = 64 * 1024;

const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface AdaptadorSoapSatOpciones {
  readonly fetchImpl?: typeof fetch;
  readonly url?: string;
  readonly timeoutMs?: number;
}

/** Expresion impresa del QR del CFDI (`?re=&rr=&tt=&id=`), o null si algun dato no es valido. */
export function construirExpresionImpresa(input: ConsultaCfdiSatInput): string | null {
  const re = input.rfcEmisor.trim().toUpperCase();
  const rr = input.rfcReceptor.trim().toUpperCase();
  const id = input.folioFiscal.trim();
  if (!RFC_RE.test(re) || !RFC_RE.test(rr) || !UUID_RE.test(id)) return null;
  if (!Number.isFinite(input.total) || input.total < 0 || input.total > 1e13) return null;
  return `?re=${re}&rr=${rr}&tt=${input.total.toFixed(6)}&id=${id.toUpperCase()}`;
}

function construirSobre(expresion: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">` +
    `<s:Body><tem:Consulta><tem:expresionImpresa><![CDATA[${expresion}]]></tem:expresionImpresa></tem:Consulta></s:Body></s:Envelope>`
  );
}

function elemento(xml: string, nombre: string): string | null {
  const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${nombre}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9_]+:)?${nombre}>`, "i").exec(xml);
  if (!m) return null;
  const texto = (m[1] ?? "").trim();
  return texto === "" ? null : texto;
}

/** Interpreta la respuesta SOAP. Exportada para probarla con fixtures XML sin red. */
export function interpretarRespuestaSat(xml: string): ConsultaCfdiSatResultado {
  if (!/<(?:[A-Za-z0-9_]+:)?Envelope[\s>]/i.test(xml) || !/<(?:[A-Za-z0-9_]+:)?ConsultaResult[\s>/]/i.test(xml)) return consultaNoConcluida("respuesta_invalida");
  const estadoRaw = (elemento(xml, "Estado") ?? "").toLowerCase();
  const estado = estadoRaw === "vigente" ? "vigente" : estadoRaw === "cancelado" ? "cancelado" : estadoRaw === "no encontrado" ? "no_encontrado" : null;
  if (estado === null) return consultaNoConcluida("respuesta_invalida");
  return { consultado: true, estado, esCancelable: elemento(xml, "EsCancelable"), estatusCancelacion: elemento(xml, "EstatusCancelacion"), codigoEstatus: elemento(xml, "CodigoEstatus"), validacionEfos: elemento(xml, "ValidacionEFOS") };
}

export class ConsultaCfdiSatSoap implements ConsultaCfdiSatPort {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(opciones: AdaptadorSoapSatOpciones = {}) {
    this.fetchImpl = opciones.fetchImpl ?? fetch;
    this.url = opciones.url ?? SAT_CONSULTA_CFDI_URL;
    this.timeoutMs = opciones.timeoutMs ?? SAT_TIMEOUT_MS_DEFECTO;
  }

  async consultar(input: ConsultaCfdiSatInput): Promise<ConsultaCfdiSatResultado> {
    const expresion = construirExpresionImpresa(input);
    if (expresion === null) return consultaNoConcluida("datos_insuficientes");
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: SAT_CONSULTA_CFDI_SOAP_ACTION },
        body: construirSobre(expresion),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return consultaNoConcluida("http");
      const largo = Number(res.headers.get("content-length") ?? 0);
      if (Number.isFinite(largo) && largo > MAX_BYTES_RESPUESTA) return consultaNoConcluida("respuesta_invalida");
      const xml = await res.text();
      if (xml.length > MAX_BYTES_RESPUESTA) return consultaNoConcluida("respuesta_invalida");
      return interpretarRespuestaSat(xml);
    } catch (err) {
      const nombre = err && typeof err === "object" ? (err as { name?: string }).name : undefined;
      return consultaNoConcluida(nombre === "TimeoutError" || nombre === "AbortError" ? "timeout" : "red");
    }
  }
}
