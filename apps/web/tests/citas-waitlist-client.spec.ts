import { describe, expect, it, vi } from "vitest";
import { broadcastWaitlist, fetchWaitlist } from "../src/verticals/citas/lib/waitlist-client.ts";

describe("fetchWaitlist", () => {
  it("mapea la fila FIFO real, sin filtros", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/waitlist");
      return new Response(
        JSON.stringify({
          waitlist: [
            {
              id: "wl-1",
              position: 1,
              customer_name: "Ana Torres",
              customer_phone: "+5219990001111",
              provider_id: null,
              service_id: "serv-1",
              preferred_date_from: "2026-09-15",
              preferred_date_to: "2026-09-20",
              preferred_time_window: "mañana",
              notified_count: 0,
              created_at: "2026-09-10T12:00:00.000Z",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await fetchWaitlist(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([
      {
        id: "wl-1",
        position: 1,
        customerName: "Ana Torres",
        customerPhone: "+5219990001111",
        providerId: null,
        serviceId: "serv-1",
        preferredDateFrom: "2026-09-15",
        preferredDateTo: "2026-09-20",
        preferredTimeWindow: "mañana",
        notifiedCount: 0,
        createdAt: "2026-09-10T12:00:00.000Z",
      },
    ]);
  });

  it("manda provider_id/service_id como querystring cuando se filtran", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/waitlist?provider_id=prov-1&service_id=serv-1");
      return new Response(JSON.stringify({ waitlist: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchWaitlist(fetchImpl, "http://api.local", "tok", "prop-1", { providerId: "prov-1", serviceId: "serv-1" });
    expect(result).toEqual([]);
  });

  it("error real del servidor se propaga", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "no autorizado" }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchWaitlist(fetchImpl, "http://api.local", "tok", "prop-1")).rejects.toThrow("no autorizado");
  });
});

describe("broadcastWaitlist", () => {
  // Corrección post-revisión de f2-citas-lista-de-espera (hallazgo B, revisor
  // independiente del PR #180): estos dos tests mockeaban un body de servidor
  // (`notified`, `skipped_no_whatsapp_config` como número) que la API real YA
  // NO manda desde que el efecto se movió a post-commit en sesión de sistema
  // (admin.ts responde `queued: true` + `skipped_no_whatsapp_config: boolean`)
  // -- pasaban en verde contra un contrato que no existe, exactamente el
  // defecto que dejaba a `waitlist-client.ts`/`Agenda.tsx` sin detectar en
  // typecheck (el body llega tipado por un cast, nunca validado en runtime).
  it("POST con el body real (snake_case) y mapea el resumen (camelCase)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/prop-1/waitlist/broadcast");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ provider_id: "prov-1", service_id: "serv-1", limit: 10 });
      return new Response(JSON.stringify({ queued: true, candidates_considered: 5, skipped_no_whatsapp_config: false }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await broadcastWaitlist(fetchImpl, "http://api.local", "tok", "prop-1", { providerId: "prov-1", serviceId: "serv-1", limit: 10 });
    expect(result).toEqual({ queued: true, candidatesConsidered: 5, skippedNoWhatsappConfig: false });
  });

  it("sin filtros manda el body con undefined (el servidor los ignora) y funciona igual", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ provider_id: undefined, service_id: undefined, limit: undefined });
      return new Response(JSON.stringify({ queued: true, candidates_considered: 0, skipped_no_whatsapp_config: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await broadcastWaitlist(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual({ queued: true, candidatesConsidered: 0, skippedNoWhatsappConfig: true });
  });

  it("400 -> error real (ej. provider_id que no pertenece al negocio)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'provider_id: "x" no es un proveedor de este negocio.' }), { status: 400 })) as unknown as typeof fetch;
    await expect(broadcastWaitlist(fetchImpl, "http://api.local", "tok", "prop-1", { providerId: "x" })).rejects.toThrow("no es un proveedor");
  });
});
