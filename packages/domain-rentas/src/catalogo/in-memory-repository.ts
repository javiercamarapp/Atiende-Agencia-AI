// Doble en memoria del catalogo. Modela las reglas de negocio de las funciones SQL de la migracion 027 que NO
// dependen de la identidad (duplicados por alcance/nombre, propietario de otra organizacion, moneda inmutable con
// movimientos) y la disponibilidad de la migracion. El rol del actor y el aislamiento por RLS son SQL, verificados
// contra Postgres real en scripts/verify-rentas-operar-tenant-nuevo; las rutas comprueban el rol antes de llamar.
import { randomUUID } from "node:crypto";
import type { RentasCatalogoRepository } from "./repository.ts";
import type {
  CanalRecordCatalogo,
  EntradaActualizarPropiedad,
  EntradaActualizarPropietario,
  EntradaActualizarReglaComision,
  EntradaActualizarUnidad,
  EntradaCrearPropiedad,
  EntradaCrearPropietario,
  EntradaCrearUnidad,
  EntradaReglaComision,
  MotivoRechazoCatalogo,
  PropiedadCatalogoRecord,
  PropietarioRecord,
  ReglaComisionRecord,
  ResultadoCatalogo,
  UnidadCatalogoRecord,
} from "./tipos.ts";

const CANALES: readonly CanalRecordCatalogo[] = [
  { codigo: "airbnb", nombre: "Airbnb" },
  { codigo: "vrbo", nombre: "Vrbo" },
  { codigo: "booking", nombre: "Booking.com" },
  { codigo: "manual", nombre: "Reserva directa / bloqueo manual interno" },
];

/** Mismos valores sugeridos que `rentas.sembrar_reglas_comision_base` (migracion 027). */
const REGLAS_POR_DEFECTO: readonly { codigo: string; yaNeto: boolean; bps: number; fuente: string }[] = [
  { codigo: "airbnb", yaNeto: true, bps: 0, fuente: "default_sugerido: Airbnb entrega el monto ya neto de su comisión (confirmado en Finanzas-1)" },
  { codigo: "booking", yaNeto: false, bps: 1500, fuente: "default_sugerido_no_verificado: 15% de comisión estimada de Booking.com; confirma tu contrato y edítala" },
  { codigo: "vrbo", yaNeto: false, bps: 800, fuente: "default_sugerido_no_verificado: 8% de comisión estimada de Vrbo; confirma tu contrato y edítala" },
  { codigo: "manual", yaNeto: false, bps: 0, fuente: "default_sugerido: reserva directa o manual, sin comisión de canal" },
];

interface PropiedadFila {
  organizationId: string;
  propertyId: string;
  nombre: string;
  zonaHoraria: string;
  moneda: string;
}
interface UnidadFila {
  id: string;
  organizationId: string;
  propertyId: string;
  nombre: string;
  duracionMinimaNoches: number;
  propietarioId: string | null;
  responsableLimpiezaId?: string | null;
}
interface PropietarioFila {
  id: string;
  nombre: string;
  email: string | null;
  organizationIds: Set<string>;
}
interface ReglaFila {
  id: string;
  organizationId: string;
  propertyId: string | null;
  canalCodigo: string;
  yaNeto: boolean;
  bps: number;
  fuente: string;
  vigenteDesde: string;
}

function rechazo(motivo: MotivoRechazoCatalogo, mensaje: string): ResultadoCatalogo<never> {
  return { estado: "rechazado", motivo, mensaje };
}

export class InMemoryRentasCatalogoRepository implements RentasCatalogoRepository {
  /** `false` simula la base real SIN la migracion 027: toda escritura responde `no_disponible`. */
  migracion027Disponible = true;
  /** Migracion 033 (responsable de limpieza por omision): `false` simula la base sin migrar. */
  migracion033Disponible = true;
  readonly propiedades = new Map<string, PropiedadFila>();
  readonly unidades = new Map<string, UnidadFila>();
  readonly propietarios = new Map<string, PropietarioFila>();
  readonly reglas = new Map<string, ReglaFila>();
  /** Propiedades con movimientos financieros (la moneda deja de poder cambiarse). */
  readonly propiedadesConMovimientos = new Set<string>();
  /** Propiedades con reservas o bloqueos vigentes (no cancelados, con fin >= hoy): la zona horaria deja de poder cambiarse (D-DSD-07). */
  readonly propiedadesConOcupacionesActivas = new Set<string>();

