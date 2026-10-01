// Adaptador en memoria de `VozRepository` para pruebas de rutas. Reproduce las reglas que la base
// real impone (pertenencia sucursal/organizacion, idempotencia, costo y p95 calculados al cerrar,
// una sola consumicion de preview) y permite simular la base SIN migrar con `migrada = false`.
import { randomUUID } from "node:crypto";
import type { VozRepository } from "./repository.ts";
import { VOZ_CONFIG_POR_DEFECTO } from "./postgres-voz-repository.ts";
import { VozNoDisponibleError, VozRechazadaError } from "./types.ts";
import type {
  VozCerrarConversacionInput,
  VozConfig,
  VozConfigEntrada,
  VozConversacionesFiltro,
  VozConversacionesPagina,
  VozConversacionResumen,
  VozIniciarConversacionInput,
  VozLectura,
  VozPreviewSesion,
  VozProveedorId,
  VozRegistrarTurnoInput,
  VozTurno,
} from "./types.ts";

interface ConversacionMem extends VozConversacionResumen {
  readonly organizationId: string;
}
interface PreviewMem {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly createdBy: string;
  readonly voiceId: string;
  readonly expiresAt: number;
  consumed: boolean;
}

export class InMemoryVozRepository implements VozRepository {
  /** `false` simula una base sin la migracion 025. */
  migrada = true;
  reloj: () => number = () => Date.now();
  private readonly propiedades = new Map<string, string>();
  private readonly pedidos = new Map<string, string>();
  private readonly configs = new Map<string, VozConfig & { organizationId: string }>();
  private readonly conversaciones = new Map<string, ConversacionMem>();
  private readonly turnos = new Map<string, VozTurno[]>();
  readonly previews = new Map<string, PreviewMem>();

  seedProperty(propertyId: string, organizationId: string): void {
    this.propiedades.set(propertyId, organizationId);
  }
  seedOrder(orderId: string, organizationId: string): void {
    this.pedidos.set(orderId, organizationId);
  }

  private exigirMigrada(): void {
    if (!this.migrada) throw new VozNoDisponibleError();
  }

  async getConfig(propertyId: string): Promise<VozLectura<VozConfig>> {
    if (!this.migrada) return { disponible: false, valor: VOZ_CONFIG_POR_DEFECTO };
    const c = this.configs.get(propertyId);
    if (!c) return { disponible: true, valor: VOZ_CONFIG_POR_DEFECTO };
    const { organizationId: _o, ...config } = c;
    return { disponible: true, valor: config };
  }

  async upsertConfig(organizationId: string, propertyId: string, config: VozConfigEntrada): Promise<VozConfig> {
    this.exigirMigrada();
    if (this.propiedades.get(propertyId) !== organizationId) throw new VozRechazadaError();
    const guardada = { ...config, configurada: true, organizationId };
    this.configs.set(propertyId, guardada);
    const { organizationId: _o, ...out } = guardada;
    return out;
  }

  async crearPreviewSession(input: { organizationId: string; propertyId: string; createdBy: string; proveedor: VozProveedorId; voiceId: string; ttlSegundos: number }): Promise<VozPreviewSesion> {
    this.exigirMigrada();
    if (this.propiedades.get(input.propertyId) !== input.organizationId) throw new VozRechazadaError();
    if (input.ttlSegundos <= 0 || input.ttlSegundos > 15 * 60) throw new VozRechazadaError();
    const id = randomUUID();
    const expiresAt = this.reloj() + input.ttlSegundos * 1000;
    this.previews.set(id, { id, organizationId: input.organizationId, propertyId: input.propertyId, createdBy: input.createdBy, voiceId: input.voiceId, expiresAt, consumed: false });
    return { id, expiresAt: new Date(expiresAt).toISOString() };
  }

