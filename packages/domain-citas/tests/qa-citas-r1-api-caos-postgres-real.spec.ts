// QA R1 citas (api-caos) -- el SQL nuevo contra un Postgres REAL EFIMERO: filtro por sucursal y alta en la lista de espera.
// Opt-in: solo corre con QA_CITAS_PG_URL apuntando a una base LOCAL con las migraciones de supabase/migrations aplicadas (mismo bootstrap que
// scripts/verify-citas-concurrencia). NUNCA apuntar a la base real. Conecta como superusuario local: prueba el mapeo del repositorio, no las policies.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { enrollInWaitlist } from "../src/waitlist-enrollment.ts";
import { computeCitasResumen } from "../src/resumen.ts";

const URL = process.env.QA_CITAS_PG_URL;

function session(client: pg.PoolClient): TenantDbSession {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  } as TenantDbSession;
}

describe.skipIf(!URL)("QA R1 citas api-caos -- Postgres real", () => {
  let pool: pg.Pool;
  const org = randomUUID();
  const centro = randomUUID();
  const norte = randomUUID();
  const providerCentro = randomUUID();
  const providerSinSucursal = randomUUID();
  const service = randomUUID();
  const customer = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 2 });
    await pool.query(`insert into core.organization (id, vertical, name, slug) values ($1, 'citas', 'QA api-caos', $2);`, [org, `qa-api-caos-${org.slice(0, 8)}`]);
    for (const [id, nombre] of [[centro, "Centro"], [norte, "Norte"]] as const) await pool.query(`insert into core.property (id, organization_id, name) values ($1, $2, $3);`, [id, org, nombre]);
    await pool.query(`insert into citas.providers (id, organization_id, property_id, display_name, role_label) values ($1, $2, $3, 'Dra. Centro', 'Dentista'), ($4, $2, null, 'Dr. Libre', 'Dentista');`, [providerCentro, org, centro, providerSinSucursal]);
    await pool.query(`insert into citas.services (id, organization_id, name, duration_minutes) values ($1, $2, 'Limpieza', 30);`, [service, org]);
    await pool.query(`insert into citas.customers (id, organization_id, full_name, phone) values ($1, $2, 'Ana', '9991234567');`, [customer, org]);
    const ins = (provider: string, property: string | null, starts: string) =>
      pool.query(`insert into citas.appointments (organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source) values ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '30 minutes', 'confirmed', 'manual');`, [org, property, provider, service, customer, starts]);
    await ins(providerCentro, centro, "2027-09-13T16:00:00Z");
    await ins(providerSinSucursal, null, "2027-09-13T17:00:00Z");
    await ins(providerSinSucursal, norte, "2027-09-13T18:00:00Z");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function repo<T>(fn: (r: PostgresCitasRepository) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(new PostgresCitasRepository(session(client)));
    } finally {
      client.release();
    }
  }

  it("la lista y el Resumen de la sucursal Norte excluyen las citas de Centro y conservan las del proveedor sin sucursal", async () => {
    const norteLista = await repo((r) => r.listAppointmentsInRange(org, "2027-09-13T00:00:00Z", "2027-09-14T00:00:00Z", undefined, 50, norte));
    expect(norteLista.map((a) => a.propertyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([norte, null].sort((a, b) => String(a).localeCompare(String(b))));
    expect(await repo((r) => r.listAppointmentsInRange(org, "2027-09-13T00:00:00Z", "2027-09-14T00:00:00Z", undefined, 50))).toHaveLength(3);
    const ahora = new Date("2027-09-13T15:00:00.000Z");
    const rNorte = await repo((r) => computeCitasResumen(r, org, "America/Merida", ahora, norte));
    const rCentro = await repo((r) => computeCitasResumen(r, org, "America/Merida", ahora, centro));
    expect(rNorte.today.total).toBe(2);
    expect(rCentro.today.total).toBe(2);
  });

  it("insertWaitlistEntry: crea, es idempotente, respeta el tope por telefono y mapea fechas", async () => {
    const base = { organizationId: org, customerPhone: "9990001111", customerName: "Beto", serviceId: service, providerId: null, preferredDateFrom: "2027-09-13", preferredDateTo: "2027-09-17", preferredTimeWindow: "morning" };
    const a = await repo((r) => enrollInWaitlist(r, base));
    const b = await repo((r) => enrollInWaitlist(r, base));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    expect(a.entry).toMatchObject({ preferredDateFrom: "2027-09-13", preferredDateTo: "2027-09-17", preferredTimeWindow: "morning", providerId: null, serviceId: service });
    expect(await repo((r) => r.loadLiveWaitlistCandidates(org))).toHaveLength(1);
    for (let i = 0; i < 4; i++) await repo((r) => enrollInWaitlist(r, { ...base, preferredDateFrom: `2027-10-0${i + 1}`, preferredDateTo: null }));
    await expect(repo((r) => enrollInWaitlist(r, { ...base, preferredDateFrom: "2027-11-01", preferredDateTo: null }))).rejects.toThrow(/anotaciones activas/);
  });
});
