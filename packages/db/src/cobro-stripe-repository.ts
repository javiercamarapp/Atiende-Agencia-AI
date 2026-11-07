// Repositorio de Stripe por plan, uso reportado, cobranza y cola de CFDI -- puerto contra las funciones `security definer` de
// packages/db/migrations/0083_cobro_stripe_cobranza_cfdi.sql. `callerId = null` = sesion de SISTEMA (webhook y cron).
// Base sin migrar (42883/42P01/42703): `availability: "not_migrated"` bajo SAVEPOINT, nunca 500 ni exito simulado.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { SuperadminSeguridadError } from "./superadmin-seguridad-repository.ts";

export type CobroStripeAvailability = "available" | "not_migrated";
export type ComponenteStripeRow = "cuota_fija" | "sucursal" | "alta" | "minuto_voz_excedente" | "conversacion_wa_excedente";
export const COMPONENTES_STRIPE: readonly ComponenteStripeRow[] = ["cuota_fija", "sucursal", "alta", "minuto_voz_excedente", "conversacion_wa_excedente"];

export interface PreciosStripeOrgRow {
  readonly organizationId: string;
  readonly planId: string | null;
  readonly sucursalesActivas: number;
  readonly precios: readonly { readonly componente: ComponenteStripeRow; readonly priceId: string; readonly meterEventName: string | null }[];
}

export type EstadoCobranza = "al_corriente" | "aviso" | "gracia" | "pausa_sugerida";

export interface CobroStripeRepository {
  setStripePrecio(callerId: string, planId: string, componente: ComponenteStripeRow, priceId: string | null, meterEventName: string | null): Promise<{ availability: CobroStripeAvailability }>;
  preciosParaOrg(callerId: string | null, organizationId: string): Promise<{ availability: CobroStripeAvailability; precios: PreciosStripeOrgRow | null }>;
  /** SISTEMA: devuelve cuanto falta reportar del excedente acumulado del periodo. */
  usoPorReportar(organizationId: string, periodo: string, metrica: "minuto_voz" | "conversacion_wa", unidadesTotales: number): Promise<{ availability: CobroStripeAvailability; delta: number }>;
  /** SISTEMA (webhook). */
  registrarCobranza(organizationId: string, evento: "pago_fallido" | "pagada", facturaId: string | null, intento: number | null, montoCentavos: number | null): Promise<{ availability: CobroStripeAvailability; anterior: EstadoCobranza | null; nuevo: EstadoCobranza | null }>;
  cobranzaDeOrganizacion(callerId: string, organizationId: string): Promise<{ availability: CobroStripeAvailability; cobranza: { estado: EstadoCobranza; intentosFallidos: number; montoPendienteCentavos: number | null } | null }>;
  /** SISTEMA (webhook invoice.paid). true = encolada ahora. */
  encolarCfdi(organizationId: string, stripeInvoiceId: string, subtotalCentavos: number, ivaCentavos: number, detalle: string | null): Promise<{ availability: CobroStripeAvailability; encolada: boolean }>;
  cfdiPendientes(callerId: string): Promise<{ availability: CobroStripeAvailability; pendientes: readonly Record<string, unknown>[] }>;
}

function toTypedError(err: unknown): SuperadminSeguridadError | null {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  const message = err instanceof Error ? err.message : String(err);
  if (code === "42501") return new SuperadminSeguridadError(message, "forbidden");
  if (code === "22023" || code === "23514" || code === "22P02") return new SuperadminSeguridadError(message, "invalid");
  if (code === "P0002") return new SuperadminSeguridadError(message, "not_found");
  if (code === "55006" || code === "23505") return new SuperadminSeguridadError(message, "conflict");
  return null;
}

async function guarded<T, M>(db: TenantDbSession, run: () => Promise<T>, onMissing: () => M): Promise<T | M> {
  try {
    return await runWithSavepointFallback<T | M>({ session: db, primary: run, isRecoverable: (e) => isMigrationPendingError(e), fallback: async () => onMissing() });
  } catch (err) {
    throw toTypedError(err) ?? err;
  }
}

const NM = "not_migrated" as const;
const OK = "available" as const;

export class PostgresCobroStripeRepository implements CobroStripeRepository {
  constructor(private readonly db: TenantDbSession) {}

  setStripePrecio(callerId: string, planId: string, componente: ComponenteStripeRow, priceId: string | null, meterEventName: string | null) {
    return guarded(this.db, async () => {
      await this.db.query(`select core.superadmin_set_plan_stripe_precio($1, $2, $3, $4, $5);`, [callerId, planId, componente, priceId, meterEventName]);
      return { availability: OK };
    }, () => ({ availability: NM }));
  }

  preciosParaOrg(callerId: string | null, organizationId: string) {
    return guarded(this.db, async () => {
      const { rows } = await this.db.query<{ p: Record<string, unknown> | null }>(`select core.plan_stripe_precios_para_org($1, $2) as p;`, [callerId, organizationId]);
      const p = rows[0]?.p ?? null;
      if (!p) return { availability: OK, precios: null };
      return {
        availability: OK,
        precios: {
          organizationId: String(p.organizationId),
          planId: typeof p.planId === "string" ? p.planId : null,
          sucursalesActivas: Number(p.sucursalesActivas ?? 0),
          precios: (Array.isArray(p.precios) ? p.precios : []) as PreciosStripeOrgRow["precios"],
        },
      };
    }, () => ({ availability: NM, precios: null }));
  }