  seedPropiedad(p: { organizationId: string; propertyId: string; nombre: string; zonaHoraria?: string; moneda?: string }): void {
    this.propiedades.set(p.propertyId, { zonaHoraria: "America/Mexico_City", moneda: "MXN", ...p });
  }

  seedPropietario(p: { id: string; nombre: string; email?: string | null; organizationIds: readonly string[] }): void {
    this.propietarios.set(p.id, { id: p.id, nombre: p.nombre, email: p.email ?? null, organizationIds: new Set(p.organizationIds) });
  }

  seedUnidad(u: Omit<UnidadFila, "propietarioId" | "duracionMinimaNoches"> & { propietarioId?: string | null; duracionMinimaNoches?: number }): void {
    this.unidades.set(u.id, { propietarioId: null, duracionMinimaNoches: 1, ...u });
  }

  private sembrar(organizationId: string): number {
    let creadas = 0;
    for (const d of REGLAS_POR_DEFECTO) {
      const existe = [...this.reglas.values()].some((r) => r.organizationId === organizationId && r.propertyId === null && r.canalCodigo === d.codigo);
      if (existe) continue;
      const id = randomUUID();
      this.reglas.set(id, { id, organizationId, propertyId: null, canalCodigo: d.codigo, yaNeto: d.yaNeto, bps: d.bps, fuente: d.fuente, vigenteDesde: new Date().toISOString().slice(0, 10) });
      creadas += 1;
    }
    return creadas;
  }

  // ---- lecturas ----

  async listarReglasComision(organizationId: string, propertyId: string): Promise<readonly ReglaComisionRecord[]> {
    return [...this.reglas.values()]
      .filter((r) => r.organizationId === organizationId && (r.propertyId === null || r.propertyId === propertyId))
      .sort((a, b) => a.canalCodigo.localeCompare(b.canalCodigo) || (a.propertyId === null ? -1 : 1))
      .map((r) => ({
        id: r.id,
        propertyId: r.propertyId,
        canalCodigo: r.canalCodigo,
        canalNombre: CANALES.find((c) => c.codigo === r.canalCodigo)?.nombre ?? r.canalCodigo,
        yaNetoDeComision: r.yaNeto,
        comisionBasisPoints: r.bps,
        fuente: r.fuente,
        vigenteDesde: r.vigenteDesde,
        sugerida: r.fuente.startsWith("default_sugerido"),
      }));
  }

  async listarCanales(): Promise<readonly CanalRecordCatalogo[]> {
    return CANALES;
  }

  async listarPropiedades(organizationId: string): Promise<readonly PropiedadCatalogoRecord[]> {
    return [...this.propiedades.values()]
      .filter((p) => p.organizationId === organizationId)
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((p) => ({ propertyId: p.propertyId, nombre: p.nombre, zonaHoraria: p.zonaHoraria, moneda: p.moneda }));
  }

  async listarUnidades(propertyId: string): Promise<readonly UnidadCatalogoRecord[]> {
    return [...this.unidades.values()]
      .filter((u) => u.propertyId === propertyId)
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((u) => ({
        id: u.id,
        propertyId: u.propertyId,
        nombre: u.nombre,
        duracionMinimaNoches: u.duracionMinimaNoches,
        propietarioId: u.propietarioId,
        propietarioNombre: u.propietarioId ? (this.propietarios.get(u.propietarioId)?.nombre ?? null) : null,
        responsableLimpiezaId: this.migracion033Disponible ? (u.responsableLimpiezaId ?? null) : null,
      }));
  }

