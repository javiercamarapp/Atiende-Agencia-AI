// Doble en memoria de las funciones de sistema del autoaceptado del portal (migración 026): `system_portal_ingesta_contexto` y `system_portal_cfdi_aceptar`,
// y del listado de CFDI del cliente. Se arma sobre los repositorios en memoria del dominio (los mismos que usan las pruebas de API); la verdad de seguridad sigue siendo
// SQL (scripts/verify-despachos-ingesta-libro).
import { clasificarDireccionCfdi } from "../cfdi/modelo-cfdi.ts";
import type { ImpuestoCfdiInput } from "../cfdi/modelo-cfdi.ts";
import type { CarteraRepository } from "../cartera/types.ts";
import type { ClasificacionRepository } from "../clasificacion/types.ts";
import { estaPeriodoCerrado } from "../cierre-mensual/engine.ts";
import type { DespachosRepository } from "../repository.ts";
import type { TipoComprobante } from "../types.ts";
import type { IngestaPortalEnMemoria } from "./in-memory-repository.ts";
import type { PortalCfdiVista } from "./types.ts";

export interface EfosPortalEnMemoria {
  /** false = nunca se ingirió una lista 69-B. */
  readonly listaDisponible: boolean;
  /** Situación por RFC en la lista vigente (los que no figuran, ausentes). */
  readonly situacionPorRfc: ReadonlyMap<string, string>;
}

