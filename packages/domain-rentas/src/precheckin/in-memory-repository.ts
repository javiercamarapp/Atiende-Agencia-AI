// Doble en memoria del pre-check-in. Reproduce la maquina de estados de las funciones SQL (migracion 036) para poder probar el servicio y la
// API sin Postgres: bloqueo tras 5 fallos por codigo, token de un solo uso y vigencia, no sobrescribir una captura ni un correo del staff.
// Lo que SOLO prueba Postgres real (RLS, GRANT, definer) vive en scripts/verify-rentas-precheckin.
import type { RentasPrecheckinRepository } from "./repository.ts";
import { PRECHECKIN_BLOQUEO_MINUTOS, PRECHECKIN_MAX_FALLOS, PRECHECKIN_TOKEN_MINUTOS } from "./tipos.ts";
import type { ConfigPrecheckin, EntradaCapturaDb, InfoPrecheckin, ResultadoCapturaDb, ResultadoPrecheckin, VerificacionPrecheckinDb } from "./tipos.ts";

export interface ReservaPrecheckinSembrada {
  readonly ocupacionId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly codigo: string;
  readonly ultimos4: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly estado?: "confirmado" | "cancelado" | "provisional";
  readonly unidadNombre?: string;
  /** Correo que el staff ya tenia (nunca se sobrescribe). */
  readonly contacto?: string | null;
}

interface Intento {
  fallos: number;
  ventanaInicio: number;
  bloqueadoHasta: number | null;
}

interface Token {
  readonly ocupacionId: string;
  readonly expiraEn: number;
  usado: boolean;
}

export interface CapturaGuardada {
  readonly ocupacionId: string;
  readonly correo: string;
  readonly correoGuardadoEnHuesped: boolean;
  readonly whatsapp: string | null;
  readonly avisoVersion: string;
  readonly reglamentoVersion: number | null;
}

const HORA_MS = 3_600_000;

export class InMemoryRentasPrecheckinRepository implements RentasPrecheckinRepository {
  migracion036Disponible = true;
  readonly reservas = new Map<string, ReservaPrecheckinSembrada>();
  readonly propiedades = new Map<string, { propiedadNombre: string; organizacionNombre: string }>();
  readonly configs = new Map<string, ConfigPrecheckin>();
  readonly intentos = new Map<string, Intento>();
  readonly tokens = new Map<string, Token>();
  readonly capturas = new Map<string, CapturaGuardada>();
  /** Contacto por reserva tras capturar (equivale a rentas.guest_minimo.contacto). */
  readonly contactos = new Map<string, string | null>();
  /** Reloj inyectable: las pruebas fijan el tiempo. */
  ahora: () => number = () => Date.now();
  /** Cuenta de llamadas para afirmar que un camino no llego a tocar el repositorio. */
  readonly llamadas: string[] = [];

  sembrarPropiedad(propertyId: string, propiedadNombre = "Casa de Prueba", organizacionNombre = "Gestora de Prueba"): void {
    this.propiedades.set(propertyId, { propiedadNombre, organizacionNombre });
  }

  sembrarReserva(r: ReservaPrecheckinSembrada): void {
    this.reservas.set(r.ocupacionId, r);
    this.contactos.set(r.ocupacionId, r.contacto ?? null);
  }

  private hoy(): string {
    return new Date(this.ahora()).toISOString().slice(0, 10);
  }

  async obtenerInfo(propertyId: string): Promise<ResultadoPrecheckin<InfoPrecheckin | null>> {
    this.llamadas.push("obtenerInfo");
    if (!this.migracion036Disponible) return { disponible: false };
    const p = this.propiedades.get(propertyId);
    if (!p) return { disponible: true, valor: null };
    const c = this.configs.get(propertyId);
    return { disponible: true, valor: { ...p, reglamento: c?.reglamento ?? null, reglamentoVersion: c?.reglamentoVersion ?? 1 } };
  }

