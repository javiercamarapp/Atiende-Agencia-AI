// R-15: listDeliveredOrdersForRepartidor -- el rango del dia se calcula EN SQL en la zona de la sucursal y SIEMPRE se filtra por
// organizacion Y repartidor. (La semantica real de la zona horaria de SQL la cubre Postgres; aqui se fija el contrato de la consulta.)
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import type { TenantDbSession } from "@atiende/core-tenancy";

describe("PostgresRestaurantesRepository.listDeliveredOrdersForRepartidor", () => {
  it("consulta por organizacion, repartidor, dia local y zona; mapea deliveredAt", async () => {
    const fila = {
      id: "o1", organization_id: "org", property_id: "p", customer_id: null, customer_name: "Ana", customer_phone: "9990000000", customer_address: null, customer_email: null,
      branch: null, total: "150.00", status: "entregado", items: [], source: "web", notes: null, payment_method: "efectivo", call_transcript: null, call_recording_url: null,
      dedupe_fingerprint: null, idempotency_key: null, created_at: "2026-10-03T12:00:00Z", assigned_repartidor_id: "rep", estimated_delivery_at: null, incident_note: null,
      delivered_at: new Date("2026-10-03T17:00:00Z"),
    };
    const capturas: { sql: string; params: unknown[] | undefined }[] = [];
    const s = {
      query: async (sql: string, params?: unknown[]) => {
        capturas.push({ sql, params });
        return { rows: [fila] };
      },
      exec: async () => undefined,
    } as unknown as TenantDbSession;
    const r = await new PostgresRestaurantesRepository(s).listDeliveredOrdersForRepartidor("org", "rep", "2026-10-03", "America/Mexico_City");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "o1", total: 150, paymentMethod: "efectivo", deliveredAt: "2026-10-03T17:00:00.000Z" });
    expect(capturas).toHaveLength(1);
    expect(capturas[0]!.sql).toMatch(/organization_id = \$1 and assigned_repartidor_id = \$2/);
    expect(capturas[0]!.sql).toMatch(/at time zone \$4/);
    expect(capturas[0]!.params).toEqual(["org", "rep", "2026-10-03", "America/Mexico_City"]);
  });

  it("los listados traen el folio (`order_number`) y la entrega (`delivered_at`) de la 001 en ORDER_COLUMNS: orderNumber y deliveredAt llegan al panel", async () => {
    const fila = {
      id: "o2", organization_id: "org", property_id: "p", customer_id: null, customer_name: "Ana", customer_phone: "9990000000", customer_address: null, customer_email: null,
      branch: null, total: "99.00", status: "entregado", items: [], source: "web", notes: null, payment_method: null, call_transcript: null, call_recording_url: null,
      dedupe_fingerprint: null, idempotency_key: null, created_at: "2026-10-03T12:00:00Z", assigned_repartidor_id: null, estimated_delivery_at: null, incident_note: null,
      order_number: "1001", delivered_at: "2026-10-03T17:00:00Z",
    };
    const capturas: string[] = [];
    const s = {
      query: async (sql: string) => {
        capturas.push(sql);
        return { rows: [fila] };
      },
      exec: async () => undefined,
    } as unknown as TenantDbSession;
    const r = await new PostgresRestaurantesRepository(s).listDeliveredOrdersForRepartidor("org", "rep", "2026-10-03", "America/Mexico_City");
    expect(r[0]).toMatchObject({ orderNumber: 1001, deliveredAt: "2026-10-03T17:00:00Z" });
    expect(capturas[0]).toMatch(/incident_note, order_number, delivered_at/);
  });
});
