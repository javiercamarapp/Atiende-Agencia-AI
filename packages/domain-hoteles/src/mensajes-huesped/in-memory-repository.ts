// H-P3-03 -- doble en memoria de los mensajes al huesped, SOLO para pruebas del dominio y de la API (nunca produccion). Reproduce lo que la
// base decide: la marca de idempotencia por (propiedad, referencia, evento) y que un candidato ya emitido deja de serlo. NO reproduce la
// derivacion del estado real ni la zona horaria (eso lo verifica scripts/verify-hoteles-mensajes-huesped contra Postgres real): las pruebas
// siembran los candidatos ya derivados.
import type { EmitirMensajeEntrada, MensajesHuespedSistemaRepository, MensajesHuespedStaffRepository } from "./repository.ts";
import { claveCatalogoPlantilla, type PlantillaWhatsappAprobada, type PlantillaWhatsappInput, type PlantillaWhatsappRecord } from "./plantillas.ts";
import {
  EVENTOS_MENSAJE_HUESPED,
  MensajesHuespedAccessDeniedError,
  MensajesHuespedUnavailableError,
  activoPorOmision,
  type CandidatoMensajeHuesped,
  type ConfigEventoHuesped,
  type EntradaConfigEvento,
  type EventoMensajeHuesped,
  type FilaHistorialMensaje,
  type ResultadoMensajes,
} from "./tipos.ts";

export interface EnvioEnMemoria extends EmitirMensajeEntrada {
  readonly id: string;
  readonly creadoEn: string;
}

function errorMigracionPendiente(): Error {
  const err = new Error('relation "hoteles.mensaje_huesped_envio" does not exist') as Error & { code: string };
  err.code = "42P01";
  return err;
}

export interface OpcionesInMemoryMensajesHuesped {
  /** `false` = la base no tiene la migracion 046. */
  readonly migrado?: boolean;
  /** `false` = el catalogo de plantillas (migracion 0050) no existe: `resolverPlantilla` devuelve `undefined`. */
  readonly catalogoMigrado?: boolean;
  /** Puede administrar el catalogo de plantillas (owner/admin de la organizacion). */
  readonly puedeAdministrarPlantillas?: boolean;
  readonly puedeConfigurar?: boolean;
  readonly reloj?: () => Date;
}

export class InMemoryMensajesHuespedRepository implements MensajesHuespedSistemaRepository, MensajesHuespedStaffRepository {
  /** Candidatos ya derivados (los siembra la prueba). */
  candidatos: CandidatoMensajeHuesped[] = [];
  /** Si una prueba lo define, REEMPLAZA a `candidatos`: deriva los candidatos del estado de otro doble (p. ej. los holds en memoria). */
  derivador: (() => readonly CandidatoMensajeHuesped[]) | null = null;
  readonly envios: EnvioEnMemoria[] = [];
  /** Mensajes que `emitir` encolo en el outbox (los que llevan payload). */
  readonly outbox: EmitirMensajeEntrada[] = [];
  readonly slugs = new Map<string, string>();
  /** Plantillas del catalogo por (organizacion, evento): `aprobada` marca las que resuelve el sistema. */
  readonly plantillas = new Map<string, PlantillaWhatsappRecord>();
  readonly configs = new Map<string, ConfigEventoHuesped>();
  /** Estado del outbox por id de envio (para el historial): se asigna `pending` al emitir. */
  readonly estadoOutbox = new Map<string, string>();
  private n = 0;

  constructor(private readonly opciones: OpcionesInMemoryMensajesHuesped = {}) {}

  private get migrado(): boolean {
    return this.opciones.migrado !== false;
  }
  private now(): Date {
    return this.opciones.reloj ? this.opciones.reloj() : new Date();
  }
  private claveEnvio(propertyId: string, refTipo: string, refId: string, evento: string): string {
    return `${propertyId}|${refTipo}|${refId}|${evento}`;
  }

  // ---- sistema ----
  async listarCandidatos(_ahora: Date, limite: number, opciones: { readonly propertyId?: string; readonly refId?: string } = {}): Promise<readonly CandidatoMensajeHuesped[]> {
    if (!this.migrado) throw errorMigracionPendiente();
    return (this.derivador ? this.derivador() : this.candidatos)
      .filter((c) => (opciones.propertyId ? c.propertyId === opciones.propertyId : true))
      .filter((c) => (opciones.refId ? c.refId === opciones.refId : true))
      .filter((c) => !this.envios.some((e) => this.claveEnvio(e.propertyId, e.refTipo, e.refId, e.evento) === this.claveEnvio(c.propertyId, c.refTipo, c.refId, c.evento)))
      .filter((c) => this.configs.get(`${c.propertyId}|${c.evento}`)?.activo ?? activoPorOmision(c.evento))
      .slice(0, limite);
  }

