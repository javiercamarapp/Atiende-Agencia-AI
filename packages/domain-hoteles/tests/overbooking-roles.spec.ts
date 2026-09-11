import { describe, expect, it } from "vitest";
import { occupancyPct, effectiveCapacity, canBook } from "../src/overbooking.ts";
import { HOTEL_ROLES, MONEY_ROLES, ADMIN_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, isHotelRole } from "../src/roles.ts";

describe("overbooking", () => {
  const config = { maxOverbookRooms: 2, occupancyThresholdPct: 90 };

  it("sin ocupación suficiente, la capacidad efectiva es la real", () => {
    expect(effectiveCapacity(10, 5, config)).toBe(10);
    expect(canBook(10, 5, 5, config)).toBe(true);
    expect(canBook(10, 5, 6, config)).toBe(false);
  });

  it("al superar el umbral de ocupación, se habilita la sobreventa configurada", () => {
    expect(occupancyPct(10, 9)).toBe(90);
    expect(effectiveCapacity(10, 9, config)).toBe(12);
    expect(canBook(10, 9, 3, config)).toBe(true);
    expect(canBook(10, 9, 4, config)).toBe(false);
  });
});

describe("roles -- mapeo hotel_staff.role -> platformRole/verticalRole (diseño Fase 1 §2)", () => {
  it("housekeeping/maintenance quedan explícitamente fuera de MONEY_ROLES", () => {
    expect(MONEY_ROLES).not.toContain("housekeeping");
    expect(MONEY_ROLES).not.toContain("maintenance");
  });

  it("solo owner/gm son ADMIN_ROLES", () => {
    expect(ADMIN_ROLES).toEqual(["owner", "gm"]);
  });

  it("todos los 8 roles finos mapean a un platformRole válido", () => {
    for (const role of HOTEL_ROLES) {
      expect(["owner", "admin", "member"]).toContain(PLATFORM_ROLE_BY_VERTICAL_ROLE[role]);
    }
    expect(PLATFORM_ROLE_BY_VERTICAL_ROLE.owner).toBe("owner");
    expect(PLATFORM_ROLE_BY_VERTICAL_ROLE.gm).toBe("admin");
    expect(PLATFORM_ROLE_BY_VERTICAL_ROLE.frontdesk).toBe("member");
  });

  it("isHotelRole reconoce solo los 8 valores válidos", () => {
    expect(isHotelRole("gm")).toBe(true);
    expect(isHotelRole("superadmin")).toBe(false);
  });
});
