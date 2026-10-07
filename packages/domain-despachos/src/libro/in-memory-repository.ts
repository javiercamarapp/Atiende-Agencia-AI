// D-24 -- doble en memoria del libro contable (pruebas de rutas y del dominio). Replica las reglas de la migración 020 que las
// pruebas ejercen: cuadre, cuentas del catálogo, folio por (cliente, mes, tipo), periodo cerrado, una póliza vigente por CFDI,
// reversa única, balanza derivada con saldo inicial de cuentas de balance entre ejercicios.
import { randomUUID } from "node:crypto";
import { naturalezaPorDefecto } from "./catalogo-base.ts";
import {
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroNoEncontradoError,
  LibroTopeExcedidoError,
  PeriodoLibroCerradoError,
  PolizaDuplicadaError,
} from "./types.ts";
import type {
  AsignacionAgrupador,
  CuentaLibro,
  FiltroPolizas,
  LecturaLibro,
  LibroRepository,
  LineaBalanzaLibro,
  PolizaConMovimientos,
  PolizaInput,
  PolizaRecord,
  RegistroPolizaResultado,
  ResultadoImportacionCatalogo,
} from "./types.ts";

const CODIGO_FORMATO = /^[0-9]{3}(\.[0-9]{1,2})?$/;

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

  /** Misma regla que la migración 028: cuentas nuevas se agregan; en las que ya existen SOLO se completa lo vacío (código agrupador y jerarquía). */
  async sembrarCatalogo(propertyId: string, cuentas: readonly CuentaLibro[]): Promise<number> {
    this.exigirDisponible();
    const c = this.catalogo(propertyId);
    let nuevas = 0;
    for (const x of [...cuentas].sort((a, b) => (a.nivel ?? 1) - (b.nivel ?? 1))) {
      const actual = c.get(x.codigo);
      if (!actual) {
        c.set(x.codigo, { ...x, nivel: x.nivel ?? 1, cuentaPadre: x.cuentaPadre ?? null, codigoAgrupador: x.codigoAgrupador ?? null });
        nuevas += 1;
      } else {
        const sinJerarquia = !actual.cuentaPadre && (actual.nivel ?? 1) === 1;
        c.set(x.codigo, {
          ...actual,
          codigoAgrupador: actual.codigoAgrupador ?? x.codigoAgrupador ?? null,
          nivel: sinJerarquia && x.cuentaPadre ? (x.nivel ?? 1) : (actual.nivel ?? 1),
          cuentaPadre: sinJerarquia ? (x.cuentaPadre ?? null) : (actual.cuentaPadre ?? null),
        });
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
    if (cuenta.codigoAgrupador && !CODIGO_FORMATO.test(cuenta.codigoAgrupador)) throw new LibroDatosInvalidosError("el código agrupador del SAT es ddd o ddd.dd");
    if (cuenta.nivel !== undefined) {
      const nivel = cuenta.nivel;
      const padre = cuenta.cuentaPadre ?? null;
      if (nivel < 1 || nivel > 10 || (nivel === 1) !== (padre === null)) throw new LibroDatosInvalidosError("el nivel 1 no lleva cuenta padre y los demás niveles sí");
      if (padre !== null) {
        if (padre === cuenta.codigo) throw new LibroDatosInvalidosError("una cuenta no es subcuenta de sí misma");
        if (padre.charAt(0) !== cuenta.codigo.charAt(0)) throw new LibroDatosInvalidosError("la cuenta padre debe ser del mismo rubro (primer dígito)");
        if ((c.get(padre)?.nivel ?? 1) !== nivel - 1 || !c.has(padre)) throw new LibroDatosInvalidosError(`la cuenta padre debe existir en el catálogo del cliente con nivel ${nivel - 1}`);
      }
      if (actual && nivel !== (actual.nivel ?? 1) && [...c.values()].some((h) => h.cuentaPadre === cuenta.codigo)) throw new LibroDatosInvalidosError("una cuenta con subcuentas no cambia de nivel");
    } else if (cuenta.cuentaPadre) {
      throw new LibroDatosInvalidosError("indica el nivel junto con la cuenta padre");
    }
    c.set(cuenta.codigo, {
      ...(actual ?? {}),
      codigo: cuenta.codigo,
      descripcion: cuenta.descripcion,
      naturaleza: cuenta.naturaleza,
      nivel: cuenta.nivel ?? actual?.nivel ?? 1,
      cuentaPadre: cuenta.nivel !== undefined ? (cuenta.cuentaPadre ?? null) : (actual?.cuentaPadre ?? null),
      codigoAgrupador: cuenta.codigoAgrupador ?? actual?.codigoAgrupador ?? null,
    });
  }

  async asignarCodigosAgrupadores(propertyId: string, asignaciones: readonly AsignacionAgrupador[]): Promise<number> {
    this.exigirDisponible();
    if (asignaciones.length < 1 || asignaciones.length > 500) throw new LibroDatosInvalidosError("se esperan de 1 a 500 asignaciones");
    const c = this.catalogo(propertyId);
    if (asignaciones.some((a) => !c.has(a.codigo))) throw new LibroDatosInvalidosError("hay cuentas que no existen en el catálogo del cliente");
    if (asignaciones.some((a) => !CODIGO_FORMATO.test(a.codigoAgrupador))) throw new LibroDatosInvalidosError("código agrupador inválido (ddd o ddd.dd)");
    for (const a of asignaciones) c.set(a.codigo, { ...c.get(a.codigo)!, codigoAgrupador: a.codigoAgrupador });
    return new Set(asignaciones.map((a) => a.codigo)).size;
  }

  async importarCatalogo(propertyId: string, cuentas: readonly CuentaLibro[]): Promise<ResultadoImportacionCatalogo> {
    this.exigirDisponible();
    if (cuentas.length < 1 || cuentas.length > 500) throw new LibroDatosInvalidosError("se esperan de 1 a 500 cuentas");
    const c = this.catalogo(propertyId);
    const ultimas = new Map(cuentas.map((x) => [x.codigo, x] as const));
    const nuevas = [...ultimas.keys()].filter((k) => !c.has(k)).length;
    if (c.size + nuevas > 2000) throw new LibroTopeExcedidoError("máximo 2000 cuentas por cliente");
    for (const x of ultimas.values()) {
      const actual = c.get(x.codigo);
      if (actual && actual.naturaleza !== x.naturaleza && this.lista(propertyId).some((p) => p.movimientos.some((m) => m.cuenta === x.codigo))) throw new LibroDatosInvalidosError("una cuenta con partidas no cambia de naturaleza");
      if (!/^\d{4,10}$/.test(x.codigo) || x.descripcion.trim().length < 1) throw new LibroDatosInvalidosError("cuenta inválida");
      if (x.codigoAgrupador && !CODIGO_FORMATO.test(x.codigoAgrupador)) throw new LibroDatosInvalidosError("código agrupador inválido (ddd o ddd.dd)");
    }
    for (const x of [...ultimas.values()].sort((a, b) => (a.nivel ?? 1) - (b.nivel ?? 1))) {
      const actual = c.get(x.codigo);
      c.set(x.codigo, { codigo: x.codigo, descripcion: x.descripcion, naturaleza: x.naturaleza, nivel: x.nivel ?? 1, cuentaPadre: x.cuentaPadre ?? null, codigoAgrupador: x.codigoAgrupador ?? actual?.codigoAgrupador ?? null });
    }
    return { agregadas: nuevas, actualizadas: ultimas.size - nuevas };
  }

  async polizasDelPeriodo(propertyId: string, ejercicio: number, mes: number, maxPolizas: number): Promise<LecturaLibro<readonly PolizaConMovimientos[]>> {
    return this.lectura<readonly PolizaConMovimientos[]>([], () => {
      const lista = this.lista(propertyId)
        .filter((p) => p.ejercicio === ejercicio && p.mes === mes)
        .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tipo.localeCompare(b.tipo) || a.folio - b.folio);
      if (lista.length > maxPolizas) throw new LibroTopeExcedidoError(`El periodo tiene más de ${maxPolizas} pólizas: no caben en un solo archivo.`);
      return lista;
    });
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
