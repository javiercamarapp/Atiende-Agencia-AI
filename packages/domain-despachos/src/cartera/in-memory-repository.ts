// D-21 -- doble en memoria de la cartera (pruebas de rutas y del dominio). Replica las reglas de la migración 018 que
// las pruebas ejercen: RFC único por organización, RFC inmutable, tope por organización y alcance de la property.
import { randomUUID } from "node:crypto";
import type { FichaClienteNormalizada } from "./ficha.ts";
import { CarteraDatosInvalidosError, CarteraNoDisponibleError, CarteraSinPermisoError, CarteraTopeExcedidoError, ClienteRfcDuplicadoError } from "./types.ts";
import type { CarteraRepository, CarteraResultado, ClienteFichaRecord } from "./types.ts";

export const CARTERA_TOPE_POR_ORGANIZACION = 500;

interface PropiedadMemoria {
  readonly id: string;
  readonly organizationId: string;
  nombre: string;
}

export class InMemoryCarteraRepository implements CarteraRepository {
  private readonly propiedades = new Map<string, PropiedadMemoria>();
  private readonly fichas = new Map<string, ClienteFichaRecord>();
  /** Simula la base SIN migrar: cada operación se comporta como el adaptador Postgres ante 42P01/42883. */
  disponible = true;

  /** Registra una property de despachos ya existente (como las que crean los seeds), con o sin ficha. */
  sembrarCliente(organizationId: string, nombre: string, ficha?: FichaClienteNormalizada, propertyId: string = randomUUID()): string {
    this.propiedades.set(propertyId, { id: propertyId, organizationId, nombre });
    if (ficha) this.fichas.set(propertyId, this.crearFicha(propertyId, organizationId, ficha));
    return propertyId;
  }

  private crearFicha(propertyId: string, organizationId: string, f: FichaClienteNormalizada, previa?: ClienteFichaRecord): ClienteFichaRecord {
    const ahora = new Date().toISOString();
    return {
      propertyId,
      organizationId,
      rfc: f.rfc,
      tipoPersona: f.tipoPersona,
      razonSocial: f.razonSocial,
      regimenesFiscales: f.regimenesFiscales,
      cpFiscal: f.cpFiscal,
      periodicidad: f.periodicidad,
      responsableId: f.responsableId,
      createdAt: previa?.createdAt ?? ahora,
      updatedAt: ahora,
    };
  }

  async listar(organizationId: string): Promise<CarteraResultado> {
    const filas = [...this.propiedades.values()].filter((p) => p.organizationId === organizationId).sort((a, b) => a.nombre.localeCompare(b.nombre));
    return {
      estado: this.disponible ? "disponible" : "no_disponible",
      clientes: filas.map((p) => ({ propertyId: p.id, nombre: p.nombre, ficha: this.disponible ? (this.fichas.get(p.id) ?? null) : null })),
    };
  }

  async obtenerFicha(propertyId: string): Promise<ClienteFichaRecord | null> {
    return this.disponible ? (this.fichas.get(propertyId) ?? null) : null;
  }

  private rfcOcupado(organizationId: string, rfc: string, exceptoProperty?: string): boolean {
    return [...this.fichas.values()].some((f) => f.organizationId === organizationId && f.rfc === rfc && f.propertyId !== exceptoProperty);
  }

  async alta(organizationId: string, nombre: string, ficha: FichaClienteNormalizada): Promise<{ readonly propertyId: string }> {
    if (!this.disponible) throw new CarteraNoDisponibleError();
    if ([...this.propiedades.values()].filter((p) => p.organizationId === organizationId).length >= CARTERA_TOPE_POR_ORGANIZACION) throw new CarteraTopeExcedidoError();
    if (this.rfcOcupado(organizationId, ficha.rfc)) throw new ClienteRfcDuplicadoError();
    const propertyId = randomUUID();
    this.propiedades.set(propertyId, { id: propertyId, organizationId, nombre });
    this.fichas.set(propertyId, this.crearFicha(propertyId, organizationId, ficha));
    return { propertyId };
  }

  async guardarFicha(propertyId: string, ficha: FichaClienteNormalizada): Promise<void> {
    if (!this.disponible) throw new CarteraNoDisponibleError();
    const propiedad = this.propiedades.get(propertyId);
    if (!propiedad) throw new CarteraSinPermisoError();
    const previa = this.fichas.get(propertyId);
    if (previa && previa.rfc !== ficha.rfc) throw new CarteraDatosInvalidosError("el RFC de un cliente ya registrado no se modifica");
    if (!previa && this.rfcOcupado(propiedad.organizationId, ficha.rfc)) throw new ClienteRfcDuplicadoError();
    this.fichas.set(propertyId, this.crearFicha(propertyId, propiedad.organizationId, ficha, previa));
  }
}
