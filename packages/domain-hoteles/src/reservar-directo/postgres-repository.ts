// Adaptador Postgres de la reserva directa publica (H-42) sobre `TenantDbSession`. REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la sesion
// es UNA transaccion; un error de Postgres (42P01/42883/42703 si la migracion 044 no esta aplicada) la dejaria ABORTADA (25P02). Toda operacion
// corre dentro de `runWithSavepointFallback`: las lecturas degradan a vacio honesto (`disponible:false`) y las escrituras a
// `ReservasAgenteUnavailableError`. Los errores de regla de negocio (22023/55000/P0001/P0002/42501) se traducen a `ReservasAgenteError` con codigo
// estable, nunca un 500 crudo. El SQL es el MISMO que ejercita scripts/verify-hoteles-reservar-publico contra Postgres real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { PostgresReservasAgenteRepository, mapReservasPgError } from "../reservas-agente/postgres-repository.ts";
import { ReservasAgenteError, ReservasAgenteUnavailableError } from "../reservas-agente/tipos.ts";
import type { HoldStatus, StayOptionsResult } from "../reservas-agente/tipos.ts";
import type { ReservarDirectoRepository } from "./repository.ts";
import type { CreateWebHoldInput, PagoEstado, ReembolsoEstado, RoomNightsDirectas, WebHoldContext, WebHoldRecord, WebPolicyRecord } from "./tipos.ts";

type Num = string | number;

const WEB_HOLD_COLS = `id, property_id, room_type_id, check_in_date::text as check_in_date, check_out_date::text as check_out_date, nights, guests, channel,
       guest_name, contact_phone, currency, net_cents, iva_cents, ish_cents, total_cents, mode, status, expires_at::text as expires_at, payment_link_ref,
       decided_by, decided_at::text as decided_at, decision_reason, reservation_id, created_at::text as created_at,
       guest_email, consent_notice_version, deposit_cents, payment_status, payment_ref, canceled_at::text as canceled_at, cancel_penalty_cents, refund_cents, refund_status`;

interface WebHoldRow {
  id: string; property_id: string; room_type_id: string; check_in_date: string; check_out_date: string; nights: number; guests: number; channel: "web";
  guest_name: string | null; contact_phone: string; currency: "MXN"; net_cents: Num; iva_cents: Num; ish_cents: Num; total_cents: Num;
  mode: "aprobacion_humana" | "link_pago"; status: HoldStatus; expires_at: string; payment_link_ref: string | null; decided_by: string | null;
  decided_at: string | null; decision_reason: string | null; reservation_id: string | null; created_at: string;
  guest_email: string; consent_notice_version: string; deposit_cents: Num; payment_status: PagoEstado; payment_ref: string | null; canceled_at: string | null;
  cancel_penalty_cents: Num | null; refund_cents: Num | null; refund_status: ReembolsoEstado | null;
}

const numOrNull = (v: Num | null): number | null => (v === null || v === undefined ? null : Number(v));

