import { describe, expect, it, vi } from "vitest";
import { fetchAdminBranches, fetchBranchDetail, updateBranchDetail } from "../src/verticals/restaurantes/lib/branches-client.ts";

const BRANCH_ROW = { propertyId: "prop-1", name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: null, lng: null };

describe("fetchAdminBranches / fetchBranchDetail", () => {
  it("lista sucursales, incluidas inactivas (ficha de administración)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ branches: [BRANCH_ROW, { ...BRANCH_ROW, propertyId: "prop-2", status: "inactive" }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchAdminBranches(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(2);
    expect(result[1]?.status).toBe("inactive");
  });

  it("fetchBranchDetail devuelve la ficha real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ branch: BRANCH_ROW }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchBranchDetail(fetchImpl, "http://api.local", "tok", "prop-1", "prop-1");
    expect(result.name).toBe("Centro");
  });
});

describe("updateBranchDetail", () => {
  it("hace PATCH con solo los campos editables", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/sucursales/prop-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ phone: "9990000000" });
      return new Response(JSON.stringify({ branch: { ...BRANCH_ROW, phone: "9990000000" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updateBranchDetail(fetchImpl, "http://api.local", "tok", "prop-1", "prop-1", { phone: "9990000000" });
    expect(result.phone).toBe("9990000000");
  });
});
