import { describe, expect, it, vi } from "vitest";
import { fetchCustomerDetail, fetchCustomers } from "../src/verticals/restaurantes/lib/customers-client.ts";

describe("fetchCustomers", () => {
  it("aplica search/limit/cursor como query params", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/restaurantes/prop-1/admin/customers");
      expect(parsed.searchParams.get("search")).toBe("ana");
      return new Response(JSON.stringify({ customers: [{ id: "c1", name: "Ana", phone: "9990000000", orderCount: 2 }], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCustomers(fetchImpl, "http://api.local", "tok", "prop-1", { search: "ana" });
    expect(result.customers).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

describe("fetchCustomerDetail", () => {
  it("mapea la ficha real (isNew:false) tal cual, sin inventar campos", async () => {
    const detail = { isNew: false, name: "Ana", orderCount: 2, addresses: [], lastOrderItems: null, frequentItems: [], tier: "GOLD", agentNotes: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ customer: detail }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchCustomerDetail(fetchImpl, "http://api.local", "tok", "prop-1", "c1");
    expect(result).toEqual(detail);
  });

  it("404 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Cliente no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchCustomerDetail(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("Cliente no encontrado.");
  });
});