  usoPorReportar(organizationId: string, periodo: string, metrica: "minuto_voz" | "conversacion_wa", unidadesTotales: number) {
    return guarded(this.db, async () => {
      const { rows } = await this.db.query<{ d: string | number }>(`select core.cobro_uso_reportar($1, $2::date, $3, $4) as d;`, [organizationId, periodo, metrica, Math.max(Math.floor(unidadesTotales), 0)]);
      return { availability: OK, delta: Number(rows[0]?.d ?? 0) };
    }, () => ({ availability: NM, delta: 0 }));
  }

  registrarCobranza(organizationId: string, evento: "pago_fallido" | "pagada", facturaId: string | null, intento: number | null, montoCentavos: number | null) {
    return guarded(this.db, async () => {
      const { rows } = await this.db.query<{ r: { anterior: EstadoCobranza; nuevo: EstadoCobranza } }>(`select core.cobranza_registrar_evento($1, $2, $3, $4, $5) as r;`, [organizationId, evento, facturaId, intento, montoCentavos]);
      return { availability: OK, anterior: rows[0]?.r.anterior ?? null, nuevo: rows[0]?.r.nuevo ?? null };
    }, () => ({ availability: NM, anterior: null, nuevo: null }));
  }

  cobranzaDeOrganizacion(callerId: string, organizationId: string) {
    return guarded(this.db, async () => {
      const { rows } = await this.db.query<{ c: { estado: EstadoCobranza; intentosFallidos: number; montoPendienteCentavos: number | null } | null }>(`select core.cobranza_de_organizacion($1, $2) as c;`, [callerId, organizationId]);
      return { availability: OK, cobranza: rows[0]?.c ?? null };
    }, () => ({ availability: NM, cobranza: null }));
  }

  encolarCfdi(organizationId: string, stripeInvoiceId: string, subtotalCentavos: number, ivaCentavos: number, detalle: string | null) {
    return guarded(this.db, async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select core.cfdi_suscripcion_encolar($1, $2, $3, $4, $5) as ok;`, [organizationId, stripeInvoiceId, subtotalCentavos, ivaCentavos, detalle]);
      return { availability: OK, encolada: rows[0]?.ok === true };
    }, () => ({ availability: NM, encolada: false }));
  }

  cfdiPendientes(callerId: string) {
    return guarded(this.db, async () => {
      const { rows } = await this.db.query<{ c: Record<string, unknown> }>(`select c from core.cfdi_suscripcion_pendientes($1) c;`, [callerId]);
      return { availability: OK, pendientes: rows.map((r) => r.c) };
    }, () => ({ availability: NM, pendientes: [] as Record<string, unknown>[] }));
  }
}

/** Doble para tests (no se usa en produccion). */
export class InMemoryCobroStripeRepository implements CobroStripeRepository {
  precios = new Map<string, PreciosStripeOrgRow>();
  reportado = new Map<string, number>();
  cobranza = new Map<string, { estado: EstadoCobranza; intentosFallidos: number; montoPendienteCentavos: number | null }>();
  cfdi = new Map<string, { organizationId: string; subtotalCentavos: number; ivaCentavos: number }>();
  superadmins = new Set<string>();
  setPrecioLlamadas: Array<{ planId: string; componente: ComponenteStripeRow; priceId: string | null }> = [];

  async setStripePrecio(callerId: string, planId: string, componente: ComponenteStripeRow, priceId: string | null) {
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    this.setPrecioLlamadas.push({ planId, componente, priceId });
    return { availability: OK };
  }
  async preciosParaOrg(_callerId: string | null, organizationId: string) {
    return { availability: OK, precios: this.precios.get(organizationId) ?? null };
  }
  async usoPorReportar(organizationId: string, periodo: string, metrica: "minuto_voz" | "conversacion_wa", unidadesTotales: number) {
    const k = `${organizationId}:${periodo.slice(0, 7)}:${metrica}`;
    const previo = this.reportado.get(k) ?? 0;
    if (unidadesTotales <= previo && this.reportado.has(k)) return { availability: OK, delta: 0 };
    this.reportado.set(k, unidadesTotales);
    return { availability: OK, delta: unidadesTotales - previo };
  }
  async registrarCobranza(organizationId: string, evento: "pago_fallido" | "pagada", _f: string | null, _i: number | null, monto: number | null) {
    const prev = this.cobranza.get(organizationId);
    const intentos = evento === "pagada" ? 0 : (prev?.intentosFallidos ?? 0) + 1;
    const nuevo: EstadoCobranza = evento === "pagada" ? "al_corriente" : intentos >= 3 ? "pausa_sugerida" : intentos === 2 ? "gracia" : "aviso";
    this.cobranza.set(organizationId, { estado: nuevo, intentosFallidos: intentos, montoPendienteCentavos: evento === "pagada" ? null : monto });
    return { availability: OK, anterior: prev?.estado ?? "al_corriente", nuevo };
  }
  async cobranzaDeOrganizacion(_callerId: string, organizationId: string) {
    return { availability: OK, cobranza: this.cobranza.get(organizationId) ?? { estado: "al_corriente" as const, intentosFallidos: 0, montoPendienteCentavos: null } };
  }
  async encolarCfdi(organizationId: string, stripeInvoiceId: string, subtotalCentavos: number, ivaCentavos: number) {
    if (this.cfdi.has(stripeInvoiceId)) return { availability: OK, encolada: false };
    this.cfdi.set(stripeInvoiceId, { organizationId, subtotalCentavos, ivaCentavos });
    return { availability: OK, encolada: true };
  }
  async cfdiPendientes(callerId: string) {
    return { availability: OK, pendientes: this.superadmins.has(callerId) ? [...this.cfdi.entries()].map(([id, v]) => ({ stripeInvoiceId: id, ...v })) : [] };
  }
}
