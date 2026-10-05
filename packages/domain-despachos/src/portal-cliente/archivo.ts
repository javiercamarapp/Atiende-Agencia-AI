// D-08 -- validacion ESTRICTA de lo que sube el cliente final del despacho. Nada se ejecuta ni se
// interpreta mas alla de lo imprescindible: el XML se valida y se resume con el parser de CFDI ya
// existente (@atiende/billing), el resto de los archivos solo se revisa por tamano, tipo declarado y
// firma de bytes, y se guarda tal cual en la bandeja del despacho. La base repite lo esencial
// (tamano, firma, sin DTD/entidades) como defensa en profundidad (migracion 016).
import { CfdiXmlParseError, parseCfdiXml, parseComplementoPagoXml } from "@atiende/billing";
import { tipoComprobanteDeXml } from "../cfdi/lote.ts";

export const PORTAL_MAX_ARCHIVO_BYTES = 2 * 1024 * 1024;

export type TipoArchivoPortal = "cfdi_xml" | "pdf" | "imagen";

export type CodigoRechazoArchivo = "vacio" | "demasiado_grande" | "tipo_no_permitido" | "firma_invalida" | "contenido_no_permitido" | "cfdi_invalido";

export interface ArchivoPortalAceptado {
  readonly ok: true;
  readonly tipo: TipoArchivoPortal;
  readonly mimeType: string;
  readonly nombreArchivo: string;
  /** Datos minimos extraidos (solo CFDI): nunca el XML completo. */
  readonly resumen: Readonly<Record<string, string>>;
}

export interface ArchivoPortalRechazado {
  readonly ok: false;
  readonly codigo: CodigoRechazoArchivo;
  readonly mensaje: string;
}

export type ResultadoValidacionArchivo = ArchivoPortalAceptado | ArchivoPortalRechazado;

const TIPOS_POR_MIME: Readonly<Record<string, TipoArchivoPortal>> = {
  "application/xml": "cfdi_xml",
  "text/xml": "cfdi_xml",
  "application/pdf": "pdf",
  "image/png": "imagen",
  "image/jpeg": "imagen",
};

const EXTENSIONES: Readonly<Record<TipoArchivoPortal, readonly string[]>> = {
  cfdi_xml: [".xml"],
  pdf: [".pdf"],
  imagen: [".png", ".jpg", ".jpeg"],
};

const FIRMA_PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FIRMA_JPEG = [0xff, 0xd8, 0xff];

/** Marcadores de PDF activo (JavaScript, lanzar programas, adjuntos): se rechazan en vez de guardarlos
 * para que el staff no abra uno por accidente. Es una barrera heuristica (un PDF con flujos comprimidos
 * puede ocultarlos); el archivo en todo caso nunca se ejecuta ni se renderiza en el servidor. */
const PDF_ACTIVO_RE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/;

function empiezaCon(bytes: Uint8Array, firma: readonly number[]): boolean {
  return bytes.length >= firma.length && firma.every((b, i) => bytes[i] === b);
}

function rechazo(codigo: CodigoRechazoArchivo, mensaje: string): ArchivoPortalRechazado {
  return { ok: false, codigo, mensaje };
}

/** Quita rutas y caracteres peligrosos; nunca devuelve vacio ni mas de 120 caracteres. */
export function sanitizarNombreArchivo(nombre: string | null | undefined, tipo: TipoArchivoPortal): string {
  let base = (nombre ?? "").normalize("NFC");
  base = base.split(/[\\/]/).at(-1) ?? "";
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
  base = base.replace(/^\.+/, "");
  if (base.length > 120) {
    const punto = base.lastIndexOf(".");
    const ext = punto > 0 && base.length - punto <= 6 ? base.slice(punto) : "";
    base = base.slice(0, 120 - ext.length) + ext;
  }
  if (base.length === 0) base = `archivo${EXTENSIONES[tipo][0]}`;
  return base;
}