  async listarPropietarios(organizationId: string): Promise<readonly PropietarioRecord[]> {
    return [...this.propietarios.values()]
      .filter((p) => p.organizationIds.has(organizationId))
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((p) => ({ id: p.id, nombre: p.nombre, email: p.email }));
  }

  // ---- escrituras ----

  async crearReglaComision(organizationId: string, propertyId: string, e: EntradaReglaComision): Promise<ResultadoCatalogo<{ id: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    if (!CANALES.some((c) => c.codigo === e.canalCodigo)) return rechazo("invalido", "canal desconocido.");
    const alcance = e.alcance === "propiedad" ? propertyId : null;
    if ([...this.reglas.values()].some((r) => r.organizationId === organizationId && r.canalCodigo === e.canalCodigo && r.propertyId === alcance)) {
      return rechazo("duplicado", "ya existe una regla para ese canal y alcance; edítala en lugar de crear otra.");
    }
    const id = randomUUID();
    this.reglas.set(id, { id, organizationId, propertyId: alcance, canalCodigo: e.canalCodigo, yaNeto: e.yaNetoDeComision, bps: e.comisionBasisPoints, fuente: e.fuente, vigenteDesde: new Date().toISOString().slice(0, 10) });
    return { estado: "ok", valor: { id } };
  }

  async actualizarReglaComision(reglaId: string, e: EntradaActualizarReglaComision): Promise<ResultadoCatalogo<{ id: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    const r = this.reglas.get(reglaId);
    if (!r) return rechazo("no_encontrado", "regla no encontrada.");
    r.yaNeto = e.yaNetoDeComision;
    r.bps = e.comisionBasisPoints;
    r.fuente = e.fuente;
    return { estado: "ok", valor: { id: r.id } };
  }

