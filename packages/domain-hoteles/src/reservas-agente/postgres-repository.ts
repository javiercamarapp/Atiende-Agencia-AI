// Adaptador Postgres del agente de reservas (H-25) sobre `TenantDbSession` (auth.uid() real por request en las rutas de staff;
// sesion de SISTEMA en el agente de WhatsApp/voz). REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la sesion es UNA
// transaccion; un error de Postgres (42P01/42883/42703 si la migracion 037 no esta aplicada) la dejaria ABORTADA (25P02).
// Toda operacion corre dentro de `runWithSavepointFallback`: las lecturas degradan a vacio honesto (`disponible:false`) y las
// escrituras a `ReservasAgenteUnavailableError`. Los errores de regla de negocio (SQLSTATE 22023/55000/P0001/P0002/42501) se
// traducen a `ReservasAgenteError` con codigo estable, nunca un 500 crudo. El SQL es el MISMO que ejercita
// scripts/verify-hoteles-reservas-agente contra Postgres real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { ReservasAgenteRepository } from "./repository.ts";
import { nightsBetweenDates } from "./validacion.ts";
import { DEFAULT_BOOKING_POLICY, ReservasAgenteError, ReservasAgenteUnavailableError } from "./tipos.ts";
import type {
  BookingPolicyInput,
  BookingPolicyRecord,
  BookingPolicyResult,
  CreateHoldInput,
  HoldListResult,
  HoldRecord,
  HoldStatus,
  NightlyPrice,
  ReservasAgenteErrorCode,
  StayOption,
  StayOptionStatus,
  StayOptionsResult,
} from "./tipos.ts";

type Num = string | number;

const HOLD_COLS = `id, property_id, room_type_id, check_in_date::text as check_in_date, check_out_date::text as check_out_date, nights, guests, channel,
       guest_name, contact_phone, currency, net_cents, iva_cents, ish_cents, total_cents, mode, status, expires_at::text as expires_at, payment_link_ref,
       decided_by, decided_at::text as decided_at, decision_reason, reservation_id, created_at::text as created_at`;

interface HoldRow {
  id: string; property_id: string; room_type_id: string; check_in_date: string; check_out_date: string; nights: number; guests: number;
  channel: "whatsapp" | "voz"; guest_name: string | null; contact_phone: string; currency: "MXN"; net_cents: Num; iva_cents: Num; ish_cents: Num; total_cents: Num;
  mode: "aprobacion_humana" | "link_pago"; status: HoldStatus; expires_at: string; payment_link_ref: string | null; decided_by: string | null;
  decided_at: string | null; decision_reason: string | null; reservation_id: string | null; created_at: string;
}

function mapHold(r: HoldRow): HoldRecord {
  return {
    id: r.id, propertyId: r.property_id, roomTypeId: r.room_type_id, checkInDate: r.check_in_date, checkOutDate: r.check_out_date, nights: Number(r.nights),
    guests: Number(r.guests), channel: r.channel, guestName: r.guest_name, contactPhone: r.contact_phone, currency: r.currency, netCents: Number(r.net_cents),
    ivaCents: Number(r.iva_cents), ishCents: Number(r.ish_cents), totalCents: Number(r.total_cents), mode: r.mode, status: r.status, expiresAt: r.expires_at,
    paymentLinkRef: r.payment_link_ref, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionReason: r.decision_reason, reservationId: r.reservation_id,
    createdAt: r.created_at,
  };
}

interface OptionRow {
  room_type_id: string; room_type_name: string; max_occupancy: number; free_rooms: number; status: StayOptionStatus;
  net_cents: Num | null; iva_cents: Num | null; ish_cents: Num | null; total_cents: Num | null; nightly: unknown;
}

function mapNightly(raw: unknown): readonly NightlyPrice[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((n) => ({ date: String((n as { date: unknown }).date), cents: Number((n as { cents: unknown }).cents) }));
}
const numOrNull = (v: Num | null): number | null => (v === null || v === undefined ? null : Number(v));