  async verificar(propertyId: string, codigo: string, ultimos4: string, claveHash: string, tokenHash: string): Promise<ResultadoPrecheckin<VerificacionPrecheckinDb>> {
    this.llamadas.push("verificar");
    if (!this.migracion036Disponible) return { disponible: false };
    const vacio = { propiedadNombre: null, unidadNombre: null, checkIn: null, checkOut: null, yaCapturado: false, tokenExpiraEn: null };
    const prop = this.propiedades.get(propertyId);
    if (!prop) return { disponible: true, valor: { resultado: "invalido", ...vacio } };
    const t = this.ahora();
    const k = `${propertyId}:${claveHash}`;
    const previo = this.intentos.get(k);
    if (previo?.bloqueadoHasta && previo.bloqueadoHasta > t) return { disponible: true, valor: { resultado: "bloqueado", ...vacio } };
    const r = [...this.reservas.values()]
      .filter((x) => x.propertyId === propertyId && (x.estado ?? "confirmado") === "confirmado" && x.codigo.toUpperCase() === codigo.toUpperCase() && x.ultimos4 === ultimos4 && x.checkOut > this.hoy())
      .sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0];
    if (!r) {
      const reinicia = !previo || previo.ventanaInicio < t - HORA_MS;
      const fallos = reinicia ? 1 : previo.fallos + 1;
      this.intentos.set(k, { fallos, ventanaInicio: reinicia ? t : previo.ventanaInicio, bloqueadoHasta: fallos >= PRECHECKIN_MAX_FALLOS ? t + PRECHECKIN_BLOQUEO_MINUTOS * 60_000 : null });
      return { disponible: true, valor: { resultado: "invalido", ...vacio } };
    }
    this.intentos.delete(k);
    const expiraEn = t + PRECHECKIN_TOKEN_MINUTOS * 60_000;
    this.tokens.set(tokenHash, { ocupacionId: r.ocupacionId, expiraEn, usado: false });
    return {
      disponible: true,
      valor: { resultado: "ok", propiedadNombre: prop.propiedadNombre, unidadNombre: r.unidadNombre ?? "Unidad", checkIn: r.checkIn, checkOut: r.checkOut, yaCapturado: this.capturas.has(r.ocupacionId), tokenExpiraEn: new Date(expiraEn).toISOString() },
    };
  }

  async capturar(e: EntradaCapturaDb): Promise<ResultadoPrecheckin<{ readonly resultado: ResultadoCapturaDb }>> {
    this.llamadas.push("capturar");
    if (!this.migracion036Disponible) return { disponible: false };
    const ok = (resultado: ResultadoCapturaDb): ResultadoPrecheckin<{ readonly resultado: ResultadoCapturaDb }> => ({ disponible: true, valor: { resultado } });
    const tok = this.tokens.get(e.tokenHash);
    if (!tok || tok.usado || tok.expiraEn <= this.ahora()) return ok("token_invalido");
    if (!e.aceptaPrivacidad) return ok("privacidad_requerida");
    const r = this.reservas.get(tok.ocupacionId)!;
    const cfg = this.configs.get(r.propertyId);
    if (cfg?.reglamento && !e.aceptaReglamento) return ok("reglamento_requerido");
    tok.usado = true;
    if ((r.estado ?? "confirmado") !== "confirmado" || r.checkOut <= this.hoy()) return ok("token_invalido");
    if (this.capturas.has(r.ocupacionId)) return ok("ya_capturado");
    const actual = this.contactos.get(r.ocupacionId) ?? null;
    const guardaCorreo = actual === null || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actual);
    if (guardaCorreo) this.contactos.set(r.ocupacionId, e.correo);
    this.capturas.set(r.ocupacionId, {
      ocupacionId: r.ocupacionId,
      correo: e.correo,
      correoGuardadoEnHuesped: guardaCorreo,
      whatsapp: e.whatsapp,
      avisoVersion: e.avisoVersion,
      reglamentoVersion: cfg?.reglamento ? cfg.reglamentoVersion : null,
    });
    return ok("ok");
  }

  async obtenerConfig(propertyId: string): Promise<ResultadoPrecheckin<ConfigPrecheckin>> {
    if (!this.migracion036Disponible) return { disponible: false };
    return { disponible: true, valor: this.configs.get(propertyId) ?? { propertyId, reglamento: null, reglamentoVersion: 1 } };
  }

  async guardarReglamento(_org: string, propertyId: string, reglamento: string | null, _actorId: string): Promise<ResultadoPrecheckin<ConfigPrecheckin>> {
    if (!this.migracion036Disponible) return { disponible: false };
    const previa = this.configs.get(propertyId);
    const version = previa ? (previa.reglamento !== reglamento ? previa.reglamentoVersion + 1 : previa.reglamentoVersion) : 1;
    const nueva = { propertyId, reglamento, reglamentoVersion: version };
    this.configs.set(propertyId, nueva);
    return { disponible: true, valor: nueva };
  }
}
