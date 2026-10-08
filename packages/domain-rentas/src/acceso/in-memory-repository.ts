// Doble en memoria del repositorio de acceso. `siguienteLiberacion` NO re-implementa la
// ventana/pago (eso es SQL, verificado contra Postgres real en
// scripts/verify-rentas-reportes-acceso): entrega las `pendientes` sembradas que no estén
// excluidas ni ya liberadas. Sí modela la idempotencia, el dedupe de la bitácora y la
// disponibilidad de la migración.
import { accesoAad } from "./cipher.ts";
import type { AccesoCipher, CampoAcceso } from "./cipher.ts";
import { AccesoNoDisponibleError } from "./errores.ts";
import type { RentasAccesoRepository } from "./repository.ts";
import { POLITICA_ACCESO_POR_DEFECTO } from "./tipos.ts";
import type { ResumenBarridoCifrado, EventoAccesoRecord, ReservaAccesoRecord, EventoOmitidoAcceso, InstruccionAcceso, LiberacionPendiente, PendienteEntregaOta, PoliticaAcceso, ReservaParaMensajeOta, ResultadoAcceso, ResultadoConfirmarPago, ResultadoEntregaManual } from "./tipos.ts";
import type { EntradaInstruccion, EntradaPolitica } from "./validacion.ts";

/** Fila como la guarda la base tras la migracion 028: SOLO sobres cifrados (nunca el texto plano). */
interface FilaInstruccion {
  readonly unidadId: string;
  readonly propertyId: string;
  readonly direccionCifrada: string;
  readonly codigoCifrado: string | null;
  readonly instruccionesCifradas: string | null;
}

export class InMemoryRentasAccesoRepository implements RentasAccesoRepository {
  /** Sin `cipher` el doble se comporta como la API sin RENTAS_ACCESS_KEY: leer/escribir/cifrar lanzan `AccesoNoDisponibleError`. */
  constructor(private readonly cipher: AccesoCipher | null = null) {}

  private exigirCipher(): AccesoCipher {
    if (!this.cipher) throw new AccesoNoDisponibleError("llave_no_configurada");
    return this.cipher;
  }

  /** Bitacora de lecturas/escrituras de instrucciones (sin contenido). */
  readonly bitacoraInstrucciones: { unidadId: string; evento: "lectura_admin" | "escritura_admin" | "cifrado_inicial" }[] = [];
  /** Filas heredadas en texto plano (previas a la migracion 028), pendientes de barrido. */
  readonly instruccionesHeredadas = new Map<string, InstruccionAcceso & { propertyId: string }>();
  migracion025Disponible = true;
  readonly pendientes: LiberacionPendiente[] = [];
  readonly liberadas = new Set<string>();
  readonly pagosConfirmados = new Set<string>();
  readonly reservasConocidas = new Set<string>();
  readonly politicas = new Map<string, PoliticaAcceso>();
  /** Lo que hay en la "base": solo sobres. */
  readonly instrucciones = new Map<string, FilaInstruccion>();
  readonly unidadesPorProperty = new Map<string, Set<string>>();
  readonly bitacora: (EventoAccesoRecord & { propertyId: string })[] = [];
  /** Llamadas hechas al motor (para afirmar que un camino no llegó a tocarlo). */
  readonly llamadas: string[] = [];
  private seq = 0;

  private requiere(): void {
    if (!this.migracion025Disponible) {
      const e = new Error("function rentas.acceso_siguiente_liberacion(uuid[], timestamp with time zone) does not exist") as Error & { code: string };
      e.code = "42883";
      throw e;
    }
  }

  async obtenerPolitica(propertyId: string): Promise<ResultadoAcceso<PoliticaAcceso | null>> {
    if (!this.migracion025Disponible) return { disponible: false };
    return { disponible: true, valor: this.politicas.get(propertyId) ?? null };
  }

  async guardarPolitica(_org: string, propertyId: string, entrada: EntradaPolitica): Promise<ResultadoAcceso<PoliticaAcceso>> {
    if (!this.migracion025Disponible) return { disponible: false };
    const p: PoliticaAcceso = { propertyId, ...entrada };
    this.politicas.set(propertyId, p);
    return { disponible: true, valor: p };
  }

  private sobre(unidadId: string, propertyId: string, campo: CampoAcceso, v: string | null): string | null {
    return v === null ? null : this.exigirCipher().encrypt(v, accesoAad(unidadId, propertyId, campo));
  }

