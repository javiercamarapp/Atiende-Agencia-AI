// D-11 -- repositorio en memoria de la cola de cobranza para tests de la API y del dominio. Replica las reglas
// de las funciones de la migracion 017 (pertenencia a la property, consentimiento, dedupe, topes, transiciones).
// `disponible = false` simula la base SIN migrar.
import { randomUUID } from "node:crypto";
import { validarNuevaGestion } from "./validacion.ts";
import { normalizarRfc } from "./whatsapp.ts";
import {
  ColaCuotaExcedidaError,
  ColaEntradaInvalidaError,
  ColaEstadoInvalidoError,
  ColaNoEncontradaError,
  ColaSinConsentimientoError,
} from "./types.ts";
import type {
  ColaCobranzaRepository,
  ColaDisponible,
  ConsentimientoWhatsApp,
  EncolarWhatsAppInput,
  FijarConsentimientoInput,
  FiltroGestiones,
  GestionCobranza,
  GestionEstadoResolucion,
  MensajeOutboxWhatsApp,
  NuevaGestionInput,
} from "./types.ts";

export interface CuentaSemilla {
  readonly propertyId: string;
  readonly receivableId: string;
  readonly rfcReceptor: string;
  readonly pagada?: boolean;
}

const MAX_GESTIONES_POR_CUENTA = 500;
const MAX_PENDIENTES_OUTBOX = 200;
const E164_RE = /^\+[1-9][0-9]{7,14}$/;

export class InMemoryColaCobranzaRepository implements ColaCobranzaRepository {
  private readonly gestiones: (GestionCobranza & { propertyId: string })[] = [];
  private readonly consentimientos = new Map<string, ConsentimientoWhatsApp & { propertyId: string; telefono: string }>();
  private readonly outbox: (MensajeOutboxWhatsApp & { propertyId: string; dedupeKey: string; telefono: string })[] = [];

  constructor(
    private readonly cuentas: readonly CuentaSemilla[],
    private readonly opciones: { readonly disponible?: boolean; readonly hoy?: () => string; readonly ahora?: () => string } = {},
  ) {}

  private get disponible(): boolean {
    return this.opciones.disponible !== false;
  }
  private hoy(): string {
    return this.opciones.hoy ? this.opciones.hoy() : "2026-01-15";
  }
  private ahora(): string {
    return this.opciones.ahora ? this.opciones.ahora() : `${this.hoy()}T12:00:00.000Z`;
  }
  private id(): string {
    return randomUUID();
  }
  private cuenta(propertyId: string, receivableId: string) {
    const c = this.cuentas.find((x) => x.propertyId === propertyId && x.receivableId === receivableId);
    if (!c) throw new ColaNoEncontradaError();
    return c;
  }
  private ok<T>(valor: T): ColaDisponible<T> {
    return { disponible: true, valor };
  }

  async listarGestiones(propertyId: string, filtro: FiltroGestiones = {}): Promise<ColaDisponible<readonly GestionCobranza[]>> {
    if (!this.disponible) return { disponible: false };
    const filas = this.gestiones
      .filter((g) => g.propertyId === propertyId && (filtro.receivableId === undefined || g.receivableId === filtro.receivableId) && (filtro.estado === undefined || g.estado === filtro.estado))
      .map(({ propertyId: _p, ...g }) => g)
      .reverse();
    return this.ok(filas);
  }

  async crearGestion(input: NuevaGestionInput): Promise<ColaDisponible<{ readonly id: string }>> {
    if (!this.disponible) return { disponible: false };
    const cuenta = this.cuenta(input.propertyId, input.receivableId);
    const motivo = validarNuevaGestion(input, this.hoy());
    if (motivo !== null) throw new ColaEntradaInvalidaError(motivo);
    if (input.tipo === "promesa_pago" && cuenta.pagada) throw new ColaEntradaInvalidaError("La cuenta ya esta pagada.");
    if (this.gestiones.filter((g) => g.receivableId === input.receivableId).length >= MAX_GESTIONES_POR_CUENTA) throw new ColaCuotaExcedidaError();
    const id = this.id();
    const ahora = this.ahora();
    this.gestiones.push({
      id,
      propertyId: input.propertyId,
      receivableId: input.receivableId,
      tipo: input.tipo,
      estado: input.tipo === "promesa_pago" || input.fechaSeguimiento !== null ? "pendiente" : "cumplida",
      montoPromesaCentavos: input.montoPromesaCentavos,
      fechaPromesa: input.fechaPromesa,
      fechaSeguimiento: input.fechaSeguimiento,
      nota: input.nota === null ? null : input.nota.trim(),
      creadoEn: ahora,
      actualizadoEn: ahora,
    });
    return this.ok({ id });
  }

