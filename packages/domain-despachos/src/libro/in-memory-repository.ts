// D-24 -- doble en memoria del libro contable (pruebas de rutas y del dominio). Replica las reglas de la migración 020 que las
// pruebas ejercen: cuadre, cuentas del catálogo, folio por (cliente, mes, tipo), periodo cerrado, una póliza vigente por CFDI,
// reversa única, balanza derivada con saldo inicial de cuentas de balance entre ejercicios.
import { randomUUID } from "node:crypto";
import { naturalezaPorDefecto } from "./catalogo-base.ts";
import {
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroNoEncontradoError,
  PeriodoLibroCerradoError,
  PolizaDuplicadaError,
} from "./types.ts";
import type {
  CuentaLibro,
  FiltroPolizas,
  LecturaLibro,
  LibroRepository,
  LineaBalanzaLibro,
  PolizaConMovimientos,
  PolizaInput,
  PolizaRecord,
  RegistroPolizaResultado,
} from "./types.ts";

export class InMemoryLibroRepository implements LibroRepository {
  private readonly cuentas = new Map<string, Map<string, CuentaLibro>>();
  private readonly polizas = new Map<string, PolizaConMovimientos[]>();
  /** Periodos cerrados "propertyId|YYYY-MM". */
  readonly periodosCerrados = new Set<string>();
  /** Simula la base SIN migrar. */
  disponible = true;

  private catalogo(propertyId: string): Map<string, CuentaLibro> {
    let c = this.cuentas.get(propertyId);
    if (!c) this.cuentas.set(propertyId, (c = new Map()));
    return c;
  }
  private lista(propertyId: string): PolizaConMovimientos[] {
    let l = this.polizas.get(propertyId);
    if (!l) this.polizas.set(propertyId, (l = []));
    return l;
  }
  private exigirDisponible(): void {
    if (!this.disponible) throw new LibroNoDisponibleError();
  }
  private lectura<T>(vacio: T, datos: () => T): Promise<LecturaLibro<T>> {
    return Promise.resolve(this.disponible ? { estado: "disponible", datos: datos() } : { estado: "no_disponible", datos: vacio });
  }

  listarCuentas(propertyId: string): Promise<LecturaLibro<readonly CuentaLibro[]>> {
    return this.lectura<readonly CuentaLibro[]>([], () => [...this.catalogo(propertyId).values()].sort((a, b) => a.codigo.localeCompare(b.codigo)));
  }

  async sembrarCatalogo(propertyId: string, cuentas: readonly CuentaLibro[]): Promise<number> {
    this.exigirDisponible();
    const c = this.catalogo(propertyId);
    let nuevas = 0;
    for (const x of cuentas) {
      if (!c.has(x.codigo)) {
        c.set(x.codigo, x);
        nuevas += 1;
      }
    }
    return nuevas;
  }

  async guardarCuenta(propertyId: string, cuenta: CuentaLibro): Promise<void> {
    this.exigirDisponible();
    const c = this.catalogo(propertyId);
    const actual = c.get(cuenta.codigo);
    if (actual && actual.naturaleza !== cuenta.naturaleza && this.lista(propertyId).some((p) => p.movimientos.some((m) => m.cuenta === cuenta.codigo))) {
      throw new LibroDatosInvalidosError("una cuenta con partidas no cambia de naturaleza");
    }
    c.set(cuenta.codigo, cuenta);
  }

  private insertar(propertyId: string, p: PolizaInput, origen: "manual" | "cfdi" | "reversa", invoiceId: string | null, reversaDe: string | null): RegistroPolizaResultado {
    const catalogo = this.catalogo(propertyId);
    if (p.movimientos.length < 2) throw new LibroDatosInvalidosError("una póliza lleva de 2 a 200 partidas");
    const debe = p.movimientos.reduce((s, m) => s + m.debeCentavos, 0);
    const haber = p.movimientos.reduce((s, m) => s + m.haberCentavos, 0);
    if (debe !== haber) throw new LibroDatosInvalidosError(`póliza descuadrada (debe ${debe} y haber ${haber} centavos)`);
    if (p.movimientos.some((m) => !catalogo.has(m.cuenta))) throw new LibroDatosInvalidosError("hay cuentas que no existen en el catálogo del cliente");
    const [ejercicio, mes] = [Number(p.fecha.slice(0, 4)), Number(p.fecha.slice(5, 7))];
    if (this.periodosCerrados.has(`${propertyId}|${p.fecha.slice(0, 7)}`)) throw new PeriodoLibroCerradoError(`el periodo ${p.fecha.slice(0, 7)} está cerrado`);
    const lista = this.lista(propertyId);
    const folio = lista.filter((x) => x.ejercicio === ejercicio && x.mes === mes && x.tipo === p.tipo).reduce((m, x) => Math.max(m, x.folio), 0) + 1;
    const id = randomUUID();
    lista.push({
      id,
      propertyId,
      ejercicio,
      mes,
      tipo: p.tipo,
      folio,
      fecha: p.fecha,
      concepto: p.concepto,
      origen,
      invoiceId,
      reversaDe,
      reversada: false,
      totalCentavos: debe,
      createdAt: new Date().toISOString(),
      movimientos: p.movimientos.map((m, i) => ({ ...m, linea: i + 1 })),
    });
    return { polizaId: id, folio };
  }

