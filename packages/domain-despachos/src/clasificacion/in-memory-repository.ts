// Doble en memoria de la clasificación contable (pruebas de API y de dominio). Espeja las reglas de la migración 026: filas nuevas (nunca update
// silencioso), upsert de la corrección por (RFC, ClaveProdServ), tope de 1000 por cliente y validación de categorías. `disponible = false` simula la base
// sin migrar (lecturas `no_disponible`, escrituras `ClasificacionNoDisponibleError`).
import { randomUUID } from "node:crypto";
import { CATEGORIAS_CONTABLES, CATEGORIAS_GRUESAS } from "../bookkeeping/clasificacion-cfdi.ts";
import type { ResultadoClasificacionCfdi } from "../bookkeeping/clasificacion-cfdi.ts";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../bookkeeping/confianza.ts";
import { ClasificacionDatosInvalidosError, ClasificacionNoDisponibleError, ClasificacionNoEncontradaError, ClasificacionTopeExcedidoError } from "./types.ts";
import type { ClasificacionRecord, ClasificacionRepository, ConfigClasificacion, CorreccionInput, CorreccionRecord, LecturaClasificacion } from "./types.ts";

const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

export interface InMemoryClasificacionOptions {
  /** RFC del emisor de un CFDI (para `corregirCategoria` con regla); `null` = el CFDI no existe en esa property. */
  readonly rfcEmisorDe?: (propertyId: string, invoiceId: string) => string | null;
  /** Recalculo de dirección (la ficha vive en otro repositorio). */
  readonly recalcularDireccion?: (propertyId: string) => number | Promise<number>;
  readonly actorId?: string | null;
}

export class InMemoryClasificacionRepository implements ClasificacionRepository {
  /** false = base sin migrar. */
  disponible = true;
  private readonly clasificaciones: ClasificacionRecord[] = [];
  private readonly correcciones = new Map<string, (CorreccionRecord & { propertyId: string })>();
  private readonly configs = new Map<string, { umbral: number; portalAutoaceptar: boolean }>();

  constructor(private readonly opciones: InMemoryClasificacionOptions = {}) {}

  private exigirDisponible(): void {
    if (!this.disponible) throw new ClasificacionNoDisponibleError();
  }

  private validarCategoriaFina(categoria: string): void {
    if (!CATEGORIAS_CONTABLES.includes(categoria) && !CATEGORIAS_GRUESAS.includes(categoria)) throw new ClasificacionDatosInvalidosError("categoría inválida");
  }

  async registrar(propertyId: string, invoiceId: string, r: ResultadoClasificacionCfdi): Promise<boolean> {
    if (!this.disponible) return false;
    this.clasificaciones.push({ id: randomUUID(), invoiceId, categoria: r.categoria, confianza: r.confianza, metodo: r.metodo, razon: r.razon, cuenta: r.cuenta, empate: r.empate, clasificadaPor: this.opciones.actorId ?? null, creadaEn: new Date().toISOString() });
    void propertyId;
    return true;
  }

  async corregirCategoria(propertyId: string, invoiceId: string, input: { readonly categoria: string; readonly cuenta: string | null; readonly guardarRegla: boolean }): Promise<string> {
    this.exigirDisponible();
    this.validarCategoriaFina(input.categoria);
    const rfc = this.opciones.rfcEmisorDe?.(propertyId, invoiceId);
    if (rfc === null) throw new ClasificacionNoEncontradaError("CFDI no encontrado");
    const id = randomUUID();
    this.clasificaciones.push({ id, invoiceId, categoria: input.categoria, confianza: 1, metodo: "manual", razon: "Corrección humana", cuenta: input.cuenta, empate: false, clasificadaPor: this.opciones.actorId ?? null, creadaEn: new Date().toISOString() });
    if (input.guardarRegla && rfc) await this.guardarCorreccion(propertyId, { rfcEmisor: rfc, claveProdServ: null, categoria: input.categoria, cuenta: input.cuenta });
    return id;
  }

  async vigentes(_propertyId: string, invoiceIds: readonly string[]): Promise<LecturaClasificacion<ReadonlyMap<string, ClasificacionRecord>>> {
    if (!this.disponible) return { estado: "no_disponible", datos: new Map() };
    const m = new Map<string, ClasificacionRecord>();
    for (const c of this.clasificaciones) if (invoiceIds.includes(c.invoiceId)) m.set(c.invoiceId, c); // la última escrita gana
    return { estado: "ok", datos: m };
  }