  async resolverGestion(propertyId: string, gestionId: string, estado: GestionEstadoResolucion, nota: string | null): Promise<ColaDisponible<true>> {
    if (!this.disponible) return { disponible: false };
    const idx = this.gestiones.findIndex((g) => g.id === gestionId && g.propertyId === propertyId);
    if (idx < 0) throw new ColaNoEncontradaError();
    const g = this.gestiones[idx]!;
    if (g.estado !== "pendiente") throw new ColaEstadoInvalidoError();
    this.gestiones[idx] = { ...g, estado, nota: nota === null ? g.nota : nota.trim(), actualizadoEn: this.ahora() };
    return this.ok(true);
  }

  async listarConsentimientos(propertyId: string): Promise<ColaDisponible<readonly ConsentimientoWhatsApp[]>> {
    if (!this.disponible) return { disponible: false };
    return this.ok([...this.consentimientos.values()].filter((c) => c.propertyId === propertyId).map(({ propertyId: _p, ...c }) => c));
  }

  async fijarConsentimiento(input: FijarConsentimientoInput): Promise<ColaDisponible<true>> {
    if (!this.disponible) return { disponible: false };
    const rfc = normalizarRfc(input.rfcReceptor);
    if (rfc === null || !E164_RE.test(input.telefono)) throw new ColaEntradaInvalidaError();
    if (input.estado === "opt_in" && (input.evidencia === null || input.evidencia.trim() === "")) throw new ColaEntradaInvalidaError();
    if (!this.cuentas.some((c) => c.propertyId === input.propertyId && c.rfcReceptor === rfc)) throw new ColaNoEncontradaError();
    this.consentimientos.set(`${input.propertyId}|${rfc}`, { propertyId: input.propertyId, rfcReceptor: rfc, telefono: input.telefono, estado: input.estado, evidencia: input.evidencia, actualizadoEn: this.ahora() });
    if (input.estado === "opt_out") {
      for (const m of this.outbox) if (m.propertyId === input.propertyId && m.rfcReceptor === rfc && m.estado === "pendiente") (m as { estado: string }).estado = "cancelado";
    }
    return this.ok(true);
  }

  async encolarWhatsApp(input: EncolarWhatsAppInput): Promise<ColaDisponible<{ readonly id: string; readonly duplicado: boolean }>> {
    if (!this.disponible) return { disponible: false };
    const cuenta = this.cuenta(input.propertyId, input.receivableId);
    if (cuenta.pagada) throw new ColaEntradaInvalidaError("La cuenta ya esta pagada.");
    const cuerpo = input.cuerpo.trim();
    if (cuerpo.length < 1 || cuerpo.length > 1000) throw new ColaEntradaInvalidaError();
    const consent = this.consentimientos.get(`${input.propertyId}|${cuenta.rfcReceptor}`);
    if (!consent || consent.estado !== "opt_in") throw new ColaSinConsentimientoError();
    const previo = this.outbox.find((m) => m.propertyId === input.propertyId && m.dedupeKey === input.dedupeKey);
    if (previo) return this.ok({ id: previo.id, duplicado: true });
    if (this.outbox.filter((m) => m.propertyId === input.propertyId && m.estado === "pendiente").length >= MAX_PENDIENTES_OUTBOX) throw new ColaCuotaExcedidaError();
    const id = this.id();
    this.outbox.push({ id, propertyId: input.propertyId, receivableId: input.receivableId, rfcReceptor: cuenta.rfcReceptor, cuerpo, estado: "pendiente", creadoEn: this.ahora(), dedupeKey: input.dedupeKey, telefono: consent.telefono });
    return this.ok({ id, duplicado: false });
  }

  async listarOutbox(propertyId: string): Promise<ColaDisponible<readonly MensajeOutboxWhatsApp[]>> {
    if (!this.disponible) return { disponible: false };
    return this.ok(this.outbox.filter((m) => m.propertyId === propertyId).map(({ propertyId: _p, dedupeKey: _d, telefono: _t, ...m }) => m).reverse());
  }
}