function mapWebHold(r: WebHoldRow): WebHoldRecord {
  return {
    id: r.id, propertyId: r.property_id, roomTypeId: r.room_type_id, checkInDate: r.check_in_date, checkOutDate: r.check_out_date, nights: Number(r.nights),
    guests: Number(r.guests), channel: "web", guestName: r.guest_name, contactPhone: r.contact_phone, currency: r.currency, netCents: Number(r.net_cents),
    ivaCents: Number(r.iva_cents), ishCents: Number(r.ish_cents), totalCents: Number(r.total_cents), mode: r.mode, status: r.status, expiresAt: r.expires_at,
    paymentLinkRef: r.payment_link_ref, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionReason: r.decision_reason, reservationId: r.reservation_id,
    createdAt: r.created_at, guestEmail: r.guest_email, consentNoticeVersion: r.consent_notice_version, depositCents: Number(r.deposit_cents),
    paymentStatus: r.payment_status, paymentRef: r.payment_ref, canceledAt: r.canceled_at, cancelPenaltyCents: numOrNull(r.cancel_penalty_cents),
    refundCents: numOrNull(r.refund_cents), refundStatus: r.refund_status,
  };
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Traduce el error de Postgres. Una reserva que ya no admite cancelacion en linea (check-in o posterior, hold cerrado) es un estado no valido, con mensaje propio. */
function mapWebError(err: unknown, operation: string): unknown {
  if (err instanceof ReservasAgenteError) return err;
  const message = err instanceof Error ? err.message : "";
  if (pgCode(err) === "55000" && message.startsWith("estado_no_cancelable")) {
    return new ReservasAgenteError("estado_no_valido", "La reserva ya no admite cancelacion en linea: contacta al hotel.", { motivo: "no_cancelable" });
  }
  return mapReservasPgError(err, operation);
}

export class PostgresReservarDirectoRepository implements ReservarDirectoRepository {
  private readonly agente: PostgresReservasAgenteRepository;

  constructor(private readonly db: TenantDbSession) {
    this.agente = new PostgresReservasAgenteRepository(db);
  }

  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        if (isMigrationPendingError(err)) throw new ReservasAgenteUnavailableError(`reservar-directo:${operation}`);
        throw mapWebError(err, operation);
      },
    });
  }

  private read<T>(operation: string, primary: () => Promise<T>, onMissing: () => T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: () => true,
      fallback: (err) => {
        if (isMigrationPendingError(err)) {
          console.warn(`${operation}: reserva directa (migracion 044) aun no aplicada -- degradando:`, err instanceof Error ? err.message : err);
          return Promise.resolve(onMissing());
        }
        throw mapWebError(err, operation);
      },
    });
  }

  webPolicy(propertyId: string): Promise<WebPolicyRecord> {
    const missing = (): WebPolicyRecord => ({ disponible: false, webEnabled: false, holdsEnabled: false, depositPct: 0, holdTtlMinutes: 120, maxNights: 14, maxGuests: 6, maxAdvanceDays: 365 });
    return this.read<WebPolicyRecord>(
      "webPolicy",
      async () => {
        const { rows } = await this.db.query<{ web_enabled: boolean; holds_enabled: boolean; web_deposit_pct: Num; hold_ttl_minutes: number; max_nights: number; max_guests: number; max_advance_days: number }>(
          `select web_enabled, holds_enabled, web_deposit_pct, hold_ttl_minutes, max_nights, max_guests, max_advance_days from hoteles.web_booking_policy($1);`,
          [propertyId],
        );
        const r = rows[0];
        if (!r) return { ...missing(), disponible: true };
        return {
          disponible: true, webEnabled: r.web_enabled, holdsEnabled: r.holds_enabled, depositPct: Number(r.web_deposit_pct), holdTtlMinutes: Number(r.hold_ttl_minutes),
          maxNights: Number(r.max_nights), maxGuests: Number(r.max_guests), maxAdvanceDays: Number(r.max_advance_days),
        };
      },
      missing,
    );
  }

  stayOptions(propertyId: string, checkInDate: string, checkOutDate: string, now?: Date): Promise<StayOptionsResult> {
    return this.agente.stayOptions(propertyId, checkInDate, checkOutDate, now);
  }

  createWebHold(input: CreateWebHoldInput): Promise<WebHoldRecord> {
    return this.write("createWebHold", async () => {
      const { rows } = await this.db.query<WebHoldRow>(
        `select ${WEB_HOLD_COLS} from hoteles.web_booking_hold_create($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10::bigint, $11, $12::timestamptz);`,
        [input.propertyId, input.roomTypeId, input.checkInDate, input.checkOutDate, input.guests, input.guestName, input.contactPhone, input.contactEmail,
          input.idempotencyKey, input.expectedTotalCents, input.consentNoticeVersion, input.now ? input.now.toISOString() : null],
      );
      return mapWebHold(rows[0]!);
    });
  }

  getWebHold(propertyId: string, holdId: string, now?: Date): Promise<WebHoldRecord> {
    return this.write("getWebHold", async () => {
      const { rows } = await this.db.query<WebHoldRow>(`select ${WEB_HOLD_COLS} from hoteles.web_booking_get($1, $2, $3::timestamptz);`, [propertyId, holdId, now ? now.toISOString() : null]);
      return mapWebHold(rows[0]!);
    });
  }

  webContext(propertyId: string, holdId: string): Promise<WebHoldContext | null> {
    return this.read<WebHoldContext | null>(
      "webContext",
      async () => {
        const { rows } = await this.db.query<{ room_type_name: string; reservation_status: string | null; free_until_hours: number | null; penalty_pct: Num | null; property_name: string }>(
          `select room_type_name, reservation_status, free_until_hours, penalty_pct, property_name from hoteles.web_booking_context($1, $2);`,
          [propertyId, holdId],
        );
        const r = rows[0];
        if (!r) return null;
        return {
          roomTypeName: r.room_type_name, propertyName: r.property_name, reservationStatus: r.reservation_status,
          terminos: r.free_until_hours === null || r.penalty_pct === null ? null : { freeUntilHours: Number(r.free_until_hours), penaltyPct: Number(r.penalty_pct) },
        };
      },
      () => null,
    );
  }

  recordPayment(propertyId: string, holdId: string, status: "capturado" | "fallido" | "pendiente", ref: string | null, now?: Date): Promise<WebHoldRecord> {
    return this.write("recordPayment", async () => {
      const { rows } = await this.db.query<WebHoldRow>(
        `select ${WEB_HOLD_COLS} from hoteles.web_booking_record_payment($1, $2, $3, $4, $5::timestamptz);`,
        [propertyId, holdId, status, ref, now ? now.toISOString() : null],
      );
      return mapWebHold(rows[0]!);
    });
  }

  cancelWebHold(propertyId: string, holdId: string, now?: Date): Promise<WebHoldRecord> {
    return this.write("cancelWebHold", async () => {
      const { rows } = await this.db.query<WebHoldRow>(`select ${WEB_HOLD_COLS} from hoteles.web_booking_cancel($1, $2, $3::timestamptz);`, [propertyId, holdId, now ? now.toISOString() : null]);
      return mapWebHold(rows[0]!);
    });
  }

  markRefunded(propertyId: string, holdId: string, ref: string): Promise<WebHoldRecord> {
    return this.write("markRefunded", async () => {
      const { rows } = await this.db.query<WebHoldRow>(`select ${WEB_HOLD_COLS} from hoteles.web_booking_mark_refunded($1, $2, $3);`, [propertyId, holdId, ref]);
      return mapWebHold(rows[0]!);
    });
  }

  roomNightsDirectas(propertyId: string, desde: string, hasta: string): Promise<RoomNightsDirectas> {
    return this.read<RoomNightsDirectas>(
      "roomNightsDirectas",
      async () => {
        const { rows } = await this.db.query<{ directas: Num; total: Num }>(
          `select coalesce(sum(case when channel = 'directo_web' then n end), 0)::bigint as directas, coalesce(sum(n), 0)::bigint as total
             from (select channel, greatest(0, least(check_out_date, $3::date) - greatest(check_in_date, $2::date)) as n
                     from hoteles.reservation
                    where property_id = $1 and status not in ('cotizada', 'cancelada', 'no_show') and check_in_date < $3::date and check_out_date > $2::date) r;`,
          [propertyId, desde, hasta],
        );
        const directas = Number(rows[0]?.directas ?? 0);
        const total = Number(rows[0]?.total ?? 0);
        return { disponible: true, desde, hasta, directas, total, porcentaje: total > 0 ? Math.round((directas / total) * 10_000) / 10_000 : null };
      },
      () => ({ disponible: false, desde, hasta, directas: 0, total: 0, porcentaje: null }),
    );
  }
}
