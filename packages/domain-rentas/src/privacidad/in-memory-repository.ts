// Doble en memoria de las solicitudes ARCO de rentas (tests). Replica las reglas de rentas.arco_registrar /
// rentas.arco_cambiar_estado (plazos, idempotencia por contacto+derecho, transiciones, nota al rechazar).
import { ARCO_ESTADOS_ABIERTOS, ARCO_PLAZO_EJECUCION_DIAS, ARCO_PLAZO_RESPUESTA_DIAS } from "./tipos.ts";
import type { ArcoEstado, ArcoEstadoDestino, EntradaSolicitudArco, EventoArco, FiltroSolicitudesArco, PaginaSolicitudesArco, ResultadoCambioEstadoArco, ResultadoRegistroArco, SolicitudArco } from "./tipos.ts";
import type { RentasPrivacidadRepository } from "./repository.ts";

const DIA_MS = 24 * 3600 * 1000;

export class InMemoryRentasPrivacidadRepository implements RentasPrivacidadRepository {
  private readonly solicitudes = new Map<string, SolicitudArco & { organizationId: string }>();
  private readonly eventos: (EventoArco & { organizationId: string })[] = [];
  private seq = 0;

  /** `autorizado` apaga el rol (simula un usuario sin permiso); `disponible` simula la base sin migrar. */
  constructor(private readonly opciones: { autorizado?: boolean; disponible?: boolean; actorId?: string; reloj?: () => Date } = {}) {}

  private ahora(): Date {
    return this.opciones.reloj?.() ?? new Date();
  }

  async listar(organizationId: string, filtro: FiltroSolicitudesArco, pagina: { limit: number; offset: number }): Promise<PaginaSolicitudesArco> {
    if (this.opciones.disponible === false) return { disponible: false, total: 0, items: [], nextOffset: null };
    if (this.opciones.autorizado === false) return { disponible: true, total: 0, items: [], nextOffset: null }; // RLS: sin permiso no ve filas
    const todas = [...this.solicitudes.values()]
      .filter((s) => s.organizationId === organizationId && (!filtro.estado || s.estado === filtro.estado) && (!filtro.derecho || s.derecho === filtro.derecho))
      .sort((a, b) => Number(!ARCO_ESTADOS_ABIERTOS.includes(a.estado)) - Number(!ARCO_ESTADOS_ABIERTOS.includes(b.estado)) || b.recibidaEn.localeCompare(a.recibidaEn));
    const items = todas.slice(pagina.offset, pagina.offset + pagina.limit).map(({ organizationId: _o, ...s }) => s);
    const siguiente = pagina.offset + items.length;
    return { disponible: true, total: todas.length, items, nextOffset: siguiente < todas.length ? siguiente : null };
  }

  async listarEventos(organizationId: string, solicitudId: string): Promise<readonly EventoArco[] | null> {
    if (this.opciones.disponible === false) return null;
    if (this.opciones.autorizado === false) return [];
    return this.eventos.filter((e) => e.organizationId === organizationId && e.solicitudId === solicitudId).map(({ organizationId: _o, ...e }) => e);
  }

  async registrar(organizationId: string, e: EntradaSolicitudArco): Promise<ResultadoRegistroArco> {
    if (this.opciones.disponible === false) return { outcome: "unavailable" };
    if (this.opciones.autorizado === false) return { outcome: "forbidden" };
    const contacto = e.solicitanteContacto.trim().toLowerCase();
    const existente = [...this.solicitudes.values()].find((s) => s.organizationId === organizationId && s.derecho === e.derecho && s.solicitanteContacto.trim().toLowerCase() === contacto && ARCO_ESTADOS_ABIERTOS.includes(s.estado));
    if (existente) return { outcome: "existing", id: existente.id };
    const recibida = e.recibidaEn ? new Date(e.recibidaEn) : this.ahora();
    this.seq += 1;
    const id = `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
    this.solicitudes.set(id, {
      organizationId,
      id,
      derecho: e.derecho,
      canal: e.canal,
      estado: "recibida",
      solicitanteNombre: e.solicitanteNombre,
      solicitanteContacto: e.solicitanteContacto,
      detalle: e.detalle,
      recibidaEn: recibida.toISOString(),
      respuestaVenceEn: new Date(recibida.getTime() + ARCO_PLAZO_RESPUESTA_DIAS * DIA_MS).toISOString(),
      ejecucionVenceEn: new Date(recibida.getTime() + (ARCO_PLAZO_RESPUESTA_DIAS + ARCO_PLAZO_EJECUCION_DIAS) * DIA_MS).toISOString(),
      resueltaEn: null,
      notaResolucion: null,
      atendidaPor: null,
    });
    this.eventos.push({ organizationId, id: `ev-${this.eventos.length + 1}`, solicitudId: id, evento: "registrada", desde: null, hacia: "recibida", nota: null, actorId: this.opciones.actorId ?? null, creadoEn: this.ahora().toISOString() });
    return { outcome: "created", id };
  }

  async cambiarEstado(organizationId: string, solicitudId: string, estado: ArcoEstadoDestino, nota: string | null): Promise<ResultadoCambioEstadoArco> {
    if (this.opciones.disponible === false) return { outcome: "unavailable" };
    if (this.opciones.autorizado === false) return { outcome: "forbidden" };
    const s = this.solicitudes.get(solicitudId);
    if (!s || s.organizationId !== organizationId) return { outcome: "not_found" };
    if (estado === "rechazada" && !nota) return { outcome: "invalid_input" };
    if (!ARCO_ESTADOS_ABIERTOS.includes(s.estado) || s.estado === estado) return { outcome: "invalid_transition" };
    const desde: ArcoEstado = s.estado;
    const cierra = estado === "resuelta" || estado === "rechazada";
    this.solicitudes.set(solicitudId, { ...s, estado, atendidaPor: this.opciones.actorId ?? null, notaResolucion: cierra ? nota : s.notaResolucion, resueltaEn: cierra ? this.ahora().toISOString() : null });
    this.eventos.push({ organizationId, id: `ev-${this.eventos.length + 1}`, solicitudId, evento: "cambio_estado", desde, hacia: estado, nota, actorId: this.opciones.actorId ?? null, creadoEn: this.ahora().toISOString() });
    return { outcome: "updated", id: solicitudId, estado };
  }
}