  async sembrarReglasComisionPorDefecto(organizationId: string): Promise<ResultadoCatalogo<{ creadas: number }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    return { estado: "ok", valor: { creadas: this.sembrar(organizationId) } };
  }

  async crearPropiedad(organizationId: string, e: EntradaCrearPropiedad): Promise<ResultadoCatalogo<{ propertyId: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    if ([...this.propiedades.values()].some((p) => p.organizationId === organizationId && p.nombre.toLowerCase() === e.nombre.toLowerCase())) {
      return rechazo("duplicado", "ya existe una propiedad con ese nombre.");
    }
    const propertyId = randomUUID();
    this.propiedades.set(propertyId, { organizationId, propertyId, nombre: e.nombre, zonaHoraria: e.zonaHoraria, moneda: e.moneda });
    this.sembrar(organizationId);
    return { estado: "ok", valor: { propertyId } };
  }

  async actualizarPropiedad(propertyId: string, e: EntradaActualizarPropiedad): Promise<ResultadoCatalogo<{ propertyId: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    const p = this.propiedades.get(propertyId);
    if (!p) return rechazo("no_encontrado", "propiedad no encontrada.");
    if (e.nombre !== undefined && [...this.propiedades.values()].some((o) => o.organizationId === p.organizationId && o.propertyId !== propertyId && o.nombre.toLowerCase() === e.nombre!.toLowerCase())) {
      return rechazo("duplicado", "ya existe una propiedad con ese nombre.");
    }
    if (e.zonaHoraria !== undefined && e.zonaHoraria !== p.zonaHoraria && this.propiedadesConOcupacionesActivas.has(propertyId)) {
      return rechazo("regla_integridad", "no se puede cambiar la zona horaria con reservas o bloqueos activos.");
    }
    if (e.moneda !== undefined && e.moneda !== p.moneda && this.propiedadesConMovimientos.has(propertyId)) {
      return rechazo("regla_integridad", "la propiedad ya tiene movimientos financieros; no se puede cambiar su moneda.");
    }
    if (e.nombre !== undefined) p.nombre = e.nombre;
    if (e.zonaHoraria !== undefined) p.zonaHoraria = e.zonaHoraria;
    if (e.moneda !== undefined) p.moneda = e.moneda;
    return { estado: "ok", valor: { propertyId } };
  }

  async crearPropietario(organizationId: string, e: EntradaCrearPropietario): Promise<ResultadoCatalogo<{ id: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    if (e.email && [...this.propietarios.values()].some((p) => p.organizationIds.has(organizationId) && p.email === e.email)) {
      return rechazo("duplicado", "ya existe un propietario con ese correo.");
    }
    const id = randomUUID();
    this.propietarios.set(id, { id, nombre: e.nombre, email: e.email, organizationIds: new Set([organizationId]) });
    return { estado: "ok", valor: { id } };
  }

  async actualizarPropietario(organizationId: string, propietarioId: string, e: EntradaActualizarPropietario): Promise<ResultadoCatalogo<{ id: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    const p = this.propietarios.get(propietarioId);
    if (!p || !p.organizationIds.has(organizationId)) return rechazo("no_encontrado", "propietario no encontrado.");
    if (p.organizationIds.size > 1) return rechazo("sin_permiso", "este propietario también lo gestiona otra organización; no se puede editar desde aquí.");
    if (e.email && [...this.propietarios.values()].some((o) => o.id !== propietarioId && o.organizationIds.has(organizationId) && o.email === e.email)) {
      return rechazo("duplicado", "ya existe otro propietario con ese correo.");
    }
    if (e.nombre !== undefined) p.nombre = e.nombre;
    if (e.email !== undefined) p.email = e.email;
    return { estado: "ok", valor: { id: propietarioId } };
  }

  async crearUnidad(propertyId: string, e: EntradaCrearUnidad): Promise<ResultadoCatalogo<{ id: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    const p = this.propiedades.get(propertyId);
    if (!p) return rechazo("sin_permiso", "tu rol no puede crear unidades en esta propiedad.");
    if (e.propietarioId && !this.propietarios.get(e.propietarioId)?.organizationIds.has(p.organizationId)) {
      return rechazo("invalido", "el propietario no pertenece a esta organización.");
    }
    if ([...this.unidades.values()].some((u) => u.propertyId === propertyId && u.nombre === e.nombre)) {
      return rechazo("duplicado", "ya existe una unidad con ese nombre en esta propiedad.");
    }
    const id = randomUUID();
    this.unidades.set(id, { id, organizationId: p.organizationId, propertyId, nombre: e.nombre, duracionMinimaNoches: e.duracionMinimaNoches, propietarioId: e.propietarioId });
    return { estado: "ok", valor: { id } };
  }

  async actualizarUnidad(unidadId: string, e: EntradaActualizarUnidad): Promise<ResultadoCatalogo<{ id: string }>> {
    if (!this.migracion027Disponible) return { estado: "no_disponible" };
    const u = this.unidades.get(unidadId);
    if (!u) return rechazo("no_encontrado", "unidad no encontrada.");
    if (e.propietarioId && !this.propietarios.get(e.propietarioId)?.organizationIds.has(u.organizationId)) {
      return rechazo("invalido", "el propietario no pertenece a esta organización.");
    }
    if (e.nombre !== undefined && [...this.unidades.values()].some((o) => o.propertyId === u.propertyId && o.id !== unidadId && o.nombre === e.nombre)) {
      return rechazo("duplicado", "ya existe una unidad con ese nombre en esta propiedad.");
    }
    if (e.nombre !== undefined) u.nombre = e.nombre;
    if (e.propietarioId !== undefined) u.propietarioId = e.propietarioId;
    if (e.duracionMinimaNoches !== undefined) u.duracionMinimaNoches = e.duracionMinimaNoches;
    return { estado: "ok", valor: { id: unidadId } };
  }

  async fijarResponsableLimpieza(unidadId: string, responsableId: string | null): Promise<ResultadoCatalogo<{ id: string }>> {
    if (!this.migracion033Disponible) return { estado: "no_disponible" };
    const u = this.unidades.get(unidadId);
    if (!u) return rechazo("no_encontrado", "unidad no encontrada.");
    u.responsableLimpiezaId = responsableId;
    return { estado: "ok", valor: { id: unidadId } };
  }
}
