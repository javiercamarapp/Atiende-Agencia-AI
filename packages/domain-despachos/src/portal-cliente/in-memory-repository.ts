// D-08 -- doble en memoria del portal del cliente final para pruebas de rutas y de UI. Reproduce las
// reglas de la migracion 016 que importan a la API (token vigente por hash, aislamiento por property,
// idempotencia por SHA-256, resolucion unica); la verdad de seguridad sigue siendo SQL
// (scripts/verify-despachos-portal-cliente). `disponible=false` simula la base sin migrar.
import { createHash, randomUUID } from "node:crypto";
import { PortalCuotaExcedidaError, PortalEnlaceInvalidoError } from "./types.ts";
import type {
  ContextoIngestaPortal,
  DatosAceptacionPortal,
  EstadoAceptacionPortal,
  PortalCfdiListado,
  PortalCfdiVista,
  NuevoDocumentoPortal,
  PortalClienteRepository,
  PortalDisponible,
  PortalDocumentoContenido,
  PortalDocumentoEstado,
  PortalDocumentoStaff,
  PortalEnlace,
  PortalMensajeStaff,
  PortalObligacion,
  PortalCierre,
  PortalResumen,
} from "./types.ts";

interface EnlaceMem extends PortalEnlace {
  readonly propertyId: string;
  readonly tokenHash: string;
}
interface DocMem extends PortalDocumentoStaff {
  readonly propertyId: string;
  readonly sha256: string;
  readonly contenido: Uint8Array;
}
interface MsgMem extends PortalMensajeStaff {
  readonly propertyId: string;
}

/** Enlaces del doble con el resto del dominio (los CFDI y el contexto del autoaceptado viven en otros repositorios): las pruebas los inyectan. */
export interface IngestaPortalEnMemoria {
  readonly cfdi: (propertyId: string) => readonly PortalCfdiVista[] | Promise<readonly PortalCfdiVista[]>;
  readonly contexto: (propertyId: string, datos: { readonly folioFiscal: string | null; readonly fecha: string | null; readonly rfcEmisor: string | null }) => Promise<Omit<ContextoIngestaPortal, "organizationId" | "propertyId" | "documentoEstado" | "documentoTipo">>;
  readonly aceptar: (propertyId: string, datos: DatosAceptacionPortal) => Promise<{ readonly estado: EstadoAceptacionPortal; readonly invoiceId: string | null }>;
}

export interface ClientePortalSemilla {
  readonly propertyId: string;
  readonly organizationId?: string;
  readonly clienteNombre: string;
  readonly despachoNombre: string;
  readonly obligaciones?: readonly PortalObligacion[];
  readonly cierres?: readonly PortalCierre[];
}

export class InMemoryPortalClienteRepository implements PortalClienteRepository {
  disponible = true;
  readonly enlaces: EnlaceMem[] = [];
  readonly documentos: DocMem[] = [];
  readonly mensajes: MsgMem[] = [];
  private readonly clientes = new Map<string, ClientePortalSemilla>();

  constructor(private readonly ahora: () => Date = () => new Date()) {}

  sembrarCliente(c: ClientePortalSemilla): void {
    this.clientes.set(c.propertyId, c);
  }

  private envolver<T>(valor: () => T): PortalDisponible<T> {
    return this.disponible ? { disponible: true, valor: valor() } : { disponible: false };
  }

  private enlaceVigente(tokenHash: string): EnlaceMem {
    const e = this.enlaces.find((x) => x.tokenHash === tokenHash);
    if (!e || e.revocadoEn !== null || new Date(e.expiraEn).getTime() <= this.ahora().getTime()) throw new PortalEnlaceInvalidoError();
    return e;
  }

