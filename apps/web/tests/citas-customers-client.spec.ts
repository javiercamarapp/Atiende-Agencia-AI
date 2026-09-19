import { describe, expect, it, vi } from "vitest";
import { fetchCustomerDetail, fetchCustomers, updateCustomerEmail } from "../src/verticals/citas/lib/customers-client.ts";

const CUSTOMER_ROW = { id: "cus-1", full_name: "Ana Torres", phone: "9991112233", email: null };

describe("fetchCustomers", () => {
  it("sin opciones, pide la ruta base y mapea la página", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/customers");
      return new Response(JSON.stringify({ customers: [CUSTOMER_ROW], total: 1, next_offset: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const page = await fetchCustomers(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(page).toEqual({ items: [{ id: "cus-1", fullName: "Ana Torres", phone: "9991112233", email: null }], total: 1, nextOffset: null });
  });

  it("agrega limit/offset/search a la query", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/customers?limit=10&offset=20&search=torres");
      return new Response(JSON.stringify({ customers: [], total: 0, next_offset: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchCustomers(fetchImpl, "http://api.local", "tok", "prop-1", { limit: 10, offset: 20, search: "torres" });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("nextOffset no-null cuando el servidor indica que hay más páginas", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ customers: [CUSTOMER_ROW], total: 5, next_offset: 1 }), { status: 200 })) as unknown as typeof fetch;
    const page = await fetchCustomers(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(page.nextOffset).toBe(1);
    expect(page.total).toBe(5);
  });
});

describe("fetchCustomerDetail", () => {
  it("mapea el cliente y sus citas próximas reales", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/customers/cus-1");
      return new Response(
        JSON.stringify({
          customer: CUSTOMER_ROW,
          upcoming_appointments: [
            {
              id: "apt-1",
              property_id: "prop-1",
              provider_id: "prov-1",
              service_id: "svc-1",
              customer_id: "cus-1",
              starts_at: "2099-01-01T16:00:00.000Z",
              ends_at: "2099-01-01T16:30:00.000Z",
              status: "pending",
              source: "web",
              notes: null,
              provider_name: "Dra. Fernanda López",
              service_name: "Consulta general",
              customer_name: "Ana Torres",
              customer_phone: "9991112233",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const detail = await fetchCustomerDetail(fetchImpl, "http://api.local", "tok", "prop-1", "cus-1");
    expect(detail.customer).toEqual({ id: "cus-1", fullName: "Ana Torres", phone: "9991112233", email: null });
    expect(detail.upcomingAppointments).toHaveLength(1);
    expect(detail.upcomingAppointments[0]!.providerName).toBe("Dra. Fernanda López");
  });

  it("404 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Cliente no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchCustomerDetail(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("Cliente no encontrado.");
  });
});

// Fase 6 §2 (seguimiento, "citas-sync-errores-visibles")
describe("updateCustomerEmail", () => {
  it("hace PATCH con el correo y mapea la respuesta", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/customers/cus-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ email: "ana.torres@example.test" });
      return new Response(JSON.stringify({ customer: { ...CUSTOMER_ROW, email: "ana.torres@example.test" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await updateCustomerEmail(fetchImpl, "http://api.local", "tok", "prop-1", "cus-1", "ana.torres@example.test");
    expect(result.email).toBe("ana.torres@example.test");
  });

  it("email: null manda { email: null } -- nunca es obligatorio", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ email: null });
      return new Response(JSON.stringify({ customer: CUSTOMER_ROW }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await updateCustomerEmail(fetchImpl, "http://api.local", "tok", "prop-1", "cus-1", null);
    expect(result.email).toBeNull();
  });

  it("un formato inválido (400) propaga el error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "email: formato inválido" }), { status: 400 })) as unknown as typeof fetch;
    await expect(updateCustomerEmail(fetchImpl, "http://api.local", "tok", "prop-1", "cus-1", "no-es-un-correo")).rejects.toThrow("email: formato inválido");
  });
});