  async registrarPoliza(propertyId: string, poliza: PolizaInput, invoiceId: string | null = null): Promise<RegistroPolizaResultado> {
    this.exigirDisponible();
    if (invoiceId && this.lista(propertyId).some((x) => x.invoiceId === invoiceId && !x.reversada)) throw new PolizaDuplicadaError();
    return this.insertar(propertyId, poliza, invoiceId ? "cfdi" : "manual", invoiceId, null);
  }

  async reversarPoliza(propertyId: string, polizaId: string, fecha: string, concepto: string): Promise<RegistroPolizaResultado> {
    this.exigirDisponible();
    const lista = this.lista(propertyId);
    const idx = lista.findIndex((x) => x.id === polizaId);
    if (idx < 0) throw new LibroNoEncontradoError();
    const orig = lista[idx]!;
    if (orig.origen === "reversa") throw new LibroDatosInvalidosError("una póliza de reversa no se revierte; registra una póliza nueva");
    if (orig.reversada) throw new LibroDatosInvalidosError("la póliza ya fue revertida");
    const r = this.insertar(propertyId, { tipo: "diario", fecha, concepto, movimientos: orig.movimientos.map((m) => ({ cuenta: m.cuenta, concepto: m.concepto, debeCentavos: m.haberCentavos, haberCentavos: m.debeCentavos })) }, "reversa", null, polizaId);
    lista[idx] = { ...orig, reversada: true };
    return r;
  }

  listarPolizas(propertyId: string, f: FiltroPolizas): Promise<LecturaLibro<readonly PolizaRecord[]>> {
    return this.lectura<readonly PolizaRecord[]>([], () =>
      this.lista(propertyId)
        .filter((p) => p.ejercicio === f.ejercicio && (f.mes === undefined || p.mes === f.mes))
        .sort((a, b) => b.fecha.localeCompare(a.fecha) || a.tipo.localeCompare(b.tipo) || b.folio - a.folio)
        .slice(f.offset, f.offset + f.limit)
        .map(({ movimientos: _m, ...cab }) => cab),
    );
  }

  async obtenerPoliza(propertyId: string, polizaId: string): Promise<PolizaConMovimientos | null> {
    if (!this.disponible) return null;
    return this.lista(propertyId).find((p) => p.id === polizaId) ?? null;
  }

  async polizasDeCfdi(propertyId: string, invoiceIds: readonly string[]): Promise<ReadonlyMap<string, PolizaRecord>> {
    const out = new Map<string, PolizaRecord>();
    if (!this.disponible) return out;
    for (const p of this.lista(propertyId)) {
      if (p.invoiceId && !p.reversada && invoiceIds.includes(p.invoiceId)) {
        const { movimientos: _m, ...cab } = p;
        out.set(p.invoiceId, cab);
      }
    }
    return out;
  }

  balanza(propertyId: string, ejercicio: number, mes: number): Promise<LecturaLibro<readonly LineaBalanzaLibro[]>> {
    return this.lectura<readonly LineaBalanzaLibro[]>([], () => {
      const catalogo = this.catalogo(propertyId);
      const acc = new Map<string, { debe: number; haber: number; debeIni: number; haberIni: number }>();
      for (const p of this.lista(propertyId)) {
        const hastaAqui = p.ejercicio < ejercicio || (p.ejercicio === ejercicio && p.mes <= mes);
        if (!hastaAqui) continue;
        for (const m of p.movimientos) {
          const a = acc.get(m.cuenta) ?? { debe: 0, haber: 0, debeIni: 0, haberIni: 0 };
          if (p.ejercicio === ejercicio && p.mes === mes) {
            a.debe += m.debeCentavos;
            a.haber += m.haberCentavos;
          } else if ((p.ejercicio === ejercicio && p.mes < mes) || (p.ejercicio < ejercicio && "123".includes(m.cuenta.charAt(0)))) {
            a.debeIni += m.debeCentavos;
            a.haberIni += m.haberCentavos;
          }
          acc.set(m.cuenta, a);
        }
      }
      return [...acc.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, a]) => a.debe || a.haber || a.debeIni || a.haberIni)
        .map(([cuenta, a]) => {
          const c = catalogo.get(cuenta) ?? { codigo: cuenta, descripcion: cuenta, naturaleza: naturalezaPorDefecto(cuenta) };
          const ini = c.naturaleza === "D" ? a.debeIni - a.haberIni : a.haberIni - a.debeIni;
          const mov = c.naturaleza === "D" ? a.debe - a.haber : a.haber - a.debe;
          return { cuenta, descripcion: c.descripcion, naturaleza: c.naturaleza, saldoInicialCentavos: ini, debeCentavos: a.debe, haberCentavos: a.haber, saldoFinalCentavos: ini + mov };
        });
    });
  }
}
