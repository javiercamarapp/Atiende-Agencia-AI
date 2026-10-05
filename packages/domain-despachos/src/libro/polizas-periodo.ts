// D-P3-14 -- pólizas del periodo en piloto automático. El cron diario (y el botón «Generar pólizas del periodo» del libro) arman la póliza de cada CFDI
// que ya se puede contabilizar sin inventar nada: clasificado con confianza suficiente (o corregido por una persona), sin revisión pendiente, no
// cancelado ni excluido, con sentido emitido/recibido, de un periodo no cerrado y sin póliza vigente. La póliza sale de `construirPolizaDesdeCfdi`
// (la MISMA que el botón por CFDI) con la clasificación vigente; aquí viven los tipos del puerto de sistema y el doble en memoria.
import { randomUUID } from "node:crypto";
import { construirCatalogoBase } from "./catalogo-base.ts";
import { construirPolizaDesdeCfdi } from "./poliza.ts";
import { LibroNoEncontradoError, PeriodoLibroCerradoError, PolizaDuplicadaError } from "./types.ts";
import type { CuentaLibro, LibroRepository, PolizaInput } from "./types.ts";
import type { InvoiceRecord } from "../types.ts";
import type { DespachosRepository } from "../repository.ts";
import type { ClasificacionRepository } from "../clasificacion/types.ts";
import { evaluarCompuertaClasificacion } from "../bookkeeping/clasificacion-cfdi.ts";
import { estaPeriodoCerrado } from "../cierre-mensual/engine.ts";

/** Un CFDI candidato tal como lo devuelve la función de sistema (solo lo necesario para armar la póliza; sin nombres ni RFC de terceros). */
export interface CandidatoPolizaSistema {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly invoiceId: string;
  readonly folioFiscal: string;
  readonly tipo: string;
  readonly direccion: "emitido" | "recibido";
  /** YYYY-MM-DD. */
  readonly fecha: string;
  readonly moneda: string | null;
  readonly estadoSat: string;
  readonly subtotalCentavos: number | null;
  readonly descuentoCentavos: number | null;
  readonly totalCentavos: number | null;
  readonly ivaTrasladadoCentavos: number | null;
  readonly isrRetenidoCentavos: number | null;
  readonly ivaRetenidoCentavos: number | null;
  readonly iepsCentavos: number | null;
  /** Categoría de la última clasificación del CFDI y, si la corrección trae una, la cuenta de cargo. */
  readonly categoria: string;
  readonly cuenta: string | null;
}

export type EstadoRegistroSistema = "creada" | "ya_tenia_poliza" | "periodo_cerrado" | "cancelado" | "excluido" | "revision_pendiente" | "sin_catalogo";

export interface RegistroPolizaSistema {
  readonly estado: EstadoRegistroSistema;
  readonly polizaId: string | null;
  readonly folio: number | null;
}

export class PolizasPeriodoNoDisponibleError extends Error {
  constructor() {
    super("Las pólizas del periodo todavía no están disponibles en esta base (falta aplicar la migración 026).");
    this.name = "PolizasPeriodoNoDisponibleError";
  }
}

/** Puerto de SOLO SISTEMA del cron (sesión sin sub). */
export interface PolizasPeriodoRepository {
  /** Candidatos entre `desde` y `hasta` (YYYY-MM-DD, ventana <= 400 días), los más antiguos primero, tope duro de 500. `null` = la base no tiene la migración 026. */
  listarCandidatos(desde: string, hasta: string, limite: number): Promise<readonly CandidatoPolizaSistema[] | null>;
  /** Registra la póliza de UN CFDI (ya armada, en centavos). Si el cliente no tiene catálogo siembra `catalogo`. Idempotente: lo esperable vuelve como estado. */
  registrarPolizaSistema(propertyId: string, invoiceId: string, poliza: PolizaInput, catalogo: readonly CuentaLibro[]): Promise<RegistroPolizaSistema>;
}

