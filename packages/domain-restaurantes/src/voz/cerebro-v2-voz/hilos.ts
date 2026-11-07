// Estado por LLAMADA del turno de voz (tabla restaurantes.voz_turno_hilo, migracion 191): historial, idempotencia por seq, marca «en proceso» y
// compare-and-swap por version. Repositorio Postgres (SAVEPOINT contra la base sin migrar) y uno en memoria para pruebas y el simulador.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";

export interface MensajeHiloVoz {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** Lo que el worker recibe (contrato de voz-turno). */
export interface RespuestaVozTurno {
  readonly texto: string;
  readonly pedido_id: string | null;
  readonly fin: boolean;
  readonly turno: number;
  /** Solo en una apertura REPETIDA: ultimo seq procesado; el worker sigue desde seq_ultimo + 1. */
  readonly seq_ultimo?: number;
}

export interface HiloVoz {
  readonly organizationId: string;
  readonly callId: string;
  readonly propertyId: string | null;
  readonly telefono: string;
  readonly mensajes: readonly MensajeHiloVoz[];
  readonly pedidoId: string | null;
  readonly turnos: number;
  readonly seqUltimo: number;
  readonly respuestaUltima: RespuestaVozTurno | null;
  readonly version: number;
  readonly fallosSeguidos: number;
  readonly enProcesoSeq: number | null;
  readonly enProcesoDesde: Date | null;
}

/** Campos que escribe un turno (crear o avanzar). */
export interface CambioHiloVoz {
  readonly propertyId: string | null;
  readonly telefono: string;
  readonly mensajes: readonly MensajeHiloVoz[];
  readonly pedidoId: string | null;
  readonly turnos: number;
  readonly seqUltimo: number;
  readonly respuestaUltima: RespuestaVozTurno | null;
  readonly fallosSeguidos: number;
  readonly enProcesoSeq: number | null;
  readonly enProcesoDesde: Date | null;
  readonly ahora: Date;
}

/** La migracion 191 no esta aplicada (42P01/42703/42883): el turno de voz responde 503 con fin, nunca 500. */
export class VozTurnoNoDisponibleError extends Error {
  constructor() {
    super("voz por turno no disponible aun: requiere la migracion 191 (restaurantes.voz_turno_hilo)");
  }
}

export interface RepositorioHilosVoz {
  leer(organizationId: string, callId: string): Promise<HiloVoz | null>;
  /** Crea el hilo; `false` si ya existia (otra peticion de la misma llamada se adelanto). */
  crear(organizationId: string, callId: string, cambio: CambioHiloVoz): Promise<boolean>;
  /** Avanza el hilo solo si sigue en `versionEsperada` (queda en versionEsperada + 1); `false` = otra peticion escribio antes. */
  avanzar(organizationId: string, callId: string, versionEsperada: number, cambio: CambioHiloVoz): Promise<boolean>;
}

const CODIGOS_SIN_MIGRAR = ["42P01", "42703", "42883"];
const codigo = (err: unknown): string | undefined => (err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : undefined);
export const esBaseSinMigrarVoz = (err: unknown): boolean => CODIGOS_SIN_MIGRAR.includes(codigo(err) ?? "");

interface FilaHilo {
  organization_id: string;
  call_id: string;
  property_id: string | null;
  telefono: string;
  mensajes: unknown;
  pedido_id: string | null;
  turnos: number;
  seq_ultimo: number;
  respuesta_ultima: unknown;
  version: number;
  fallos_seguidos: number;
  en_proceso_seq: number | null;
  en_proceso_desde: string | Date | null;
}

function aMensajes(v: unknown): MensajeHiloVoz[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((m) => {
    if (!m || typeof m !== "object") return [];
    const { role, content } = m as { role?: unknown; content?: unknown };
    return (role === "user" || role === "assistant" || role === "system") && typeof content === "string" ? [{ role, content }] : [];
  });
}

function aRespuesta(v: unknown): RespuestaVozTurno | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.texto !== "string" || typeof r.turno !== "number" || typeof r.fin !== "boolean") return null;
  return { texto: r.texto, pedido_id: typeof r.pedido_id === "string" ? r.pedido_id : null, fin: r.fin, turno: r.turno, ...(typeof r.seq_ultimo === "number" ? { seq_ultimo: r.seq_ultimo } : {}) };
}

function aHilo(f: FilaHilo): HiloVoz {
  return {
    organizationId: f.organization_id,
    callId: f.call_id,
    propertyId: f.property_id,
    telefono: f.telefono,
    mensajes: aMensajes(f.mensajes),
    pedidoId: f.pedido_id,
    turnos: Number(f.turnos),
    seqUltimo: Number(f.seq_ultimo),
    respuestaUltima: aRespuesta(f.respuesta_ultima),
    version: Number(f.version),
    fallosSeguidos: Number(f.fallos_seguidos),
    enProcesoSeq: f.en_proceso_seq === null ? null : Number(f.en_proceso_seq),
    enProcesoDesde: f.en_proceso_desde === null ? null : new Date(f.en_proceso_desde),
  };
}

