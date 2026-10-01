// D-08 -- tipos y errores del portal del cliente final del despacho.
export type PortalDisponible<T> = { readonly disponible: true; readonly valor: T } | { readonly disponible: false };

export type PortalDocumentoEstado = "recibido" | "aceptado" | "rechazado";
export type PortalDocumentoTipo = "cfdi_xml" | "pdf" | "imagen";

export interface PortalObligacion {
  readonly tipo: string;
  readonly periodo: string;
  readonly fechaLimite: string;
  readonly estado: string;
  readonly fechaPresentacion: string | null;
}

export interface PortalCierre {
  readonly anio: number;
  readonly mes: number;
  readonly estado: string;
  readonly tareasTotal: number;
  readonly tareasListas: number;
}

/** Lo que el CLIENTE ve de sus documentos: nunca el contenido ni ids internos de enlace. */
export interface PortalDocumentoVistaCliente {
  readonly id: string;
  readonly tipo: PortalDocumentoTipo;
  readonly nombreArchivo: string;
  readonly estado: PortalDocumentoEstado;
  readonly motivo: string | null;
  readonly creadoEn: string;
}

export interface PortalMensaje {
  readonly autor: "cliente" | "despacho";
  readonly cuerpo: string;
  readonly creadoEn: string;
}

export interface PortalResumen {
  readonly clienteNombre: string;
  readonly despachoNombre: string;
  readonly expiraEn: string;
  readonly obligaciones: readonly PortalObligacion[];
  readonly cierres: readonly PortalCierre[];
  readonly documentos: readonly PortalDocumentoVistaCliente[];
  readonly mensajes: readonly PortalMensaje[];
}

export interface PortalEnlace {
  readonly id: string;
  readonly etiqueta: string;
  readonly creadoEn: string;
  readonly expiraEn: string;
  readonly revocadoEn: string | null;
  readonly ultimoUsoEn: string | null;
  readonly usos: number;
}

export interface PortalDocumentoStaff {
  readonly id: string;
  readonly enlaceId: string;
  readonly tipo: PortalDocumentoTipo;
  readonly nombreArchivo: string;
  readonly mimeType: string;
  readonly tamanoBytes: number;
  readonly estado: PortalDocumentoEstado;
  readonly motivo: string | null;
  readonly resumen: Readonly<Record<string, string>>;
  readonly invoiceId: string | null;
  readonly creadoEn: string;
  readonly resueltoEn: string | null;
}

export interface PortalMensajeStaff extends PortalMensaje {
  readonly id: string;
}

export interface PortalDocumentoContenido {
  readonly tipo: PortalDocumentoTipo;
  readonly nombreArchivo: string;
  readonly mimeType: string;
  readonly estado: PortalDocumentoEstado;
  readonly contenido: Uint8Array;
}

export interface NuevoDocumentoPortal {
  readonly tipo: PortalDocumentoTipo;
  readonly nombreArchivo: string;
  readonly mimeType: string;
  readonly contenido: Uint8Array;
  readonly resumen: Readonly<Record<string, string>>;
}

/** Puerto del portal. Los tres primeros metodos son del CLIENTE (sesion de sistema, reciben el HASH del
 * token); el resto son del STAFF (sesion de staff con acceso a la property). Cuando la migracion 016 aun
 * no esta aplicada devuelven `{ disponible: false }` en vez de fallar. */
export interface PortalClienteRepository {
  resumen(tokenHash: string): Promise<PortalDisponible<PortalResumen>>;
  recibirDocumento(tokenHash: string, doc: NuevoDocumentoPortal): Promise<PortalDisponible<{ readonly id: string; readonly estado: PortalDocumentoEstado; readonly duplicado: boolean }>>;
  enviarMensajeCliente(tokenHash: string, cuerpo: string): Promise<PortalDisponible<{ readonly id: string }>>;

  crearEnlace(propertyId: string, tokenHash: string, etiqueta: string, dias: number): Promise<PortalDisponible<{ readonly id: string; readonly expiraEn: string }>>;
  revocarEnlace(propertyId: string, enlaceId: string): Promise<PortalDisponible<boolean>>;
  listarEnlaces(propertyId: string): Promise<PortalDisponible<readonly PortalEnlace[]>>;
  listarDocumentos(propertyId: string): Promise<PortalDisponible<readonly PortalDocumentoStaff[]>>;
  listarMensajes(propertyId: string): Promise<PortalDisponible<readonly PortalMensajeStaff[]>>;
  contenidoDocumento(propertyId: string, documentoId: string): Promise<PortalDisponible<PortalDocumentoContenido | null>>;
  resolverDocumento(propertyId: string, documentoId: string, estado: "aceptado" | "rechazado", motivo: string | null, invoiceId: string | null): Promise<PortalDisponible<boolean>>;
  enviarMensajeStaff(propertyId: string, cuerpo: string): Promise<PortalDisponible<{ readonly id: string }>>;
}

/** Token inexistente, expirado o revocado: una sola clase, sin distinguir (anti-enumeracion). */
export class PortalEnlaceInvalidoError extends Error {
  constructor() {
    super("enlace_no_valido");
    this.name = "PortalEnlaceInvalidoError";
  }
}

export class PortalCuotaExcedidaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalCuotaExcedidaError";
  }
}

export class PortalEntradaInvalidaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalEntradaInvalidaError";
  }
}

export class PortalSinAccesoError extends Error {
  constructor() {
    super("sin acceso");
    this.name = "PortalSinAccesoError";
  }
}