  async historial(_propertyId: string, invoiceId: string): Promise<LecturaClasificacion<readonly ClasificacionRecord[]>> {
    if (!this.disponible) return { estado: "no_disponible", datos: [] };
    return { estado: "ok", datos: this.clasificaciones.filter((c) => c.invoiceId === invoiceId).reverse().slice(0, 50) };
  }

  async listarCorrecciones(propertyId: string): Promise<LecturaClasificacion<readonly CorreccionRecord[]>> {
    if (!this.disponible) return { estado: "no_disponible", datos: [] };
    return { estado: "ok", datos: [...this.correcciones.values()].filter((c) => c.propertyId === propertyId).sort((a, b) => a.rfcEmisor.localeCompare(b.rfcEmisor)) };
  }

  async guardarCorreccion(propertyId: string, input: CorreccionInput): Promise<string> {
    this.exigirDisponible();
    const rfc = input.rfcEmisor.trim().toUpperCase();
    if (!RFC_RE.test(rfc)) throw new ClasificacionDatosInvalidosError("RFC inválido");
    if (input.claveProdServ !== null && !/^[0-9]{8}$/.test(input.claveProdServ)) throw new ClasificacionDatosInvalidosError("ClaveProdServ inválida");
    if (input.cuenta !== null && !/^[0-9]{4,10}$/.test(input.cuenta)) throw new ClasificacionDatosInvalidosError("cuenta inválida");
    if (!CATEGORIAS_CONTABLES.includes(input.categoria)) throw new ClasificacionDatosInvalidosError("categoría inválida");
    const clave = `${propertyId}|${rfc}|${input.claveProdServ ?? ""}`;
    const previa = this.correcciones.get(clave);
    if (!previa && [...this.correcciones.values()].filter((c) => c.propertyId === propertyId).length >= 1000) throw new ClasificacionTopeExcedidoError("máximo 1000 correcciones por cliente");
    const ahora = new Date().toISOString();
    const registro = { id: previa?.id ?? randomUUID(), propertyId, rfcEmisor: rfc, claveProdServ: input.claveProdServ, categoria: input.categoria, cuenta: input.cuenta, autorId: this.opciones.actorId ?? null, creadaEn: previa?.creadaEn ?? ahora, actualizadaEn: ahora };
    this.correcciones.set(clave, registro);
    return registro.id;
  }

  async eliminarCorreccion(propertyId: string, id: string): Promise<boolean> {
    this.exigirDisponible();
    for (const [clave, c] of this.correcciones) {
      if (c.id === id && c.propertyId === propertyId) {
        this.correcciones.delete(clave);
        return true;
      }
    }
    return false;
  }

  async leerConfig(propertyId: string): Promise<ConfigClasificacion> {
    const c = this.configs.get(propertyId);
    return { umbral: c?.umbral ?? DEFAULT_CONFIDENCE_THRESHOLD, portalAutoaceptar: c?.portalAutoaceptar ?? true, disponible: this.disponible };
  }

  async guardarConfig(propertyId: string, _organizationId: string, cambios: { readonly umbral?: number; readonly portalAutoaceptar?: boolean }): Promise<ConfigClasificacion> {
    this.exigirDisponible();
    if (cambios.umbral !== undefined && (cambios.umbral < 0.5 || cambios.umbral > 1)) throw new ClasificacionDatosInvalidosError("umbral fuera de rango");
    const actual = this.configs.get(propertyId) ?? { umbral: DEFAULT_CONFIDENCE_THRESHOLD, portalAutoaceptar: true };
    const nuevo = { umbral: cambios.umbral ?? actual.umbral, portalAutoaceptar: cambios.portalAutoaceptar ?? actual.portalAutoaceptar };
    this.configs.set(propertyId, nuevo);
    return { ...nuevo, disponible: true };
  }

  async recalcularDireccion(propertyId: string): Promise<number | null> {
    if (!this.disponible) return null;
    return this.opciones.recalcularDireccion ? await this.opciones.recalcularDireccion(propertyId) : 0;
  }
}