function validarXml(bytes: Uint8Array): ArchivoPortalRechazado | { readonly resumen: Record<string, string> } {
  let texto: string;
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return rechazo("contenido_no_permitido", "El XML debe estar codificado en UTF-8.");
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  if (texto.includes("\u0000")) return rechazo("contenido_no_permitido", "El XML contiene caracteres no permitidos.");
  const trimmed = texto.trimStart();
  if (!trimmed.startsWith("<")) return rechazo("firma_invalida", "El archivo no parece un XML.");
  // Sin DTD ni entidades: `<!` solo se admite para comentarios y CDATA. Esto cierra XXE (entidades externas)
  // y la expansion de entidades (billion laughs) antes de que el parser vea el documento.
  if (/<!(?!--|\[CDATA\[)/.test(texto)) return rechazo("contenido_no_permitido", "El XML no puede declarar DTD ni entidades.");
  if (/<\?xml-stylesheet/i.test(texto)) return rechazo("contenido_no_permitido", "El XML no puede incluir hojas de estilo.");
  const codificacion = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(texto);
  if (codificacion && codificacion[1]!.toLowerCase() !== "utf-8") {
    return rechazo("contenido_no_permitido", "El XML debe declarar codificacion UTF-8.");
  }
  try {
    // D-P3-22: un complemento de pago (REP, tipo P) es un XML valido para el portal -- el parser de facturas lo rechaza a proposito, asi que se lee con el parser de REP.
    if (tipoComprobanteDeXml(texto) === "P") {
      const rep = parseComplementoPagoXml(texto);
      return { resumen: { folio_fiscal: rep.folioFiscal, tipo: "P", total: "0.00", fecha: rep.fecha.slice(0, 10), rfc_emisor: rep.rfcEmisor, rfc_receptor: rep.rfcReceptor } };
    }
    const cfdi = parseCfdiXml(texto);
    return {
      resumen: {
        folio_fiscal: cfdi.folioFiscal,
        tipo: cfdi.tipo,
        total: cfdi.total.toFixed(2),
        fecha: cfdi.fecha.slice(0, 10),
        rfc_emisor: cfdi.rfcEmisor,
        rfc_receptor: cfdi.rfcReceptor,
      },
    };
  } catch (err) {
    if (err instanceof CfdiXmlParseError) return rechazo("cfdi_invalido", err.message);
    throw err;
  }
}

export interface EntradaArchivoPortal {
  readonly nombre: string | null | undefined;
  readonly contentType: string | null | undefined;
  readonly bytes: Uint8Array;
}

export function validarArchivoPortal(entrada: EntradaArchivoPortal): ResultadoValidacionArchivo {
  const { bytes } = entrada;
  if (bytes.length === 0) return rechazo("vacio", "El archivo esta vacio.");
  if (bytes.length > PORTAL_MAX_ARCHIVO_BYTES) return rechazo("demasiado_grande", "El archivo excede 2 MB.");

  const mimeType = (entrada.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const tipo = TIPOS_POR_MIME[mimeType];
  if (!tipo) return rechazo("tipo_no_permitido", "Solo se aceptan XML de CFDI, PDF, PNG o JPEG.");

  const nombreCrudo = (entrada.nombre ?? "").split(/[\\/]/).at(-1) ?? "";
  const extension = nombreCrudo.includes(".") ? nombreCrudo.slice(nombreCrudo.lastIndexOf(".")).toLowerCase() : "";
  if (extension && !EXTENSIONES[tipo].includes(extension)) {
    return rechazo("tipo_no_permitido", "La extension del archivo no coincide con su tipo.");
  }
  const nombreArchivo = sanitizarNombreArchivo(entrada.nombre, tipo);

  if (tipo === "pdf") {
    if (!empiezaCon(bytes, FIRMA_PDF)) return rechazo("firma_invalida", "El archivo no es un PDF valido.");
    if (PDF_ACTIVO_RE.test(Buffer.from(bytes).toString("latin1"))) return rechazo("contenido_no_permitido", "El PDF contiene contenido activo (scripts o adjuntos).");
    return { ok: true, tipo, mimeType, nombreArchivo, resumen: {} };
  }
  if (tipo === "imagen") {
    const coincide = mimeType === "image/png" ? empiezaCon(bytes, FIRMA_PNG) : empiezaCon(bytes, FIRMA_JPEG);
    if (!coincide) return rechazo("firma_invalida", "La imagen no coincide con su tipo declarado.");
    return { ok: true, tipo, mimeType, nombreArchivo, resumen: {} };
  }
  const xml = validarXml(bytes);
  if ("ok" in xml) return xml;
  return { ok: true, tipo, mimeType, nombreArchivo, resumen: xml.resumen };
}