  async listConversaciones(organizationId: string, propertyId: string, filtro: VozConversacionesFiltro): Promise<VozLectura<VozConversacionesPagina>> {
    if (!this.migrada) return { disponible: false, valor: { items: [], total: 0 } };
    const todas = [...this.conversaciones.values()]
      .filter((c) => c.organizationId === organizationId && c.propertyId === propertyId && (!filtro.resultado || c.resultado === filtro.resultado))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : -1));
    const limit = Math.min(100, Math.max(1, filtro.limit ?? 25));
    const offset = Math.max(0, filtro.offset ?? 0);
    return { disponible: true, valor: { items: todas.slice(offset, offset + limit).map(({ organizationId: _o, ...c }) => c), total: todas.length } };
  }

  async getConversacion(organizationId: string, propertyId: string, conversationId: string): Promise<VozLectura<{ conversacion: VozConversacionResumen; turnos: readonly VozTurno[] } | null>> {
    if (!this.migrada) return { disponible: false, valor: null };
    const c = this.conversaciones.get(conversationId);
    if (!c || c.organizationId !== organizationId || c.propertyId !== propertyId) return { disponible: true, valor: null };
    const { organizationId: _o, ...conversacion } = c;
    return { disponible: true, valor: { conversacion, turnos: [...(this.turnos.get(conversationId) ?? [])].sort((a, b) => a.seq - b.seq) } };
  }

  async iniciarConversacion(input: VozIniciarConversacionInput): Promise<string> {
    this.exigirMigrada();
    if (this.propiedades.get(input.propertyId) !== input.organizationId) throw new VozRechazadaError();
    for (const c of this.conversaciones.values()) {
      if (c.organizationId === input.organizationId && c.externalId === input.externalId) {
        if (c.propertyId !== input.propertyId) throw new VozRechazadaError();
        return c.id;
      }
    }
    const id = randomUUID();
    this.conversaciones.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      externalId: input.externalId,
      canal: input.canal,
      proveedor: input.proveedor,
      voiceId: input.voiceId,
      startedAt: input.startedAt ?? new Date(this.reloj()).toISOString(),
      endedAt: null,
      durationS: null,
      costoEstimadoMicroUsd: 0,
      latenciaP95Ms: null,
      resultado: null,
      orderId: null,
    });
    this.turnos.set(id, []);
    return id;
  }

  async registrarTurno(input: VozRegistrarTurnoInput): Promise<boolean> {
    this.exigirMigrada();
    const c = this.conversaciones.get(input.conversationId);
    if (!c || c.organizationId !== input.organizationId || c.endedAt !== null) throw new VozRechazadaError();
    const lista = this.turnos.get(input.conversationId)!;
    if (lista.some((t) => t.seq === input.seq)) return false;
    lista.push({ seq: input.seq, rol: input.rol, texto: input.texto.slice(0, 4000), duracionMs: input.duracionMs, latenciaMs: input.latenciaMs, costoEstimadoMicroUsd: input.costoMicroUsd, createdAt: new Date(this.reloj()).toISOString() });
    return true;
  }

  async cerrarConversacion(input: VozCerrarConversacionInput): Promise<boolean> {
    this.exigirMigrada();
    if (input.orderId !== null && this.pedidos.get(input.orderId) !== input.organizationId) throw new VozRechazadaError();
    const c = this.conversaciones.get(input.conversationId);
    if (!c || c.organizationId !== input.organizationId || c.endedAt !== null) return false;
    const turnos = this.turnos.get(input.conversationId) ?? [];
    const latencias = turnos.map((t) => t.latenciaMs).filter((l): l is number => l !== null).sort((a, b) => a - b);
    const fin = input.endedAt ?? new Date(this.reloj()).toISOString();
    this.conversaciones.set(input.conversationId, {
      ...c,
      endedAt: fin,
      resultado: input.resultado,
      orderId: input.orderId,
      durationS: Math.max(0, Math.floor((new Date(fin).getTime() - new Date(c.startedAt).getTime()) / 1000)),
      costoEstimadoMicroUsd: turnos.reduce((s, t) => s + t.costoEstimadoMicroUsd, 0),
      // percentile_disc(0.95): primer valor cuya distribucion acumulada >= 0.95.
      latenciaP95Ms: latencias.length === 0 ? null : latencias[Math.max(0, Math.ceil(0.95 * latencias.length) - 1)]!,
    });
    return true;
  }

  async consumirPreview(input: { sessionId: string; organizationId: string; propertyId: string }): Promise<boolean> {
    this.exigirMigrada();
    const s = this.previews.get(input.sessionId);
    if (!s || s.organizationId !== input.organizationId || s.propertyId !== input.propertyId || s.consumed || s.expiresAt <= this.reloj()) return false;
    s.consumed = true;
    return true;
  }
}