export function ingestaPortalDesdeRepositorios(r: {
  /** Organización de cada property (en la base sale del documento). */
  readonly organizationIdDe: (propertyId: string) => string;
  readonly despachos: DespachosRepository;
  readonly clasificacion: ClasificacionRepository;
  readonly cartera: CarteraRepository;
  readonly efos?: () => EfosPortalEnMemoria;
}): IngestaPortalEnMemoria {
  const organizationIdDe = r.organizationIdDe;
  const efos = (): EfosPortalEnMemoria => r.efos?.() ?? { listaDisponible: true, situacionPorRfc: new Map() };
  return {
    cfdi: async (propertyId): Promise<readonly PortalCfdiVista[]> =>
      (await r.despachos.listInvoices(propertyId, { incluirExcluidos: true })).map((i) => ({
        id: i.id, folioFiscal: i.folioFiscal, tipo: i.tipo, direccion: i.direccion ?? null, fecha: i.fecha, rfcEmisor: i.rfcEmisor, rfcReceptor: i.rfcReceptor, emisorNombre: i.emisorNombre,
        totalCentavos: i.totalCentavos ?? Math.round(i.total * 100), estadoSat: i.estadoSat ?? "pendiente", excluido: i.excluidoPorRevision === true,
      })),
    contexto: async (propertyId, datos) => {
      const config = await r.clasificacion.leerConfig(propertyId);
      const ficha = await r.cartera.obtenerFicha(propertyId);
      const rfc = (datos.rfcEmisor ?? "").trim().toUpperCase();
      const lista = efos();
      const correcciones = (await r.clasificacion.listarCorrecciones(propertyId)).datos.filter((c) => c.rfcEmisor === rfc);
      let periodoCerrado = false;
      if (datos.fecha) {
        const [anio, mes] = datos.fecha.split("-").map(Number) as [number, number];
        periodoCerrado = estaPeriodoCerrado(await r.despachos.findPeriodoCierrePorAnioMes(propertyId, anio, mes));
      }
      return {
        autoaceptar: config.portalAutoaceptar,
        umbral: config.umbral,
        fichaRfc: ficha?.rfc ?? null,
        existe: datos.folioFiscal ? (await r.despachos.findInvoiceByFolioFiscal(propertyId, datos.folioFiscal)) !== null : false,
        periodoCerrado,
        efosSituacion: lista.situacionPorRfc.get(rfc) ?? null,
        efosListaDisponible: lista.listaDisponible,
        correcciones: correcciones.map((c) => ({ rfcEmisor: c.rfcEmisor, claveProdServ: c.claveProdServ, categoria: c.categoria, cuenta: c.cuenta })),
      };
    },
    aceptar: async (propertyId, datos) => {
      const i = datos.invoice as Record<string, never>;
      const existente = await r.despachos.findInvoiceByFolioFiscal(propertyId, String(i.folio_fiscal));
      if (existente) return { estado: "ya_existia", invoiceId: existente.id };
      const fecha = String(i.fecha);
      const [anio, mes] = fecha.split("-").map(Number) as [number, number];
      if (estaPeriodoCerrado(await r.despachos.findPeriodoCierrePorAnioMes(propertyId, anio, mes))) return { estado: "periodo_cerrado", invoiceId: null };
      const ficha = await r.cartera.obtenerFicha(propertyId);
      const creada = await r.despachos.insertInvoice({
        organizationId: organizationIdDe(propertyId),
        propertyId,
        folioFiscal: String(i.folio_fiscal),
        tipo: String(i.tipo) as TipoComprobante,
        rfcEmisor: String(i.rfc_emisor),
        rfcReceptor: String(i.rfc_receptor),
        emisorNombre: (i.emisor_nombre as unknown as string | null) ?? null,
        subtotal: Number(i.subtotal),
        total: Number(i.total),
        iva: i.iva === null || i.iva === undefined ? null : Number(i.iva),
        descuento: Number(i.descuento ?? 0),
        categoria: "sin_clasificar",
        fecha,
        valido: Boolean(i.valido),
        issues: [],
        warnings: [],
        requiresHumanReview: Boolean(i.requires_human_review),
        diot: i.diot as never,
        direccion: clasificarDireccionCfdi(ficha?.rfc ?? null, String(i.rfc_emisor), String(i.rfc_receptor)),
        metodoPago: (i.metodo_pago as unknown as string | null) ?? null,
        formaPago: (i.forma_pago as unknown as string | null) ?? null,
        usoCfdi: (i.uso_cfdi as unknown as string | null) ?? null,
        moneda: (i.moneda as unknown as string | null) ?? null,
        tipoCambio: i.tipo_cambio === null || i.tipo_cambio === undefined ? null : Number(i.tipo_cambio),
        subtotalCentavos: i.subtotal_centavos === undefined ? null : Number(i.subtotal_centavos),
        descuentoCentavos: i.descuento_centavos === undefined ? null : Number(i.descuento_centavos),
        totalCentavos: i.total_centavos === undefined ? null : Number(i.total_centavos),
        ivaTrasladadoCentavos: i.iva_trasladado_centavos === undefined || i.iva_trasladado_centavos === null ? null : Number(i.iva_trasladado_centavos),
        isrRetenidoCentavos: i.isr_retenido_centavos === undefined || i.isr_retenido_centavos === null ? null : Number(i.isr_retenido_centavos),
        ivaRetenidoCentavos: i.iva_retenido_centavos === undefined || i.iva_retenido_centavos === null ? null : Number(i.iva_retenido_centavos),
        iepsCentavos: i.ieps_centavos === undefined || i.ieps_centavos === null ? null : Number(i.ieps_centavos),
        impuestos: datos.impuestos.map((x) => {
          const t = x as Record<string, unknown>;
          return { naturaleza: t.naturaleza, impuesto: t.impuesto, tipoFactor: t.tipo_factor, tasaOCuota: t.tasa_o_cuota ?? null, baseCentavos: t.base_centavos ?? null, importeCentavos: t.importe_centavos ?? null } as unknown as ImpuestoCfdiInput;
        }),
      });
      if (datos.clasificacion) await r.clasificacion.registrar(propertyId, creada.id, { categoria: datos.clasificacion.categoria, confianza: datos.clasificacion.confianza, metodo: datos.clasificacion.method as "reglas", razon: datos.clasificacion.razon, cuenta: datos.clasificacion.cuenta, empate: datos.clasificacion.empate });
      return { estado: "aceptado", invoiceId: creada.id };
    },
  };
}
