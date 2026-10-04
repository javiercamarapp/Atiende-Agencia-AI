// D-32 -- doble en memoria de honorarios (pruebas de rutas y del motor). Replica las reglas de la migracion 023 que las pruebas ejercen:
// desglose recalculado, generacion idempotente, reserva compare-and-set con expiracion, cancelacion con guardas y UUID fiscal unico por organizacion.
import { randomUUID } from "node:crypto";
import type { CarteraRepository } from "../cartera/types.ts";
import { calcularDesglose } from "./desglose.ts";
import { puedeTransicionar } from "./estados.ts";
import {
  HonorariosDatosInvalidosError,
  HonorariosDuplicadoError,
  HonorariosEstadoInvalidoError,
  HonorariosNoDisponiblesError,
  HonorariosNoEncontradoError,
  HonorariosTopeExcedidoError,
} from "./repository.ts";
import type { HonorariosRepository, LecturaIgualas, LecturaPrefacturas } from "./repository.ts";
import { MAX_IGUALAS_POR_CLIENTE, MOTIVOS_CANCELACION } from "./types.ts";
import type { CancelacionDatos, Desglose, IgualaInput, IgualaRecord, PrefacturaRecord, TimbreRegistrado } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InMemoryHonorariosRepository implements HonorariosRepository {
  private readonly igualas = new Map<string, IgualaRecord>();
  private readonly prefacturas = new Map<string, PrefacturaRecord>();
  /** Simula la base SIN migrar la 023: lecturas vacias y escrituras `HonorariosNoDisponiblesError`. */
  disponible = true;
  /** Reloj inyectable (ms) para probar la expiracion de la reserva. */
  ahora: () => number = () => Date.now();
  /** Cuantas veces gano la reserva cada prefactura (para probar "solo una llamada al PAC"). */
  readonly reservasGanadas = new Map<string, number>();

  constructor(
    private readonly cartera: Pick<CarteraRepository, "obtenerFicha">,
    private readonly organizationDe: (propertyId: string) => string,
  ) {}

  private requerirDisponible(): void {
    if (!this.disponible) throw new HonorariosNoDisponiblesError();
  }
  private iso(): string {
    return new Date(this.ahora()).toISOString();
  }

  async listarIgualas(propertyId: string): Promise<LecturaIgualas> {
    if (!this.disponible) return { estado: "no_disponible", igualas: [] };
    return { estado: "disponible", igualas: [...this.igualas.values()].filter((i) => i.propertyId === propertyId) };
  }

  async guardarIguala(propertyId: string, id: string | null, input: IgualaInput): Promise<string> {
    this.requerirDisponible();
    calcularDesglose(input); // mismas validaciones de monto, tasa y retenciones que la base
    if (input.concepto.trim().length < 3 || input.concepto.trim().length > 200) throw new HonorariosDatosInvalidosError("datos de la iguala invalidos");
    if (input.diaEmision < 1 || input.diaEmision > 28) throw new HonorariosDatosInvalidosError("datos de la iguala invalidos");
    if (id === null) {
      if ([...this.igualas.values()].filter((i) => i.propertyId === propertyId).length >= MAX_IGUALAS_POR_CLIENTE) throw new HonorariosTopeExcedidoError("tope de 50 igualas por cliente");
      const nueva: IgualaRecord = { ...input, concepto: input.concepto.trim(), id: randomUUID(), propertyId, organizationId: this.organizationDe(propertyId), claveSatEstado: "por_verificar", periodicidad: "mensual", createdAt: this.iso(), updatedAt: this.iso() };
      this.igualas.set(nueva.id, nueva);
      return nueva.id;
    }
    const actual = this.igualas.get(id);
    if (!actual || actual.propertyId !== propertyId) throw new HonorariosNoEncontradoError("la iguala no existe en ese cliente");
    this.igualas.set(id, { ...actual, ...input, concepto: input.concepto.trim(), updatedAt: this.iso() });
    return id;
  }

  async eliminarIguala(propertyId: string, id: string): Promise<void> {
    this.requerirDisponible();
    const i = this.igualas.get(id);
    if (!i || i.propertyId !== propertyId) throw new HonorariosNoEncontradoError("la iguala no existe en ese cliente");
    if ([...this.prefacturas.values()].some((p) => p.igualaId === id)) throw new HonorariosEstadoInvalidoError("la iguala ya tiene prefacturas; desactivala en vez de borrarla");
    this.igualas.delete(id);
  }

  async listarPrefacturas(propertyId: string, periodo: string | null): Promise<LecturaPrefacturas> {
    if (!this.disponible) return { estado: "no_disponible", prefacturas: [] };
    return { estado: "disponible", prefacturas: [...this.prefacturas.values()].filter((p) => p.propertyId === propertyId && (periodo === null || p.periodo === periodo)).sort((a, b) => b.periodo.localeCompare(a.periodo)) };
  }

  async obtenerPrefactura(propertyId: string, id: string): Promise<PrefacturaRecord | null> {
    if (!this.disponible) return null;
    const p = this.prefacturas.get(id);
    return p && p.propertyId === propertyId ? p : null;
  }

  async generarPrefactura(propertyId: string, igualaId: string, periodo: string, d: Desglose): Promise<string | null> {
    this.requerirDisponible();
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw new HonorariosDatosInvalidosError("periodo invalido (AAAA-MM)");
    const ig = this.igualas.get(igualaId);
    if (!ig || ig.propertyId !== propertyId) throw new HonorariosNoEncontradoError("la iguala no existe en ese cliente");
    if (!ig.activa) throw new HonorariosEstadoInvalidoError("la iguala esta inactiva");
    const ficha = await this.cartera.obtenerFicha(propertyId);
    if (!ficha) throw new HonorariosDatosInvalidosError("el cliente no tiene ficha fiscal (RFC, regimen, CP)");
    const esperado = calcularDesglose(ig);
    if (JSON.stringify(esperado) !== JSON.stringify({ baseCentavos: d.baseCentavos, ivaCentavos: d.ivaCentavos, retencionIsrCentavos: d.retencionIsrCentavos, retencionIvaCentavos: d.retencionIvaCentavos, totalCentavos: d.totalCentavos })) {
      throw new HonorariosDatosInvalidosError("el desglose no coincide con la iguala");
    }
    if ([...this.prefacturas.values()].some((p) => p.igualaId === igualaId && p.periodo === periodo)) return null;
    const ahora = this.iso();
    const p: PrefacturaRecord = {
      ...esperado,
      id: randomUUID(),
      propertyId,
      organizationId: ig.organizationId,
      igualaId,
      periodo,
      estado: "borrador",
      concepto: ig.concepto,
      claveProdServ: ig.claveProdServ,
      claveUnidad: ig.claveUnidad,
      receptor: { rfc: ficha.rfc, razonSocial: ficha.razonSocial, regimenFiscal: ficha.regimenesFiscales[0]!, codigoPostal: ficha.cpFiscal },
      usoCfdi: ig.usoCfdi,
      fechaEmision: `${periodo}-${String(ig.diaEmision).padStart(2, "0")}`,
      aprobadaEn: null,
      timbrandoEn: null,
      timbradaEn: null,
      uuid: null,
      pacId: null,
      urlPdf: null,
      urlXml: null,
      errorTimbrado: null,
      canceladaEn: null,
      motivoCancelacion: null,
      folioSustitucion: null,
      createdAt: ahora,
      updatedAt: ahora,
    };
    this.prefacturas.set(p.id, p);
    return p.id;
  }

  private requerir(propertyId: string, id: string): PrefacturaRecord {
    const p = this.prefacturas.get(id);
    if (!p || p.propertyId !== propertyId) throw new HonorariosNoEncontradoError("la prefactura no existe en ese cliente");
    return p;
  }
  private poner(p: PrefacturaRecord, cambios: Partial<PrefacturaRecord>): void {
    this.prefacturas.set(p.id, { ...p, ...cambios, updatedAt: this.iso() });
  }

  async aprobar(propertyId: string, id: string): Promise<void> {
    this.requerirDisponible();
    const p = this.requerir(propertyId, id);
    if (!puedeTransicionar(p.estado, "aprobar")) throw new HonorariosEstadoInvalidoError(`solo se aprueba una prefactura en borrador (estado actual: ${p.estado})`);
    this.poner(p, { estado: "aprobada", aprobadaEn: this.iso() });
  }

  async reservarTimbrado(propertyId: string, id: string, expiraSegundos: number): Promise<boolean> {
    this.requerirDisponible();
    if (expiraSegundos < 300) throw new HonorariosDatosInvalidosError("la reserva expira en 300 segundos o mas");
    const p = this.prefacturas.get(id);
    if (!p || p.propertyId !== propertyId) return false;
    const reservaVieja = p.estado === "timbrando" && p.timbrandoEn !== null && Date.parse(p.timbrandoEn) < this.ahora() - expiraSegundos * 1000;
    if (!puedeTransicionar(p.estado, "reservar_timbrado") && !reservaVieja) return false;
    this.poner(p, { estado: "timbrando", timbrandoEn: this.iso(), errorTimbrado: null });
    this.reservasGanadas.set(id, (this.reservasGanadas.get(id) ?? 0) + 1);
    return true;
  }

  async registrarTimbre(propertyId: string, id: string, t: TimbreRegistrado): Promise<void> {
    this.requerirDisponible();
    if (!UUID_RE.test(t.uuid) || t.pacId.length < 1 || t.pacId.length > 120) throw new HonorariosDatosInvalidosError("UUID fiscal o id del PAC invalidos");
    const p = this.requerir(propertyId, id);
    if (!puedeTransicionar(p.estado, "registrar_timbre")) throw new HonorariosEstadoInvalidoError(`la prefactura no tiene una reserva de timbrado vigente (estado: ${p.estado})`);
    if ([...this.prefacturas.values()].some((x) => x.id !== id && x.organizationId === p.organizationId && x.uuid?.toLowerCase() === t.uuid.toLowerCase())) throw new HonorariosDuplicadoError();
    this.poner(p, { estado: "timbrada", timbrandoEn: null, timbradaEn: this.iso(), uuid: t.uuid.toLowerCase(), pacId: t.pacId, urlPdf: t.urlPdf, urlXml: t.urlXml, errorTimbrado: null });
  }

  async registrarFallo(propertyId: string, id: string, codigo: string): Promise<void> {
    this.requerirDisponible();
    const p = this.requerir(propertyId, id);
    if (!puedeTransicionar(p.estado, "registrar_fallo")) throw new HonorariosEstadoInvalidoError(`la prefactura no tiene una reserva de timbrado vigente (estado: ${p.estado})`);
    this.poner(p, { estado: "fallida", timbrandoEn: null, errorTimbrado: (codigo.trim() || "fallo_desconocido").slice(0, 200) });
  }

  async cancelar(propertyId: string, id: string, d: CancelacionDatos): Promise<void> {
    this.requerirDisponible();
    if (!(MOTIVOS_CANCELACION as readonly string[]).includes(d.motivo)) throw new HonorariosDatosInvalidosError("motivo de cancelacion invalido (01 a 04)");
    if (d.motivo === "01" && (d.folioSustitucion === null || !UUID_RE.test(d.folioSustitucion))) throw new HonorariosDatosInvalidosError("el motivo 01 exige el folio fiscal (UUID) del CFDI que lo sustituye");
    if (d.motivo !== "01" && d.folioSustitucion !== null) throw new HonorariosDatosInvalidosError("solo el motivo 01 lleva folio de sustitucion");
    const p = this.requerir(propertyId, id);
    if (p.estado === "cancelada") throw new HonorariosEstadoInvalidoError("la prefactura ya esta cancelada");
    if (p.estado === "timbrando") throw new HonorariosEstadoInvalidoError("hay un timbrado en curso; espera a que termine");
    if (p.estado === "timbrada" && !d.acusePac) throw new HonorariosEstadoInvalidoError("una prefactura timbrada solo se cancela con acuse del PAC");
    if (d.motivo === "01" && d.folioSustitucion!.toLowerCase() === (p.uuid ?? "").toLowerCase()) throw new HonorariosDatosInvalidosError("el folio de sustitucion no puede ser el del propio CFDI");
    this.poner(p, { estado: "cancelada", canceladaEn: this.iso(), motivoCancelacion: d.motivo, folioSustitucion: d.folioSustitucion?.toLowerCase() ?? null });
  }
}
