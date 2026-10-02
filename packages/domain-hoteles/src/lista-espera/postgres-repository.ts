// Adaptador Postgres de la lista de espera (H-12) sobre `TenantDbSession` (auth.uid() real; RLS y GRANT de columna de la
// migracion 041). REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es UNA transaccion por request; un error de
// Postgres (42P01 si la 041 no esta aplicada) la dejaria ABORTADA (25P02). Toda consulta corre dentro de
// `runWithSavepointFallback`: las lecturas degradan (lista vacia + `disponible:false`) y las escrituras lanzan
// `ListaEsperaUnavailableError` (503) con la sesion todavia utilizable.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { ListaEsperaRepository } from "./repository.ts";
import {
  ListaEsperaAccessDeniedError,
  ListaEsperaConflictError,
  ListaEsperaInvalidInputError,
  ListaEsperaNotFoundError,
  ListaEsperaUnavailableError,
  type EntradaListaEspera,
  type EstadoListaEspera,
  type ListadoListaEspera,
  type NuevaEntradaListaEspera,
} from "./tipos.ts";

const COLUMNAS = `id, property_id, room_type_id, check_in_date::text as check_in_date, check_out_date::text as check_out_date, guests, guest_name,
  contact_phone, contact_email, notes, status, offered_at, offer_expires_at, reservation_id, created_at`;

interface Fila {
  id: string;
  property_id: string;
  room_type_id: string;
  check_in_date: string;
  check_out_date: string;
  guests: number;
  guest_name: string;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  status: EstadoListaEspera;
  offered_at: Date | string | null;
  offer_expires_at: Date | string | null;
  reservation_id: string | null;
  created_at: Date | string;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function mapFila(r: Fila): EntradaListaEspera {
  return {
    id: r.id,
    propertyId: r.property_id,
    roomTypeId: r.room_type_id,
    checkInDate: r.check_in_date,
    checkOutDate: r.check_out_date,
    huespedes: r.guests,
    nombre: r.guest_name,
    telefono: r.contact_phone,
    email: r.contact_email,
    notas: r.notes,
    estado: r.status,
    ofrecidaEn: iso(r.offered_at),
    ofertaVenceEn: iso(r.offer_expires_at),
    reservaId: r.reservation_id,
    creadaEn: iso(r.created_at) as string,
  };
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function pgMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z_]+:\s*/, "");
}
function pgPrefix(err: unknown): string {
  const m = (err instanceof Error ? err.message : "").match(/^([a-z_]+):/);
  return m ? (m[1] as string) : "";
}

/** Traduce un error de Postgres de la lista de espera a un error de dominio tipado (nunca un 500 crudo). */
export function mapListaEsperaPgError(err: unknown, operation: string): unknown {
  if (
    err instanceof ListaEsperaAccessDeniedError ||
    err instanceof ListaEsperaConflictError ||
    err instanceof ListaEsperaInvalidInputError ||
    err instanceof ListaEsperaNotFoundError ||
    err instanceof ListaEsperaUnavailableError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new ListaEsperaUnavailableError(operation);
  switch (pgCode(err)) {
    case "42501":
      return new ListaEsperaAccessDeniedError();
    case "22023":
    case "23514":
      return new ListaEsperaInvalidInputError(pgCode(err) === "23514" ? "Datos invalidos: revisa fechas, huespedes y que haya telefono o correo." : pgMessage(err));
    case "55000": {
      const p = pgPrefix(err);
      return new ListaEsperaConflictError(pgMessage(err), p === "oferta_vencida" || p === "oferta_vigente" || p === "transicion_invalida" ? p : "estado_invalido");
    }
    default:
      return err;
  }
}

export class PostgresListaEsperaRepository implements ListaEsperaRepository {
  constructor(private readonly db: TenantDbSession) {}

  private escribir<T>(operation: string, run: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: run,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapListaEsperaPgError(err, operation);
      },
    });
  }

  async listar(propertyId: string, estado: EstadoListaEspera | null): Promise<ListadoListaEspera> {
    return runWithSavepointFallback<ListadoListaEspera>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<Fila>(
          `select ${COLUMNAS} from hoteles.waitlist_entry where property_id = $1 and ($2::text is null or status = $2)
            order by created_at asc limit 500;`,
          [propertyId, estado],
        );
        return { disponible: true, entradas: rows.map(mapFila) };
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => ({ disponible: false, entradas: [] }),
    });
  }

  async buscar(propertyId: string, id: string): Promise<EntradaListaEspera | null> {
    return this.escribir("consultar la lista de espera", async () => {
      const { rows } = await this.db.query<Fila>(`select ${COLUMNAS} from hoteles.waitlist_entry where id = $1 and property_id = $2 for update;`, [id, propertyId]);
      return rows[0] ? mapFila(rows[0]) : null;
    });
  }

  async crear(i: NuevaEntradaListaEspera): Promise<EntradaListaEspera> {
    return this.escribir("agregar a la lista de espera", async () => {
      const { rows } = await this.db.query<Fila>(
        `insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guests, guest_name, contact_phone, contact_email, notes)
         values ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9) returning ${COLUMNAS};`,
        [i.propertyId, i.roomTypeId, i.checkInDate, i.checkOutDate, i.huespedes, i.nombre, i.telefono, i.email, i.notas],
      );
      return mapFila(rows[0] as Fila);
    });
  }

  private async transicion(propertyId: string, id: string, set: string, params: unknown[], operation: string): Promise<EntradaListaEspera> {
    return this.escribir(operation, async () => {
      const { rows } = await this.db.query<Fila>(`update hoteles.waitlist_entry set ${set} where id = $1 and property_id = $2 returning ${COLUMNAS};`, [id, propertyId, ...params]);
      if (!rows[0]) throw new ListaEsperaNotFoundError("Entrada de la lista de espera");
      return mapFila(rows[0]);
    });
  }

  cancelar(propertyId: string, id: string): Promise<EntradaListaEspera> {
    return this.transicion(propertyId, id, `status = 'cancelada'`, [], "cancelar la entrada");
  }

  ofrecer(propertyId: string, id: string, venceEn: Date): Promise<EntradaListaEspera> {
    return this.transicion(propertyId, id, `status = 'ofrecida', offer_expires_at = $3::timestamptz`, [venceEn.toISOString()], "ofrecer lugar");
  }

  marcarAceptada(propertyId: string, id: string, reservationId: string): Promise<EntradaListaEspera> {
    return this.transicion(propertyId, id, `status = 'aceptada', reservation_id = $3::uuid`, [reservationId], "aceptar la oferta");
  }

  async expirarVencidas(propertyId: string, ahora: Date): Promise<number> {
    return runWithSavepointFallback<number>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `update hoteles.waitlist_entry set status = 'expirada'
            where property_id = $1 and status = 'ofrecida' and offer_expires_at <= least($2::timestamptz, now()) returning id;`,
          [propertyId, ahora.toISOString()],
        );
        return rows.length;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => 0,
    });
  }

  async listarActivasCompatibles(propertyId: string, roomTypeId: string, desde: string, hasta: string): Promise<readonly EntradaListaEspera[]> {
    return runWithSavepointFallback<readonly EntradaListaEspera[]>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<Fila>(
          `select ${COLUMNAS} from hoteles.waitlist_entry
            where property_id = $1 and room_type_id = $2 and status = 'activa' and check_in_date < $4::date and check_out_date > $3::date
            order by created_at asc, id asc limit 100;`,
          [propertyId, roomTypeId, desde, hasta],
        );
        return rows.map(mapFila);
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => [],
    });
  }
}