  async resolverPlantilla(organizationId: string, evento: EventoMensajeHuesped): Promise<PlantillaWhatsappAprobada | null | undefined> {
    if (this.opciones.catalogoMigrado === false) return undefined;
    const p = this.plantillas.get(`${organizationId}|${evento}`);
    return p && p.estado === "aprobada" ? { name: p.nombre, language: p.idioma, variables: p.variables } : null;
  }

  async emitir(e: EmitirMensajeEntrada): Promise<string | null> {
    if (!this.migrado) throw errorMigracionPendiente();
    if ((e.canal === null) === (e.motivo === null)) throw Object.assign(new Error("se exige exactamente uno de canal o motivo"), { code: "22023" });
    const clave = this.claveEnvio(e.propertyId, e.refTipo, e.refId, e.evento);
    if (this.envios.some((x) => this.claveEnvio(x.propertyId, x.refTipo, x.refId, x.evento) === clave)) return null;
    this.n += 1;
    const id = `00000000-0000-0000-0000-${String(this.n).padStart(12, "0")}`;
    this.envios.push({ ...e, id, creadoEn: this.now().toISOString() });
    if (e.canal !== null && e.payload !== null) {
      this.outbox.push(e);
      this.estadoOutbox.set(id, "pending");
    }
    return id;
  }

  async slugAviso(propertyId: string): Promise<string | null> {
    return this.slugs.get(propertyId) ?? null;
  }

  // ---- staff ----
  async listarConfig(propertyId: string): Promise<ResultadoMensajes<readonly ConfigEventoHuesped[]>> {
    if (!this.migrado) return { disponible: false };
    return {
      disponible: true,
      valor: EVENTOS_MENSAJE_HUESPED.map((evento) => this.configs.get(`${propertyId}|${evento}`) ?? { evento, activo: activoPorOmision(evento), horasAntes: null, resenaUrl: null, configurada: false, actualizadoEn: null }),
    };
  }

  async guardarConfig(propertyId: string, evento: EventoMensajeHuesped, entrada: EntradaConfigEvento): Promise<ConfigEventoHuesped> {
    if (!this.migrado) throw new MensajesHuespedUnavailableError("configurar los mensajes automaticos");
    if (this.opciones.puedeConfigurar === false) throw new MensajesHuespedAccessDeniedError();
    const c: ConfigEventoHuesped = { evento, activo: entrada.activo, horasAntes: entrada.horasAntes, resenaUrl: entrada.resenaUrl, configurada: true, actualizadoEn: this.now().toISOString() };
    this.configs.set(`${propertyId}|${evento}`, c);
    return c;
  }

  async historial(propertyId: string, limite: number): Promise<ResultadoMensajes<readonly FilaHistorialMensaje[]>> {
    if (!this.migrado) return { disponible: false };
    const valor = this.envios
      .filter((e) => e.propertyId === propertyId)
      .slice()
      .reverse()
      .slice(0, limite)
      .map((e): FilaHistorialMensaje => ({
        id: e.id,
        evento: e.evento,
        refTipo: e.refTipo,
        refId: e.refId,
        estado: e.canal === null ? "no_enviado" : "encolado",
        canal: e.canal,
        motivo: e.motivo,
        envio: e.canal !== null && e.payload !== null ? (this.estadoOutbox.get(e.id) ?? "pending") : null,
        errorClase: null,
        creadoEn: e.creadoEn,
      }));
    return { disponible: true, valor };
  }

  async listarPlantillas(organizationId: string): Promise<ResultadoMensajes<readonly PlantillaWhatsappRecord[]>> {
    if (this.opciones.catalogoMigrado === false) return { disponible: false };
    if (this.opciones.puedeAdministrarPlantillas === false) return { disponible: true, valor: [] };
    return { disponible: true, valor: EVENTOS_MENSAJE_HUESPED.flatMap((e) => this.plantillas.get(`${organizationId}|${e}`) ?? []) };
  }

  async guardarPlantilla(organizationId: string, evento: EventoMensajeHuesped, v: PlantillaWhatsappInput): Promise<"saved" | "forbidden" | "unavailable"> {
    if (this.opciones.catalogoMigrado === false) return "unavailable";
    if (this.opciones.puedeAdministrarPlantillas === false) return "forbidden";
    this.plantillas.set(`${organizationId}|${evento}`, { evento, nombre: v.nombre, idioma: v.idioma, variables: v.variables, estado: v.estado, aprobadaEn: v.estado === "aprobada" ? this.now().toISOString() : null, actualizadaEn: this.now().toISOString() });
    return "saved";
  }

  async eliminarPlantilla(organizationId: string, evento: EventoMensajeHuesped): Promise<"deleted" | "not_found" | "forbidden" | "unavailable"> {
    if (this.opciones.catalogoMigrado === false) return "unavailable";
    if (this.opciones.puedeAdministrarPlantillas === false) return "forbidden";
    return this.plantillas.delete(`${organizationId}|${evento}`) ? "deleted" : "not_found";
  }
}

export { claveCatalogoPlantilla };