  async resumen(tokenHash: string): Promise<PortalDisponible<PortalResumen>> {
    if (!this.disponible) return { disponible: false };
    const e = this.enlaceVigente(tokenHash);
    const c = this.clientes.get(e.propertyId);
    return {
      disponible: true,
      valor: {
        clienteNombre: c?.clienteNombre ?? "Cliente",
        despachoNombre: c?.despachoNombre ?? "Despacho",
        expiraEn: e.expiraEn,
        obligaciones: c?.obligaciones ?? [],
        cierres: c?.cierres ?? [],
        documentos: this.documentos.filter((d) => d.propertyId === e.propertyId).map((d) => ({ id: d.id, tipo: d.tipo, nombreArchivo: d.nombreArchivo, estado: d.estado, motivo: d.motivo, creadoEn: d.creadoEn })),
        mensajes: this.mensajes.filter((m) => m.propertyId === e.propertyId).map((m) => ({ autor: m.autor, cuerpo: m.cuerpo, creadoEn: m.creadoEn })),
      },
    };
  }

  async recibirDocumento(tokenHash: string, doc: NuevoDocumentoPortal) {
    if (!this.disponible) return { disponible: false } as const;
    const e = this.enlaceVigente(tokenHash);
    const sha256 = createHash("sha256").update(doc.contenido).digest("hex");
    const previo = this.documentos.find((d) => d.propertyId === e.propertyId && d.sha256 === sha256);
    if (previo) return { disponible: true, valor: { id: previo.id, estado: previo.estado, duplicado: true } } as const;
    if (this.documentos.filter((d) => d.enlaceId === e.id).length >= 30) throw new PortalCuotaExcedidaError("Demasiadas operaciones en la ultima hora. Intenta mas tarde.");
    const nuevo: DocMem = {
      id: randomUUID(), enlaceId: e.id, tipo: doc.tipo, nombreArchivo: doc.nombreArchivo, mimeType: doc.mimeType, tamanoBytes: doc.contenido.length, estado: "recibido", motivo: null,
      resumen: doc.resumen, invoiceId: null, creadoEn: this.ahora().toISOString(), resueltoEn: null, propertyId: e.propertyId, sha256, contenido: doc.contenido,
    };
    this.documentos.push(nuevo);
    return { disponible: true, valor: { id: nuevo.id, estado: "recibido" as PortalDocumentoEstado, duplicado: false } } as const;
  }

  /** Se inyecta en las pruebas que ejercen el autoaceptado y el listado de CFDI del cliente. */
  ingesta: IngestaPortalEnMemoria | null = null;

  async listarCfdi(tokenHash: string) {
    if (!this.disponible) return { disponible: false } as const;
    const e = this.enlaceVigente(tokenHash);
    const cfdi = this.ingesta ? await this.ingesta.cfdi(e.propertyId) : [];
    const valor: PortalCfdiListado = { organizationId: this.clientes.get(e.propertyId)?.organizationId ?? "org-test", propertyId: e.propertyId, cfdi: cfdi.slice(0, 500) };
    return { disponible: true, valor } as const;
  }

  async contextoIngesta(documentoId: string, datos: { readonly folioFiscal: string | null; readonly fecha: string | null; readonly rfcEmisor: string | null }) {
    if (!this.disponible) return { disponible: false } as const;
    const d = this.documentos.find((x) => x.id === documentoId);
    if (!d) throw new PortalEnlaceInvalidoError();
    const base = this.ingesta
      ? await this.ingesta.contexto(d.propertyId, datos)
      : { autoaceptar: true, umbral: 0.7, fichaRfc: null, existe: false, periodoCerrado: false, efosSituacion: null, efosListaDisponible: false, correcciones: [] };
    const valor: ContextoIngestaPortal = { organizationId: this.clientes.get(d.propertyId)?.organizationId ?? "org-test", propertyId: d.propertyId, documentoEstado: d.estado, documentoTipo: d.tipo, ...base };
    return { disponible: true, valor } as const;
  }