  async obtenerInstruccion(propertyId: string, unidadId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>> {
    const cipher = this.exigirCipher();
    if (!this.migracion025Disponible) return { disponible: false };
    const f = this.instrucciones.get(unidadId);
    if (f && f.propertyId === propertyId) {
      this.bitacoraInstrucciones.push({ unidadId, evento: "lectura_admin" });
      return {
        disponible: true,
        valor: {
          unidadId,
          direccionExacta: cipher.decrypt(f.direccionCifrada, accesoAad(unidadId, propertyId, "direccion")),
          codigoAcceso: f.codigoCifrado === null ? null : cipher.decrypt(f.codigoCifrado, accesoAad(unidadId, propertyId, "codigo")),
          instrucciones: f.instruccionesCifradas === null ? null : cipher.decrypt(f.instruccionesCifradas, accesoAad(unidadId, propertyId, "instrucciones")),
        },
      };
    }
    const h = this.instruccionesHeredadas.get(unidadId);
    if (h && h.propertyId === propertyId) return { disponible: true, valor: { unidadId, direccionExacta: h.direccionExacta, codigoAcceso: h.codigoAcceso, instrucciones: h.instrucciones } };
    return { disponible: true, valor: null };
  }

  async guardarInstruccion(_org: string, propertyId: string, unidadId: string, entrada: EntradaInstruccion): Promise<ResultadoAcceso<InstruccionAcceso | null>> {
    this.exigirCipher();
    if (!this.migracion025Disponible) return { disponible: false };
    if (!this.unidadesPorProperty.get(propertyId)?.has(unidadId)) return { disponible: true, valor: null };
    this.instrucciones.set(unidadId, {
      unidadId,
      propertyId,
      direccionCifrada: this.sobre(unidadId, propertyId, "direccion", entrada.direccionExacta)!,
      codigoCifrado: this.sobre(unidadId, propertyId, "codigo", entrada.codigoAcceso),
      instruccionesCifradas: this.sobre(unidadId, propertyId, "instrucciones", entrada.instrucciones),
    });
    this.instruccionesHeredadas.delete(unidadId);
    this.bitacoraInstrucciones.push({ unidadId, evento: "escritura_admin" });
    return { disponible: true, valor: { unidadId, ...entrada } };
  }

  async cifrarPendientes(limite: number): Promise<ResumenBarridoCifrado> {
    this.exigirCipher();
    if (!this.migracion025Disponible) return { disponible: false, cifradas: 0, fallidas: 0 };
    let cifradas = 0;
    for (const [unidadId, h] of [...this.instruccionesHeredadas].slice(0, limite)) {
      this.instrucciones.set(unidadId, {
        unidadId,
        propertyId: h.propertyId,
        direccionCifrada: this.sobre(unidadId, h.propertyId, "direccion", h.direccionExacta)!,
        codigoCifrado: this.sobre(unidadId, h.propertyId, "codigo", h.codigoAcceso),
        instruccionesCifradas: this.sobre(unidadId, h.propertyId, "instrucciones", h.instrucciones),
      });
      this.instruccionesHeredadas.delete(unidadId);
      this.bitacoraInstrucciones.push({ unidadId, evento: "cifrado_inicial" });
      cifradas += 1;
    }
    return { disponible: true, cifradas, fallidas: 0 };
  }

  async confirmarPago(ocupacionId: string, confirmado: boolean): Promise<ResultadoConfirmarPago> {
    if (!this.migracion025Disponible) return "no_disponible";
    if (!this.reservasConocidas.has(ocupacionId)) return "no_encontrada";
    if (confirmado) this.pagosConfirmados.add(ocupacionId);
    else this.pagosConfirmados.delete(ocupacionId);
    return confirmado ? "confirmado" : "revocado";
  }

  async listarBitacora(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly EventoAccesoRecord[]>> {
    if (!this.migracion025Disponible) return { disponible: false };
    return { disponible: true, valor: this.bitacora.filter((b) => b.propertyId === propertyId).slice(-limite).reverse() };
  }

  readonly reservasProximas: Omit<ReservaAccesoRecord, "pagoConfirmado" | "liberada">[] = [];

  async listarReservasProximas(_propertyId: string, limite: number): Promise<ResultadoAcceso<readonly ReservaAccesoRecord[]>> {
    if (!this.migracion025Disponible) return { disponible: false };
    return { disponible: true, valor: this.reservasProximas.slice(0, limite).map((r) => ({ ...r, pagoConfirmado: this.pagosConfirmados.has(r.ocupacionId), liberada: this.liberadas.has(r.ocupacionId) })) };
  }

  /** Rn-P3-09: reservas sembradas por el test para el mensaje manual (la base real las lee de rentas.ocupacion). */
  readonly reservasParaMensaje = new Map<string, ReservaParaMensajeOta & { propertyId: string }>();
  /** Avisos in-app emitidos por la corrida (ocupacionId). Modela el dedupe por reserva de core.emit_notification. */
  readonly avisosOmitidaSinContacto: { ocupacionId: string; organizationId: string; propertyId: string }[] = [];
  readonly entregadasManual = new Set<string>();

  async listarPendientesEntrega(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly PendienteEntregaOta[]>> {
    if (!this.migracion025Disponible) return { disponible: false };
    const omitidas = this.bitacora.filter((b) => b.propertyId === propertyId && b.evento === "omitida_sin_contacto");
    const filas: PendienteEntregaOta[] = [];
    for (const r of this.reservasProximas) {
      const o = omitidas.filter((b) => b.ocupacionId === r.ocupacionId).at(-1);
      if (!o || this.liberadas.has(r.ocupacionId) || this.entregadasManual.has(r.ocupacionId)) continue;
      filas.push({ ocupacionId: r.ocupacionId, unidadId: r.unidadId, unidadNombre: r.unidadNombre, canal: r.canal, checkIn: r.checkIn, checkOut: r.checkOut, huespedNombre: r.huespedNombre, omitidaEn: o.creadoEn });
    }
    return { disponible: true, valor: filas.slice(0, limite) };
  }

  async obtenerReservaParaMensaje(propertyId: string, ocupacionId: string): Promise<ResultadoAcceso<ReservaParaMensajeOta | null>> {
    if (!this.migracion025Disponible) return { disponible: false };
    const r = this.reservasParaMensaje.get(ocupacionId);
    if (!r || r.propertyId !== propertyId) return { disponible: true, valor: null };
    const { propertyId: _p, ...valor } = r;
    return { disponible: true, valor };
  }

  async marcarEntregadaManual(ocupacionId: string, propertyId: string): Promise<ResultadoEntregaManual> {
    if (!this.migracion025Disponible) return "no_disponible";
    if (!this.reservasConocidas.has(ocupacionId)) return "no_encontrada";
    const propiedad = this.propertyDeReserva(ocupacionId);
    if (propiedad !== "" && propiedad !== propertyId) return "no_encontrada";
    if (this.entregadasManual.has(ocupacionId) || this.liberadas.has(ocupacionId)) return "ya_entregada";
    this.entregadasManual.add(ocupacionId);
    const r = this.reservasProximas.find((x) => x.ocupacionId === ocupacionId);
    this.bitacora.push({ id: `b${++this.seq}`, propertyId: r ? this.propertyDeReserva(ocupacionId) : "", ocupacionId, evento: "entregada_manual", canal: null, creadoEn: new Date().toISOString() });
    return "entregada";
  }

  private propertyDeReserva(ocupacionId: string): string {
    return this.reservasParaMensaje.get(ocupacionId)?.propertyId ?? this.pendientes.find((x) => x.ocupacionId === ocupacionId)?.propertyId ?? "";
  }

  async avisarOmitidaSinContacto(ocupacionId: string, organizationId: string, propertyId: string): Promise<boolean> {
    this.llamadas.push("avisarOmitidaSinContacto");
    if (this.avisosOmitidaSinContacto.some((a) => a.ocupacionId === ocupacionId)) return false;
    this.avisosOmitidaSinContacto.push({ ocupacionId, organizationId, propertyId });
    return true;
  }

  async siguienteLiberacion(excluir: readonly string[]): Promise<LiberacionPendiente | null> {
    this.llamadas.push("siguienteLiberacion");
    this.requiere();
    return this.pendientes.find((p) => !this.liberadas.has(p.ocupacionId) && !this.entregadasManual.has(p.ocupacionId) && !excluir.includes(p.ocupacionId)) ?? null;
  }

  async marcarLiberada(ocupacionId: string): Promise<boolean> {
    this.llamadas.push("marcarLiberada");
    this.requiere();
    if (this.liberadas.has(ocupacionId)) return false;
    this.liberadas.add(ocupacionId);
    const p = this.pendientes.find((x) => x.ocupacionId === ocupacionId);
    this.bitacora.push({ id: `b${++this.seq}`, propertyId: p?.propertyId ?? "", ocupacionId, evento: "liberada", canal: "email", creadoEn: new Date().toISOString() });
    return true;
  }

  async registrarEvento(ocupacionId: string, evento: EventoOmitidoAcceso): Promise<boolean> {
    this.llamadas.push(`registrarEvento:${evento}`);
    this.requiere();
    if (this.bitacora.some((b) => b.ocupacionId === ocupacionId && b.evento === evento)) return false;
    const p = this.pendientes.find((x) => x.ocupacionId === ocupacionId);
    this.bitacora.push({ id: `b${++this.seq}`, propertyId: p?.propertyId ?? "", ocupacionId, evento, canal: null, creadoEn: new Date().toISOString() });
    return true;
  }
}

export { POLITICA_ACCESO_POR_DEFECTO };
