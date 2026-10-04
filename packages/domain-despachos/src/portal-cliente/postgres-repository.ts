// D-08 -- adaptador Postgres del portal del cliente final (migracion 016). Todas las operaciones corren
// bajo `runWithSavepointFallback` porque la sesion es UNA transaccion compartida por request: contra la
// base SIN migrar el 42883/42P01/42703 degrada a `{ disponible: false }` sin dejar la transaccion
// abortada (25P02). Los demas errores se traducen a errores de dominio tipados, sin filtrar mensajes de
// Postgres al cliente del portal.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  PortalCuotaExcedidaError,
  PortalEnlaceInvalidoError,
  PortalEntradaInvalidaError,
  PortalSinAccesoError,
} from "./types.ts";
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
  PortalDocumentoTipo,
  PortalEnlace,
  PortalMensajeStaff,
  PortalResumen,
} from "./types.ts";

const PORTAL_FN_PREFIX = "despachos.portal_";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la migracion 016 -> error de dominio. */
function traducirError(err: unknown): unknown {
  switch (pgCode(err)) {
    case "P0002":
      return new PortalEnlaceInvalidoError();
    case "54000":
      return new PortalCuotaExcedidaError(err instanceof Error && err.message.includes("bandeja") ? "La bandeja de documentos esta llena. Avisa a tu despacho." : "Demasiadas operaciones en la ultima hora. Intenta mas tarde.");
    case "22023":
    case "23514":
    case "23505":
      return new PortalEntradaInvalidaError("La solicitud no es valida.");
    case "42501":
      return new PortalSinAccesoError();
    default:
      return err;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

interface ResumenJson {
  cliente: { nombre: string };
  despacho: { nombre: string };
  expira_en: string;
  obligaciones: { tipo: string; periodo: string; fecha_limite: string; estado: string; fecha_presentacion: string | null }[];
  cierres: { anio: number; mes: number; estado: string; tareas_total: number; tareas_listas: number }[];
  documentos: { id: string; tipo: PortalDocumentoTipo; nombre_archivo: string; estado: PortalDocumentoEstado; motivo: string | null; creado_en: string }[];
  mensajes: { autor: "cliente" | "despacho"; cuerpo: string; creado_en: string }[];
}

export class PostgresPortalClienteRepository implements PortalClienteRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Igual que `ejecutar`, para las funciones `system_portal_*` de la migracion 026 (el nombre no lleva el prefijo `despachos.portal_`). */
  private async ejecutarSistema<T>(savepointName: string, fn: () => Promise<T>): Promise<PortalDisponible<T>> {
    try {
      return await runWithSavepointFallback<PortalDisponible<T>>({
        session: this.db,
        savepointName,
        primary: async () => ({ disponible: true, valor: await fn() }),
        isRecoverable: (err) => isMigrationPendingError(err, "system_portal_"),
        fallback: async () => ({ disponible: false }),
      });
    } catch (err) {
      throw traducirError(err);
    }
  }

  private async ejecutar<T>(savepointName: string, fn: () => Promise<T>): Promise<PortalDisponible<T>> {
    try {
      return await runWithSavepointFallback<PortalDisponible<T>>({
        session: this.db,
        savepointName,
        primary: async () => ({ disponible: true, valor: await fn() }),
        isRecoverable: (err) => isMigrationPendingError(err, PORTAL_FN_PREFIX),
        fallback: async () => ({ disponible: false }),
      });
    } catch (err) {
      throw traducirError(err);
    }
  }

  resumen(tokenHash: string): Promise<PortalDisponible<PortalResumen>> {
    return this.ejecutar("sp_portal_resumen", async () => {
      const { rows } = await this.db.query<{ r: ResumenJson }>("select despachos.portal_cliente_resumen($1) as r;", [tokenHash]);
      const r = rows[0]?.r;
      if (!r) throw new PortalEnlaceInvalidoError();
      return {
        clienteNombre: r.cliente.nombre,
        despachoNombre: r.despacho.nombre,
        expiraEn: r.expira_en,
        obligaciones: r.obligaciones.map((o) => ({ tipo: o.tipo, periodo: o.periodo, fechaLimite: o.fecha_limite, estado: o.estado, fechaPresentacion: o.fecha_presentacion })),
        cierres: r.cierres.map((c) => ({ anio: c.anio, mes: c.mes, estado: c.estado, tareasTotal: Number(c.tareas_total), tareasListas: Number(c.tareas_listas) })),
        documentos: r.documentos.map((d) => ({ id: d.id, tipo: d.tipo, nombreArchivo: d.nombre_archivo, estado: d.estado, motivo: d.motivo, creadoEn: d.creado_en })),
        mensajes: r.mensajes.map((m) => ({ autor: m.autor, cuerpo: m.cuerpo, creadoEn: m.creado_en })),
      };
    });
  }

  recibirDocumento(tokenHash: string, doc: NuevoDocumentoPortal) {
    return this.ejecutar("sp_portal_doc_recibir", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_estado: PortalDocumentoEstado; out_duplicado: boolean }>(
        "select out_id, out_estado, out_duplicado from despachos.portal_cliente_documento_recibir($1, $2, $3, $4, $5, $6::jsonb);",
        [tokenHash, doc.tipo, doc.nombreArchivo, doc.mimeType, Buffer.from(doc.contenido), JSON.stringify(doc.resumen)],
      );
      const r = rows[0];
      if (!r) throw new PortalEnlaceInvalidoError();
      return { id: r.out_id, estado: r.out_estado, duplicado: r.out_duplicado };
    });
  }

  enviarMensajeCliente(tokenHash: string, cuerpo: string) {
    return this.ejecutar("sp_portal_msg_cliente", async () => {
      const { rows } = await this.db.query<{ id: string }>("select despachos.portal_cliente_mensaje_enviar($1, $2) as id;", [tokenHash, cuerpo]);
      return { id: rows[0]!.id };
    });
  }

  crearEnlace(propertyId: string, tokenHash: string, etiqueta: string, dias: number) {
    return this.ejecutar("sp_portal_enlace_crear", async () => {
      const { rows } = await this.db.query<{ out_id: string; out_expira_en: string | Date }>("select out_id, out_expira_en from despachos.portal_enlace_crear($1, $2, $3, $4);", [propertyId, tokenHash, etiqueta, dias]);
      return { id: rows[0]!.out_id, expiraEn: iso(rows[0]!.out_expira_en) };
    });
  }

  revocarEnlace(propertyId: string, enlaceId: string) {
    return this.ejecutar("sp_portal_enlace_revocar", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>("select despachos.portal_enlace_revocar($1, $2) as ok;", [propertyId, enlaceId]);
      return rows[0]!.ok === true;
    });
  }

  listarEnlaces(propertyId: string) {
    return this.ejecutar("sp_portal_enlace_listar", async (): Promise<readonly PortalEnlace[]> => {
      // Columnas explicitas: `token_hash` no esta en el GRANT del staff y jamas se selecciona.
      const { rows } = await this.db.query<{ id: string; etiqueta: string; creado_en: string | Date; expira_en: string | Date; revocado_en: string | Date | null; ultimo_uso_en: string | Date | null; usos: number }>(
        "select id, etiqueta, creado_en, expira_en, revocado_en, ultimo_uso_en, usos from despachos.portal_cliente_enlace where property_id = $1 order by creado_en desc limit 100;",
        [propertyId],
      );
      return rows.map((r) => ({ id: r.id, etiqueta: r.etiqueta, creadoEn: iso(r.creado_en), expiraEn: iso(r.expira_en), revocadoEn: isoOrNull(r.revocado_en), ultimoUsoEn: isoOrNull(r.ultimo_uso_en), usos: Number(r.usos) }));
    });
  }

  listarDocumentos(propertyId: string) {
    return this.ejecutar("sp_portal_doc_listar", async (): Promise<readonly PortalDocumentoStaff[]> => {
      const { rows } = await this.db.query<{
        id: string; enlace_id: string; tipo: PortalDocumentoTipo; nombre_archivo: string; mime_type: string; tamano_bytes: number;
        estado: PortalDocumentoEstado; motivo: string | null; resumen: Record<string, string>; invoice_id: string | null; creado_en: string | Date; resuelto_en: string | Date | null;
      }>(
        "select id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, estado, motivo, resumen, invoice_id, creado_en, resuelto_en from despachos.portal_cliente_documento where property_id = $1 order by creado_en desc limit 100;",
        [propertyId],
      );
      return rows.map((r) => ({
        id: r.id, enlaceId: r.enlace_id, tipo: r.tipo, nombreArchivo: r.nombre_archivo, mimeType: r.mime_type, tamanoBytes: Number(r.tamano_bytes), estado: r.estado, motivo: r.motivo,
        resumen: r.resumen ?? {}, invoiceId: r.invoice_id, creadoEn: iso(r.creado_en), resueltoEn: isoOrNull(r.resuelto_en),
      }));
    });
  }

  listarMensajes(propertyId: string) {
    return this.ejecutar("sp_portal_msg_listar", async (): Promise<readonly PortalMensajeStaff[]> => {
      const { rows } = await this.db.query<{ id: string; autor: "cliente" | "despacho"; cuerpo: string; creado_en: string | Date }>(
        "select id, autor, cuerpo, creado_en from despachos.portal_cliente_mensaje where property_id = $1 order by creado_en desc limit 100;",
        [propertyId],
      );
      return rows.map((r) => ({ id: r.id, autor: r.autor, cuerpo: r.cuerpo, creadoEn: iso(r.creado_en) })).reverse();
    });
  }

  contenidoDocumento(propertyId: string, documentoId: string) {
    return this.ejecutar("sp_portal_doc_contenido", async (): Promise<PortalDocumentoContenido | null> => {
      const { rows } = await this.db.query<{ out_tipo: PortalDocumentoTipo; out_nombre_archivo: string; out_mime_type: string; out_estado: PortalDocumentoEstado; out_contenido: Uint8Array }>(
        "select out_tipo, out_nombre_archivo, out_mime_type, out_estado, out_contenido from despachos.portal_documento_contenido($1, $2);",
        [propertyId, documentoId],
      );
      const r = rows[0];
      if (!r) return null;
      return { tipo: r.out_tipo, nombreArchivo: r.out_nombre_archivo, mimeType: r.out_mime_type, estado: r.out_estado, contenido: new Uint8Array(r.out_contenido) };
    });
  }

  resolverDocumento(propertyId: string, documentoId: string, estado: "aceptado" | "rechazado", motivo: string | null, invoiceId: string | null) {
    return this.ejecutar("sp_portal_doc_resolver", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>("select despachos.portal_documento_resolver($1, $2, $3, $4, $5) as ok;", [propertyId, documentoId, estado, motivo, invoiceId]);
      return rows[0]!.ok === true;
    });
  }

  listarCfdi(tokenHash: string) {
    return this.ejecutar("sp_portal_cfdi_listar", async (): Promise<PortalCfdiListado> => {
      const { rows } = await this.db.query<{ r: { organization_id: string; property_id: string; cfdi: { id: string; folio_fiscal: string; tipo: string; direccion: PortalCfdiVista["direccion"]; fecha: string; rfc_emisor: string; rfc_receptor: string; emisor_nombre: string | null; total_centavos: number | string; estado_sat: string; excluido: boolean }[] } }>(
        "select despachos.portal_cliente_cfdi_listar($1) as r;",
        [tokenHash],
      );
      const r = rows[0]?.r;
      if (!r) throw new PortalEnlaceInvalidoError();
      return {
        organizationId: r.organization_id,
        propertyId: r.property_id,
        cfdi: r.cfdi.map((x) => ({ id: x.id, folioFiscal: x.folio_fiscal, tipo: x.tipo, direccion: x.direccion ?? null, fecha: String(x.fecha).slice(0, 10), rfcEmisor: x.rfc_emisor, rfcReceptor: x.rfc_receptor, emisorNombre: x.emisor_nombre, totalCentavos: Number(x.total_centavos), estadoSat: x.estado_sat, excluido: x.excluido === true })),
      };
    });
  }

  contextoIngesta(documentoId: string, datos: { readonly folioFiscal: string | null; readonly fecha: string | null; readonly rfcEmisor: string | null }) {
    return this.ejecutarSistema("sp_portal_ingesta_contexto", async (): Promise<ContextoIngestaPortal> => {
      const { rows } = await this.db.query<{ c: Record<string, unknown> }>("select despachos.system_portal_ingesta_contexto($1, $2::uuid, $3::date, $4) as c;", [documentoId, datos.folioFiscal, datos.fecha, datos.rfcEmisor]);
      const c = rows[0]!.c as {
        organization_id: string; property_id: string; documento_estado: PortalDocumentoEstado; documento_tipo: PortalDocumentoTipo; autoaceptar: boolean; umbral: number | string; ficha_rfc: string | null;
        existe: boolean; periodo_cerrado: boolean; efos_situacion: string | null; efos_lista_disponible: boolean;
        correcciones: { rfc_emisor: string; clave_prod_serv: string | null; categoria: string; cuenta: string | null }[];
      };
      return {
        organizationId: c.organization_id,
        propertyId: c.property_id,
        documentoEstado: c.documento_estado,
        documentoTipo: c.documento_tipo,
        autoaceptar: c.autoaceptar === true,
        umbral: Number(c.umbral),
        fichaRfc: c.ficha_rfc,
        existe: c.existe === true,
        periodoCerrado: c.periodo_cerrado === true,
        efosSituacion: c.efos_situacion,
        efosListaDisponible: c.efos_lista_disponible === true,
        correcciones: (c.correcciones ?? []).map((x) => ({ rfcEmisor: x.rfc_emisor, claveProdServ: x.clave_prod_serv, categoria: x.categoria, cuenta: x.cuenta })),
      };
    });
  }

  aceptarCfdiSistema(documentoId: string, datos: DatosAceptacionPortal) {
    return this.ejecutarSistema("sp_portal_cfdi_aceptar", async () => {
      const { rows } = await this.db.query<{ out_estado: EstadoAceptacionPortal; out_invoice_id: string | null }>("select * from despachos.system_portal_cfdi_aceptar($1, $2::jsonb, $3::jsonb, $4::jsonb);", [
        documentoId,
        JSON.stringify(datos.invoice),
        JSON.stringify(datos.impuestos),
        datos.clasificacion === null ? null : JSON.stringify(datos.clasificacion),
      ]);
      const r = rows[0]!;
      return { estado: r.out_estado, invoiceId: r.out_invoice_id };
    });
  }

  enviarMensajeStaff(propertyId: string, cuerpo: string) {
    return this.ejecutar("sp_portal_msg_staff", async () => {
      const { rows } = await this.db.query<{ id: string }>("select despachos.portal_mensaje_staff_enviar($1, $2) as id;", [propertyId, cuerpo]);
      return { id: rows[0]!.id };
    });
  }
}