/** Reconstruye el `InvoiceRecord` mínimo que necesita `construirPolizaDesdeCfdi` a partir de un candidato. */
export function invoiceDesdeCandidato(c: CandidatoPolizaSistema): InvoiceRecord {
  return {
    id: c.invoiceId,
    organizationId: c.organizationId,
    propertyId: c.propertyId,
    folioFiscal: c.folioFiscal,
    tipo: c.tipo as InvoiceRecord["tipo"],
    rfcEmisor: "",
    rfcReceptor: "",
    emisorNombre: null,
    subtotal: 0,
    total: 0,
    iva: null,
    descuento: 0,
    categoria: "sin_clasificar",
    confianza: null,
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: { proveedoresReportables: [], reportable: false },
    fecha: c.fecha,
    createdAt: c.fecha,
    direccion: c.direccion,
    moneda: c.moneda,
    estadoSat: c.estadoSat as InvoiceRecord["estadoSat"],
    subtotalCentavos: c.subtotalCentavos,
    descuentoCentavos: c.descuentoCentavos,
    totalCentavos: c.totalCentavos,
    ivaTrasladadoCentavos: c.ivaTrasladadoCentavos,
    isrRetenidoCentavos: c.isrRetenidoCentavos,
    ivaRetenidoCentavos: c.ivaRetenidoCentavos,
    iepsCentavos: c.iepsCentavos,
  };
}

export type DecisionPoliza = { readonly ok: true; readonly poliza: PolizaInput } | { readonly ok: false; readonly motivo: string };

/** Arma la póliza de un candidato con su clasificación vigente; si no se puede armar sin inventar, devuelve el motivo (el CFDI queda para el staff). */
export function decidirPolizaDeCandidato(c: CandidatoPolizaSistema): DecisionPoliza {
  const r = construirPolizaDesdeCfdi(invoiceDesdeCandidato(c), { categoria: c.categoria, cuenta: c.cuenta });
  return r.ok ? { ok: true, poliza: r.poliza } : { ok: false, motivo: r.motivo };
}

/** Catálogo base que se siembra si el cliente aún no tiene libro (el mismo del botón «Sembrar catálogo»). */
export function catalogoBaseParaSistema(): readonly CuentaLibro[] {
  return construirCatalogoBase();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Doble en memoria (pruebas del cron y de la ruta): mismas reglas que las funciones SQL de la migración 026.
// ---------------------------------------------------------------------------------------------------------------------------------
export interface FuentesPolizasPeriodoEnMemoria {
  readonly propiedades: () => readonly { readonly organizationId: string; readonly propertyId: string }[];
  readonly invoices: (propertyId: string) => Promise<readonly InvoiceRecord[]>;
  readonly revisionPendiente: (propertyId: string, invoiceId: string) => Promise<boolean>;
  readonly polizaVigente: (propertyId: string, invoiceId: string) => Promise<boolean>;
  readonly periodoCerrado: (propertyId: string, anio: number, mes: number) => Promise<boolean>;
  /** Última clasificación y su compuerta ya resuelta (confianza suficiente o hecha por una persona). */
  readonly clasificacionVigente: (propertyId: string, invoiceId: string) => Promise<{ readonly categoria: string; readonly cuenta: string | null; readonly pasaCompuerta: boolean } | null>;
  readonly registrar: (propertyId: string, invoiceId: string, poliza: PolizaInput, catalogo: readonly CuentaLibro[]) => Promise<RegistroPolizaSistema>;
}

export class InMemoryPolizasPeriodoRepository implements PolizasPeriodoRepository {
  /** false = base sin migrar. */
  disponible = true;
  readonly registros: { propertyId: string; invoiceId: string; poliza: PolizaInput; estado: EstadoRegistroSistema }[] = [];
  /** Hace que el registro de estos CFDI falle (pruebas de aislamiento por unidad). */
  readonly fallarEn = new Set<string>();

  constructor(private readonly fuentes: FuentesPolizasPeriodoEnMemoria) {}

  async listarCandidatos(desde: string, hasta: string, limite: number): Promise<readonly CandidatoPolizaSistema[] | null> {
    if (!this.disponible) return null;
    const out: CandidatoPolizaSistema[] = [];
    for (const p of this.fuentes.propiedades()) {
      for (const i of await this.fuentes.invoices(p.propertyId)) {
        if (i.tipo !== "I" || (i.direccion !== "emitido" && i.direccion !== "recibido") || i.estadoSat === "cancelado" || i.excluidoPorRevision === true) continue;
        if (i.fecha < desde || i.fecha > hasta) continue;
        if (await this.fuentes.revisionPendiente(p.propertyId, i.id)) continue;
        if (await this.fuentes.polizaVigente(p.propertyId, i.id)) continue;
        if (await this.fuentes.periodoCerrado(p.propertyId, Number(i.fecha.slice(0, 4)), Number(i.fecha.slice(5, 7)))) continue;
        const cls = await this.fuentes.clasificacionVigente(p.propertyId, i.id);
        if (!cls || !cls.pasaCompuerta) continue;
        out.push({
          organizationId: p.organizationId, propertyId: p.propertyId, invoiceId: i.id, folioFiscal: i.folioFiscal, tipo: i.tipo, direccion: i.direccion, fecha: i.fecha, moneda: i.moneda ?? null, estadoSat: i.estadoSat ?? "pendiente",
          subtotalCentavos: i.subtotalCentavos ?? null, descuentoCentavos: i.descuentoCentavos ?? null, totalCentavos: i.totalCentavos ?? null, ivaTrasladadoCentavos: i.ivaTrasladadoCentavos ?? null,
          isrRetenidoCentavos: i.isrRetenidoCentavos ?? null, ivaRetenidoCentavos: i.ivaRetenidoCentavos ?? null, iepsCentavos: i.iepsCentavos ?? null, categoria: cls.categoria, cuenta: cls.cuenta,
        });
      }
    }
    return out.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0)).slice(0, Math.min(limite, 500));
  }

  async registrarPolizaSistema(propertyId: string, invoiceId: string, poliza: PolizaInput, catalogo: readonly CuentaLibro[]): Promise<RegistroPolizaSistema> {
    if (!this.disponible) throw new PolizasPeriodoNoDisponibleError();
    if (this.fallarEn.has(invoiceId)) throw new Error("fallo simulado");
    const r = await this.fuentes.registrar(propertyId, invoiceId, poliza, catalogo);
    this.registros.push({ propertyId, invoiceId, poliza, estado: r.estado });
    return r;
  }
}