  async aceptarCfdiSistema(documentoId: string, datos: DatosAceptacionPortal) {
    if (!this.disponible) return { disponible: false } as const;
    const i = this.documentos.findIndex((x) => x.id === documentoId);
    if (i < 0) throw new PortalEnlaceInvalidoError();
    const d = this.documentos[i]!;
    if (d.estado !== "recibido" || d.tipo !== "cfdi_xml") return { disponible: true, valor: { estado: "no_aplica" as EstadoAceptacionPortal, invoiceId: null } } as const;
    const r = this.ingesta ? await this.ingesta.aceptar(d.propertyId, datos) : { estado: "aceptado" as EstadoAceptacionPortal, invoiceId: randomUUID() };
    if (r.estado === "aceptado" || r.estado === "ya_existia") this.documentos[i] = { ...d, estado: "aceptado", invoiceId: r.invoiceId, motivo: r.estado === "ya_existia" ? "Ya existía" : "Aceptado automáticamente", resueltoEn: this.ahora().toISOString() };
    return { disponible: true, valor: r } as const;
  }

  async enviarMensajeCliente(tokenHash: string, cuerpo: string) {
    if (!this.disponible) return { disponible: false } as const;
    const e = this.enlaceVigente(tokenHash);
    const m: MsgMem = { id: randomUUID(), autor: "cliente", cuerpo: cuerpo.trim(), creadoEn: this.ahora().toISOString(), propertyId: e.propertyId };
    this.mensajes.push(m);
    return { disponible: true, valor: { id: m.id } } as const;
  }

  async crearEnlace(propertyId: string, tokenHash: string, etiqueta: string, dias: number) {
    return this.envolver(() => {
      const ahora = this.ahora();
      const e: EnlaceMem = {
        id: randomUUID(), etiqueta, creadoEn: ahora.toISOString(), expiraEn: new Date(ahora.getTime() + dias * 86_400_000).toISOString(), revocadoEn: null, ultimoUsoEn: null, usos: 0, propertyId, tokenHash,
      };
      this.enlaces.push(e);
      return { id: e.id, expiraEn: e.expiraEn };
    });
  }

  async revocarEnlace(propertyId: string, enlaceId: string) {
    return this.envolver(() => {
      const i = this.enlaces.findIndex((e) => e.id === enlaceId && e.propertyId === propertyId && e.revocadoEn === null);
      if (i < 0) return false;
      this.enlaces[i] = { ...this.enlaces[i]!, revocadoEn: this.ahora().toISOString() };
      return true;
    });
  }

  async listarEnlaces(propertyId: string) {
    return this.envolver((): readonly PortalEnlace[] => this.enlaces.filter((e) => e.propertyId === propertyId).map(({ propertyId: _p, tokenHash: _t, ...pub }) => pub));
  }

  async listarDocumentos(propertyId: string) {
    return this.envolver((): readonly PortalDocumentoStaff[] => this.documentos.filter((d) => d.propertyId === propertyId).map(({ propertyId: _p, sha256: _s, contenido: _c, ...pub }) => pub));
  }

  async listarMensajes(propertyId: string) {
    return this.envolver((): readonly PortalMensajeStaff[] => this.mensajes.filter((m) => m.propertyId === propertyId).map(({ propertyId: _p, ...pub }) => pub));
  }

  async contenidoDocumento(propertyId: string, documentoId: string) {
    return this.envolver((): PortalDocumentoContenido | null => {
      const d = this.documentos.find((x) => x.id === documentoId && x.propertyId === propertyId);
      return d ? { tipo: d.tipo, nombreArchivo: d.nombreArchivo, mimeType: d.mimeType, estado: d.estado, contenido: d.contenido } : null;
    });
  }

  async resolverDocumento(propertyId: string, documentoId: string, estado: "aceptado" | "rechazado", motivo: string | null, invoiceId: string | null) {
    return this.envolver(() => {
      const i = this.documentos.findIndex((d) => d.id === documentoId && d.propertyId === propertyId && d.estado === "recibido");
      if (i < 0) return false;
      this.documentos[i] = { ...this.documentos[i]!, estado, motivo, invoiceId, resueltoEn: this.ahora().toISOString() };
      return true;
    });
  }

  async enviarMensajeStaff(propertyId: string, cuerpo: string) {
    return this.envolver(() => {
      const m: MsgMem = { id: randomUUID(), autor: "despacho", cuerpo: cuerpo.trim(), creadoEn: this.ahora().toISOString(), propertyId };
      this.mensajes.push(m);
      return { id: m.id };
    });
  }
}