function mapOption(r: OptionRow): StayOption {
  return {
    roomTypeId: r.room_type_id, roomTypeName: r.room_type_name, maxOccupancy: Number(r.max_occupancy), freeRooms: Number(r.free_rooms), status: r.status,
    netCents: numOrNull(r.net_cents), ivaCents: numOrNull(r.iva_cents), ishCents: numOrNull(r.ish_cents), totalCents: numOrNull(r.total_cents), nightly: mapNightly(r.nightly),
  };
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function pgMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

const BUSINESS_PREFIXES: readonly ReservasAgenteErrorCode[] = [
  "fechas_invalidas", "fecha_pasada", "fecha_muy_lejana", "estadia_muy_larga", "huespedes_invalidos", "cotizacion_no_disponible", "precio_cambio",
  "parametros_invalidos", "idempotencia_conflicto", "holds_deshabilitados", "limite_holds_activos", "limite_holds_contacto", "tipo_habitacion_invalido", "sin_disponibilidad",
];

/** Traduce un error de Postgres a un error de dominio tipado. Los mensajes propios de la migracion 037 son seguros de mostrar. */
export function mapReservasPgError(err: unknown, operation: string): unknown {
  if (err instanceof ReservasAgenteError) return err;
  if (isMigrationPendingError(err)) return new ReservasAgenteUnavailableError(operation);
  const code = pgCode(err);
  const message = pgMessage(err);
  const prefix = BUSINESS_PREFIXES.find((p) => message.startsWith(p));
  switch (code) {
    case "22023": {
      if (prefix === "cotizacion_no_disponible") {
        const status = /cotizacion_no_disponible: (\w+)/.exec(message)?.[1];
        return new ReservasAgenteError("cotizacion_no_disponible", message, { status });
      }
      if (prefix === "precio_cambio") {
        const total = /(\d+) centavos/.exec(message)?.[1];
        return new ReservasAgenteError("precio_cambio", message, total ? { totalCents: Number(total) } : undefined);
      }
      return new ReservasAgenteError(prefix ?? "parametros_invalidos", prefix ? message : "Datos invalidos (fuera de rango o formato no permitido).");
    }
    case "23514":
      return new ReservasAgenteError("parametros_invalidos", "Datos invalidos (fuera de rango o formato no permitido).");
    case "55000":
      return new ReservasAgenteError(prefix ?? "estado_no_valido", prefix ? message : "La operacion no procede en el estado actual.");
    case "P0001":
      return new ReservasAgenteError("sin_disponibilidad", "No hay habitaciones libres para alguna noche (no se retuvo nada).");
    case "P0002":
      return new ReservasAgenteError(prefix === "tipo_habitacion_invalido" ? "tipo_habitacion_invalido" : "no_encontrada", "No encontrado, o sin permiso para verlo.");
    case "23505":
      return new ReservasAgenteError("idempotencia_conflicto", "Ya existe un registro equivalente.");
    case "42501":
      return new ReservasAgenteError("sin_permiso", "No tienes permiso para esta operacion.");
    default:
      return err;
  }
}

export class PostgresReservasAgenteRepository implements ReservasAgenteRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Escritura protegida por SAVEPOINT: cualquier error recupera la sesion y se traduce. */
  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapReservasPgError(err, operation);
      },
    });
  }

  /** Lectura protegida por SAVEPOINT: solo "migracion pendiente" degrada; el resto se traduce o se repropaga. */
  private read<T>(operation: string, primary: () => Promise<T>, onMissing: () => T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: () => true,
      fallback: (err) => {
        if (isMigrationPendingError(err)) {
          console.warn(`${operation}: agente de reservas (migracion 037) aun no aplicada -- degradando:`, err instanceof Error ? err.message : err);
          return Promise.resolve(onMissing());
        }
        throw mapReservasPgError(err, operation);
      },
    });
  }

  private async assertHoldInProperty(propertyId: string, holdId: string): Promise<void> {
    const { rows } = await this.db.query<{ ok: number }>(`select 1 as ok from hoteles.booking_hold where id = $1 and property_id = $2;`, [holdId, propertyId]);
    if (rows.length === 0) throw new ReservasAgenteError("no_encontrada", "pre-reserva no encontrada");
  }

  private static iso(now?: Date): string | null {
    return now ? now.toISOString() : null;
  }

  // ---- agente (sistema) ----
  stayOptions(propertyId: string, checkInDate: string, checkOutDate: string, now?: Date): Promise<StayOptionsResult> {
    const nights = nightsBetweenDates(checkInDate, checkOutDate);
    return this.read<StayOptionsResult>(
      "stayOptions",
      async () => {
        const { rows } = await this.db.query<OptionRow>(
          `select room_type_id, room_type_name, max_occupancy, free_rooms, status, net_cents, iva_cents, ish_cents, total_cents, nightly
             from hoteles.agent_stay_options($1, $2::date, $3::date, $4::timestamptz);`,
          [propertyId, checkInDate, checkOutDate, PostgresReservasAgenteRepository.iso(now)],
        );
        return { disponible: true, checkInDate, checkOutDate, nights, opciones: rows.map(mapOption) };
      },
      () => ({ disponible: false, checkInDate, checkOutDate, nights, opciones: [] }),
    );
  }

  createHold(input: CreateHoldInput): Promise<HoldRecord> {
    return this.write("createHold", async () => {
      const { rows } = await this.db.query<HoldRow>(
        `select ${HOLD_COLS} from hoteles.booking_hold_create($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10::bigint, $11::timestamptz);`,
        [input.propertyId, input.roomTypeId, input.checkInDate, input.checkOutDate, input.guests, input.guestName, input.contactPhone, input.channel,
          input.idempotencyKey, input.expectedTotalCents, PostgresReservasAgenteRepository.iso(input.now)],
      );
      return mapHold(rows[0]!);
    });
  }

  holdStatusForContact(propertyId: string, holdId: string, contactPhone: string, now?: Date): Promise<HoldRecord> {
    return this.write("holdStatusForContact", async () => {
      const { rows } = await this.db.query<HoldRow>(
        `select ${HOLD_COLS} from hoteles.booking_hold_status_for_contact($1, $2, $3, $4::timestamptz);`,
        [propertyId, holdId, contactPhone, PostgresReservasAgenteRepository.iso(now)],
      );
      return mapHold(rows[0]!);
    });
  }

  cancelHoldForContact(propertyId: string, holdId: string, contactPhone: string, now?: Date): Promise<HoldRecord> {
    return this.write("cancelHoldForContact", async () => {
      const { rows } = await this.db.query<HoldRow>(
        `select ${HOLD_COLS} from hoteles.booking_hold_cancel_for_contact($1, $2, $3, $4::timestamptz);`,
        [propertyId, holdId, contactPhone, PostgresReservasAgenteRepository.iso(now)],
      );
      return mapHold(rows[0]!);
    });
  }

  expireDueHolds(propertyId: string | null, now?: Date): Promise<number> {
    return this.write("expireDueHolds", async () => {
      const { rows } = await this.db.query<{ n: Num }>(`select hoteles.booking_hold_expire_due($1, $2::timestamptz) as n;`, [propertyId, PostgresReservasAgenteRepository.iso(now)]);
      return Number(rows[0]?.n ?? 0);
    });
  }

  // ---- staff ----
  listHolds(propertyId: string, filter: { readonly status?: HoldStatus; readonly onlyOpen?: boolean } = {}): Promise<HoldListResult> {
    return this.read<HoldListResult>(
      "listHolds",
      async () => {
        const params: unknown[] = [propertyId];
        let where = "property_id = $1";
        if (filter.status) { params.push(filter.status); where += ` and status = $${params.length}`; }
        if (filter.onlyOpen) where += ` and status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado')`;
        const { rows } = await this.db.query<HoldRow>(`select ${HOLD_COLS} from hoteles.booking_hold where ${where} order by created_at desc, id limit 200;`, params);
        return { disponible: true, holds: rows.map(mapHold) };
      },
      () => ({ disponible: false, holds: [] }),
    );
  }

  decideHold(propertyId: string, holdId: string, decision: "aprobar" | "rechazar", reason: string): Promise<HoldRecord> {
    return this.write("decideHold", async () => {
      await this.assertHoldInProperty(propertyId, holdId);
      const { rows } = await this.db.query<HoldRow>(`select ${HOLD_COLS} from hoteles.booking_hold_decide($1, $2, $3);`, [holdId, decision, reason]);
      return mapHold(rows[0]!);
    });
  }

  registerPaymentLink(propertyId: string, holdId: string, reference: string): Promise<HoldRecord> {
    return this.write("registerPaymentLink", async () => {
      await this.assertHoldInProperty(propertyId, holdId);
      const { rows } = await this.db.query<HoldRow>(`select ${HOLD_COLS} from hoteles.booking_hold_register_payment_link($1, $2);`, [holdId, reference]);
      return mapHold(rows[0]!);
    });
  }

  confirmHold(propertyId: string, holdId: string): Promise<HoldRecord> {
    return this.write("confirmHold", async () => {
      await this.assertHoldInProperty(propertyId, holdId);
      const { rows } = await this.db.query<HoldRow>(`select ${HOLD_COLS} from hoteles.booking_hold_confirm($1);`, [holdId]);
      return mapHold(rows[0]!);
    });
  }

  staffCancelHold(propertyId: string, holdId: string, reason: string): Promise<HoldRecord> {
    return this.write("staffCancelHold", async () => {
      await this.assertHoldInProperty(propertyId, holdId);
      const { rows } = await this.db.query<HoldRow>(`select ${HOLD_COLS} from hoteles.booking_hold_staff_cancel($1, $2);`, [holdId, reason]);
      return mapHold(rows[0]!);
    });
  }

  getPolicy(propertyId: string): Promise<BookingPolicyResult> {
    return this.read<BookingPolicyResult>(
      "getPolicy",
      async () => {
        const { rows } = await this.db.query<PolicyRow>(`select ${POLICY_COLS} from hoteles.booking_agent_policy where property_id = $1;`, [propertyId]);
        return { disponible: true, politica: rows[0] ? mapPolicy(rows[0]) : { propertyId, ...DEFAULT_BOOKING_POLICY, configured: false } };
      },
      () => ({ disponible: false, politica: { propertyId, ...DEFAULT_BOOKING_POLICY, configured: false } }),
    );
  }

  upsertPolicy(propertyId: string, input: BookingPolicyInput): Promise<BookingPolicyResult> {
    return this.write("upsertPolicy", async () => {
      const { rows } = await this.db.query<PolicyRow>(
        `insert into hoteles.booking_agent_policy (property_id, holds_enabled, mode, hold_ttl_minutes, max_nights, max_guests, max_advance_days, max_active_holds)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (property_id) do update set holds_enabled = excluded.holds_enabled, mode = excluded.mode, hold_ttl_minutes = excluded.hold_ttl_minutes,
           max_nights = excluded.max_nights, max_guests = excluded.max_guests, max_advance_days = excluded.max_advance_days, max_active_holds = excluded.max_active_holds
         returning ${POLICY_COLS};`,
        [propertyId, input.holdsEnabled, input.mode, input.holdTtlMinutes, input.maxNights, input.maxGuests, input.maxAdvanceDays, input.maxActiveHolds],
      );
      return { disponible: true, politica: mapPolicy(rows[0]!) };
    });
  }
}

const POLICY_COLS = `property_id, holds_enabled, mode, hold_ttl_minutes, max_nights, max_guests, max_advance_days, max_active_holds`;
interface PolicyRow {
  property_id: string; holds_enabled: boolean; mode: "aprobacion_humana" | "link_pago"; hold_ttl_minutes: number; max_nights: number; max_guests: number;
  max_advance_days: number; max_active_holds: number;
}
function mapPolicy(r: PolicyRow): BookingPolicyRecord {
  return {
    propertyId: r.property_id, holdsEnabled: r.holds_enabled, mode: r.mode, holdTtlMinutes: Number(r.hold_ttl_minutes), maxNights: Number(r.max_nights),
    maxGuests: Number(r.max_guests), maxAdvanceDays: Number(r.max_advance_days), maxActiveHolds: Number(r.max_active_holds), configured: true,
  };
}
