// ProductionCfdiFolioReservationStore — adaptador real de `FolioReservationStore`
// (`@atiende/mcp-cfdi`) para `deps.hotelesCfdiPort` = `DualPacCfdiPort(...)`,
// consumido por `production/deps.ts`.
//
// Fix hallazgo auditoría (rubro 6, ALTA) — mismo gap, mismo remedio en espíritu que
// `ProductionHotelesFraudeAuditSink` (`./hoteles-fraude-audit-sink.ts`): un puerto
// definido en un paquete de dominio que necesita persistencia real se implementa
// AQUÍ, en `apps/api/src/production/`, porque es este paquete el que tiene acceso
// al `TenancyEngine` real -- `@atiende/mcp-cfdi` deliberadamente sigue sin ninguna
// dependencia de `pg`/`@atiende/db` (ver su `package.json`: `dependencies: {}`),
// consistente con ser un paquete de puertos/adaptadores puro.
//
// A diferencia de `ProductionHotelesFraudeAuditSink` (sesión de sistema +
// `security definer` porque su tabla SÍ tiene RLS property-scoped),
// `mcp_cfdi.folio_stamp_reservation` NO tiene RLS (ver cabecera de
// `packages/mcp-servers/cfdi/migrations/001_folio_stamp_reservation.sql`): SQL
// directo basta, siempre bajo `engine.withAppSession({ userId: null }, ...)`
// (sesión de SISTEMA, `auth.uid()` NULL) -- este store nunca se llama desde una
// ruta HTTP directamente, solo desde `DualPacCfdiPort.timbrar`, que a su vez es un
// singleton de proceso sin sesión de tenant propia (ver comentario de
// `production/deps.ts` junto a `hotelesCfdiPort`).
//
// Reserva atómica vía el MISMO idiom ya usado por
// `PostgresHotelesRepository.withIdempotency` (`domain-hoteles/src/postgres-repository.ts`):
// `INSERT ... ON CONFLICT DO UPDATE ... WHERE <condición de reclamo>` -- si la
// condición no se cumple, Postgres NO actualiza la fila NI la devuelve en
// `RETURNING`, así que `rows.length === 0` distingue de forma atómica "gané la
// reserva" de "alguien más la tiene viva".
import type { CfdiTimbrado } from "@atiende/mcp-cfdi";
import type { FolioReservationOutcome, FolioReservationStore } from "@atiende/mcp-cfdi";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";

interface StampedFolio {
  readonly timbrado: CfdiTimbrado;
  readonly usedSecondary: boolean;
}

interface ReservationRow {
  readonly status: "pending" | "completed";
  readonly result: StampedFolio | null;
}

export interface ProductionCfdiFolioReservationStoreOptions {
  /** Igual semántica que `InMemoryFolioReservationOptions.staleAfterMs` (ver
   *  `@atiende/mcp-cfdi::shared.ts`) -- cuánto tiempo (ms) se considera viva una
   *  reserva `"pending"` antes de tratarla como abandonada (la instancia
   *  serverless que la tomó murió a medio timbrar) y dejar que un `reserve()`
   *  posterior la reclame. Default 2 minutos, igual que el store en memoria. */
  readonly staleAfterMs?: number;
}

export class ProductionCfdiFolioReservationStore implements FolioReservationStore<StampedFolio> {
  private readonly engine: TenancyEngine;
  private readonly staleAfterMs: number;

  constructor(engine: TenancyEngine, options: ProductionCfdiFolioReservationStoreOptions = {}) {
    this.engine = engine;
    this.staleAfterMs = options.staleAfterMs ?? 2 * 60 * 1000;
  }

  async reserve(folio: string): Promise<FolioReservationOutcome<StampedFolio>> {
    return this.engine.withAppSession({ userId: null }, (session) => this.reserveWithSession(session, folio));
  }

  private async reserveWithSession(session: TenantDbSession, folio: string): Promise<FolioReservationOutcome<StampedFolio>> {
    const claim = await session.query<{ folio: string }>(
      `insert into mcp_cfdi.folio_stamp_reservation (folio, reserved_at, status)
       values ($1, now(), 'pending')
       on conflict (folio) do update
         set reserved_at = now(), status = 'pending', result = null, completed_at = null
         where mcp_cfdi.folio_stamp_reservation.status = 'pending'
           and mcp_cfdi.folio_stamp_reservation.reserved_at < now() - ($2 || ' milliseconds')::interval
       returning folio;`,
      [folio, String(this.staleAfterMs)],
    );
    if (claim.rows.length > 0) return { kind: "reserved" };

    const existing = await session.query<ReservationRow>(`select status, result from mcp_cfdi.folio_stamp_reservation where folio = $1;`, [folio]);
    const row = existing.rows[0];
    if (!row) {
      // La fila que causó el conflicto se liberó (`fail()`, `DELETE`) entre el
      // INSERT y este SELECT -- trátese como si nunca hubiera existido, reintenta
      // una sola vez (mismo criterio que
      // `PostgresHotelesRepository.withIdempotency`/`insertReservation`).
      return this.reserveWithSession(session, folio);
    }
    if (row.status === "completed") {
      // `row.result` nunca es null aquí -- el constraint
      // `folio_stamp_reservation_completed_has_result` de la migración lo garantiza.
      return { kind: "completed", value: row.result as StampedFolio };
    }
    return { kind: "in_progress" };
  }

  async complete(folio: string, value: StampedFolio): Promise<void> {
    await this.engine.withAppSession({ userId: null }, (session) =>
      session.query(
        `update mcp_cfdi.folio_stamp_reservation
         set status = 'completed', result = $2::jsonb, completed_at = now()
         where folio = $1;`,
        [folio, JSON.stringify(value)],
      ),
    );
  }

  async fail(folio: string): Promise<void> {
    await this.engine.withAppSession({ userId: null }, (session) => session.query(`delete from mcp_cfdi.folio_stamp_reservation where folio = $1;`, [folio]));
  }

  async peek(folio: string): Promise<StampedFolio | undefined> {
    const { rows } = await this.engine.withAppSession({ userId: null }, (session) =>
      session.query<ReservationRow>(`select status, result from mcp_cfdi.folio_stamp_reservation where folio = $1;`, [folio]),
    );
    const row = rows[0];
    return row?.status === "completed" && row.result ? row.result : undefined;
  }
}