/** Repositorio real. Cada operacion corre en SAVEPOINT: la base sin la 191 lanza VozTurnoNoDisponibleError con la sesion utilizable. */
export class PostgresHilosVozRepository implements RepositorioHilosVoz {
  constructor(private readonly db: TenantDbSession) {}

  private conFallback<T>(primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      primary,
      isRecoverable: esBaseSinMigrarVoz,
      fallback: async () => {
        throw new VozTurnoNoDisponibleError();
      },
    });
  }

  leer(organizationId: string, callId: string): Promise<HiloVoz | null> {
    return this.conFallback(async () => {
      const { rows } = await this.db.query<FilaHilo>(
        `select organization_id, call_id, property_id, telefono, mensajes, pedido_id, turnos, seq_ultimo, respuesta_ultima, version, fallos_seguidos, en_proceso_seq, en_proceso_desde
           from restaurantes.voz_turno_hilo where organization_id = $1 and call_id = $2;`,
        [organizationId, callId],
      );
      return rows[0] ? aHilo(rows[0]) : null;
    });
  }

  crear(organizationId: string, callId: string, c: CambioHiloVoz): Promise<boolean> {
    return this.conFallback(async () => {
      const { rows } = await this.db.query<{ call_id: string }>(
        `insert into restaurantes.voz_turno_hilo (organization_id, call_id, property_id, telefono, mensajes, pedido_id, turnos, seq_ultimo, respuesta_ultima, version, fallos_seguidos, en_proceso_seq, en_proceso_desde, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, 1, $10, $11, $12, $13)
         on conflict (organization_id, call_id) do nothing returning call_id;`,
        [organizationId, callId, c.propertyId, c.telefono, JSON.stringify(c.mensajes), c.pedidoId, c.turnos, c.seqUltimo, c.respuestaUltima ? JSON.stringify(c.respuestaUltima) : null, c.fallosSeguidos, c.enProcesoSeq, c.enProcesoDesde, c.ahora],
      );
      return rows.length > 0;
    });
  }

  avanzar(organizationId: string, callId: string, versionEsperada: number, c: CambioHiloVoz): Promise<boolean> {
    return this.conFallback(async () => {
      const { rows } = await this.db.query<{ call_id: string }>(
        `update restaurantes.voz_turno_hilo
            set property_id = $4, mensajes = $5::jsonb, pedido_id = $6, turnos = $7, seq_ultimo = $8, respuesta_ultima = $9::jsonb, fallos_seguidos = $10,
                en_proceso_seq = $11, en_proceso_desde = $12, updated_at = $13, version = version + 1
          where organization_id = $1 and call_id = $2 and version = $3 and telefono = $14
          returning call_id;`,
        [organizationId, callId, versionEsperada, c.propertyId, JSON.stringify(c.mensajes), c.pedidoId, c.turnos, c.seqUltimo, c.respuestaUltima ? JSON.stringify(c.respuestaUltima) : null, c.fallosSeguidos, c.enProcesoSeq, c.enProcesoDesde, c.ahora, c.telefono],
      );
      return rows.length > 0;
    });
  }
}

/** Doble en memoria (pruebas, simulador). `migrada = false` reproduce la base sin la 191. */
export class InMemoryHilosVozRepository implements RepositorioHilosVoz {
  migrada = true;
  readonly filas = new Map<string, HiloVoz>();

  private clave(o: string, c: string): string {
    return `${o}|${c}`;
  }
  private exigirMigrada(): void {
    if (!this.migrada) throw new VozTurnoNoDisponibleError();
  }

  async leer(organizationId: string, callId: string): Promise<HiloVoz | null> {
    this.exigirMigrada();
    return this.filas.get(this.clave(organizationId, callId)) ?? null;
  }

  async crear(organizationId: string, callId: string, c: CambioHiloVoz): Promise<boolean> {
    this.exigirMigrada();
    const k = this.clave(organizationId, callId);
    if (this.filas.has(k)) return false;
    this.filas.set(k, { organizationId, callId, ...sinAhora(c), version: 1 });
    return true;
  }

  async avanzar(organizationId: string, callId: string, versionEsperada: number, c: CambioHiloVoz): Promise<boolean> {
    this.exigirMigrada();
    const k = this.clave(organizationId, callId);
    const actual = this.filas.get(k);
    if (!actual || actual.version !== versionEsperada || actual.telefono !== c.telefono) return false;
    this.filas.set(k, { organizationId, callId, ...sinAhora(c), version: versionEsperada + 1 });
    return true;
  }
}

function sinAhora(c: CambioHiloVoz): Omit<HiloVoz, "organizationId" | "callId" | "version"> {
  const { ahora: _ahora, ...resto } = c;
  void _ahora;
  return resto;
}
