// D-25 -- doble en memoria de pagos provisionales (pruebas de rutas). Replica las reglas de la migración 020 que las pruebas
// ejercen: pago idempotente, solo PPD/MXN, sin sobrepago, papel guardable hasta presentarse.
import {
  PagosDatosInvalidosError,
  PagosNoDisponiblesError,
  PagosNoEncontradoError,
  PapelYaPresentadoError,
} from "./repository.ts";
import type { BasePapel, LecturaPapeles, PagoRepNuevo, PagosProvisionalesRepository, PapelAGuardar, PapelGuardado } from "./repository.ts";
import type { FacturaProvisional, ImpuestoProvisional, PagoRepProvisional } from "./types.ts";

export class InMemoryPagosProvisionalesRepository implements PagosProvisionalesRepository {
  private facturas: FacturaProvisional[] = [];
  private readonly pagos: (PagoRepNuevo & { propertyId: string })[] = [];
  private readonly papeles = new Map<string, PapelGuardado>();
  /** Simula la base SIN migrar la 020 (la 018 sigue presente). */
  disponible = true;
  /** Simula la base SIN migrar la 018 (sin modelo CFDI completo). */
  facturasDisponibles = true;
  /** Marcas de tiempo/ids deterministas para las pruebas. */
  private n = 0;

  sembrarFacturas(...fs: FacturaProvisional[]): void {
    this.facturas.push(...fs);
  }

  private clave(propertyId: string, ejercicio: number, mes: number, impuesto: string): string {
    return `${propertyId}|${ejercicio}|${mes}|${impuesto}`;
  }

  async leerBase(_propertyId: string, ejercicio: number, mes: number): Promise<BasePapel> {
    const hasta = `${ejercicio}-${String(mes).padStart(2, "0")}-31`;
    const desde = `${ejercicio}-01-01`;
    const pagos: PagoRepProvisional[] = this.disponible
      ? this.pagos.filter((p) => p.fechaPago >= desde && p.fechaPago <= hasta).map((p) => ({ invoiceId: p.invoiceId, fechaPago: p.fechaPago, flujo: p.flujo, importePagadoCentavos: p.importePagadoCentavos, baseCentavos: p.baseCentavos, ivaCentavos: p.ivaCentavos, ivaRetenidoCentavos: p.ivaRetenidoCentavos }))
      : [];
    const ids = new Set(pagos.map((p) => p.invoiceId));
    const facturas = this.facturasDisponibles ? this.facturas.filter((f) => (f.fecha >= desde && f.fecha <= hasta) || ids.has(f.id)) : [];
    return { facturas, pagos, facturasDisponibles: this.facturasDisponibles, pagosDisponibles: this.disponible, truncado: false };
  }

  async registrarPago(propertyId: string, p: PagoRepNuevo): Promise<boolean> {
    if (!this.disponible) throw new PagosNoDisponiblesError();
    const f = this.facturas.find((x) => x.id === p.invoiceId);
    if (!f) throw new PagosNoEncontradoError("CFDI no encontrado");
    if (f.metodoPago !== "PPD") throw new PagosDatosInvalidosError("solo un CFDI con método de pago PPD se paga con complemento");
    if ((f.moneda ?? "MXN") !== "MXN") throw new PagosDatosInvalidosError("solo se registran pagos de CFDI en pesos mexicanos");
    if (f.estadoSat === "cancelado" || f.estadoSat === "no_encontrado") throw new PagosDatosInvalidosError("el CFDI está cancelado o no existe ante el SAT");
    if ((p.flujo === "trasladado") !== (f.direccion === "emitido")) throw new PagosDatosInvalidosError("el flujo no corresponde al sentido del CFDI (emitido/recibido)");
    const existente = this.pagos.find((x) => x.propertyId === propertyId && x.folioFiscalRep === p.folioFiscalRep && x.pagoIndex === p.pagoIndex && x.invoiceId === p.invoiceId);
    if (existente) return false;
    const pagado = this.pagos.filter((x) => x.invoiceId === p.invoiceId).reduce((s, x) => s + x.importePagadoCentavos, 0);
    if (pagado + p.importePagadoCentavos > (f.totalCentavos ?? 0)) throw new PagosDatosInvalidosError("los pagos suman más que el total del CFDI");
    this.pagos.push({ ...p, propertyId });
    return true;
  }

  async listarPapeles(propertyId: string, ejercicio: number): Promise<LecturaPapeles> {
    if (!this.disponible) return { estado: "no_disponible", papeles: [] };
    return { estado: "disponible", papeles: [...this.papeles.entries()].filter(([k]) => k.startsWith(`${propertyId}|${ejercicio}|`)).map(([, v]) => v).sort((a, b) => a.mes - b.mes || a.impuesto.localeCompare(b.impuesto)) };
  }

  async guardarPapel(propertyId: string, p: PapelAGuardar): Promise<void> {
    if (!this.disponible) throw new PagosNoDisponiblesError();
    if (p.aCargoCentavos > 0 && p.aFavorCentavos > 0) throw new PagosDatosInvalidosError("datos del papel de trabajo inválidos");
    const k = this.clave(propertyId, p.ejercicio, p.mes, p.impuesto);
    const previo = this.papeles.get(k);
    if (previo?.estado === "presentado") throw new PapelYaPresentadoError("el pago provisional ya fue presentado; no se recalcula");
    this.n += 1;
    this.papeles.set(k, { ...p, id: previo?.id ?? `papel-${this.n}`, estado: "borrador", montoPagadoCentavos: null, fechaPresentacion: null, updatedAt: new Date().toISOString() });
  }

  async presentarPapel(propertyId: string, ejercicio: number, mes: number, impuesto: ImpuestoProvisional, montoPagadoCentavos: number, fechaPresentacion: string): Promise<void> {
    if (!this.disponible) throw new PagosNoDisponiblesError();
    const k = this.clave(propertyId, ejercicio, mes, impuesto);
    const previo = this.papeles.get(k);
    if (!previo) throw new PagosNoEncontradoError("no hay papel de trabajo guardado para ese periodo");
    if (previo.estado === "presentado") throw new PapelYaPresentadoError("el pago provisional ya fue presentado");
    if (montoPagadoCentavos < 0) throw new PagosDatosInvalidosError("monto y fecha de presentación inválidos");
    this.papeles.set(k, { ...previo, estado: "presentado", montoPagadoCentavos, fechaPresentacion, updatedAt: new Date().toISOString() });
  }
}