/** Arma el doble sobre los repositorios en memoria del dominio (los mismos que usan las pruebas de API): las reglas de candidato de la migración 026. */
export function polizasPeriodoDesdeRepositorios(r: {
  readonly propiedades: () => readonly { readonly organizationId: string; readonly propertyId: string }[];
  readonly despachos: DespachosRepository;
  readonly libro: LibroRepository;
  readonly clasificacion: ClasificacionRepository;
}): InMemoryPolizasPeriodoRepository {
  return new InMemoryPolizasPeriodoRepository({
    propiedades: r.propiedades,
    invoices: (propertyId) => r.despachos.listInvoices(propertyId),
    revisionPendiente: async (propertyId, invoiceId) => (await r.despachos.listPendingReviews(propertyId)).some((x) => x.invoiceId === invoiceId),
    polizaVigente: async (propertyId, invoiceId) => (await r.libro.polizasDeCfdi(propertyId, [invoiceId])).has(invoiceId),
    periodoCerrado: async (propertyId, anio, mes) => estaPeriodoCerrado(await r.despachos.findPeriodoCierrePorAnioMes(propertyId, anio, mes)),
    clasificacionVigente: async (propertyId, invoiceId) => {
      const c = (await r.clasificacion.vigentes(propertyId, [invoiceId])).datos.get(invoiceId);
      if (!c) return null;
      const config = await r.clasificacion.leerConfig(propertyId);
      const porPersona = c.metodo === "manual" || c.metodo === "correccion";
      return { categoria: c.categoria, cuenta: c.cuenta, pasaCompuerta: porPersona || (!c.empate && !evaluarCompuertaClasificacion(c.confianza ?? 0, { umbral: config.umbral }).requiereRevision) };
    },
    registrar: async (propertyId, invoiceId, poliza, catalogo) => {
      if ((await r.libro.listarCuentas(propertyId)).datos.length === 0) await r.libro.sembrarCatalogo(propertyId, catalogo);
      try {
        const reg = await r.libro.registrarPoliza(propertyId, poliza, invoiceId);
        return { estado: "creada", polizaId: reg.polizaId, folio: reg.folio };
      } catch (err) {
        if (err instanceof PeriodoLibroCerradoError) return { estado: "periodo_cerrado", polizaId: null, folio: null };
        if (err instanceof PolizaDuplicadaError) return { estado: "ya_tenia_poliza", polizaId: null, folio: null };
        if (err instanceof LibroNoEncontradoError) return { estado: "cancelado", polizaId: null, folio: null };
        throw err;
      }
    },
  });
}

export function registroCreadoDoble(): RegistroPolizaSistema {
  return { estado: "creada", polizaId: randomUUID(), folio: 1 };
}
