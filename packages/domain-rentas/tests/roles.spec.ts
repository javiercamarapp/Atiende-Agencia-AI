import { describe, expect, it } from "vitest";
import { CANCELAR_ROLES, ESCRITURA_CALENDARIO_ROLES, FINANZAS_ESCRITURA_ROLES, FINANZAS_LECTURA_ROLES, isRentasVerticalRole, PLATFORM_ROLE_BY_VERTICAL_ROLE, RENTAS_VERTICAL_ROLES } from "../src/roles.ts";

describe("isRentasVerticalRole", () => {
  it("reconoce los 6 roles válidos", () => {
    for (const role of RENTAS_VERTICAL_ROLES) {
      expect(isRentasVerticalRole(role)).toBe(true);
    }
  });
  it("rechaza un rol de otra vertical (p. ej. hoteles) o inventado", () => {
    expect(isRentasVerticalRole("frontdesk")).toBe(false);
    expect(isRentasVerticalRole("superadmin")).toBe(false);
    expect(isRentasVerticalRole("propietario")).toBe(false);
  });
});

describe("ESCRITURA_CALENDARIO_ROLES", () => {
  it("admite admin_gestora, operador:acceso_total y operador:calendario_mensajeria", () => {
    expect(ESCRITURA_CALENDARIO_ROLES).toEqual(expect.arrayContaining(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]));
  });
  it("NUNCA admite operador:solo_calendario, contador ni limpieza", () => {
    expect(ESCRITURA_CALENDARIO_ROLES).not.toContain("operador:solo_calendario");
    expect(ESCRITURA_CALENDARIO_ROLES).not.toContain("contador");
    expect(ESCRITURA_CALENDARIO_ROLES).not.toContain("limpieza");
  });
});

describe("CANCELAR_ROLES: exige el nivel más alto (H-018)", () => {
  it("solo admin_gestora y operador:acceso_total pueden cancelar", () => {
    expect(CANCELAR_ROLES).toEqual(["admin_gestora", "operador:acceso_total"]);
  });
  it("operador:calendario_mensajeria puede escribir calendario pero NO cancelar", () => {
    expect(ESCRITURA_CALENDARIO_ROLES).toContain("operador:calendario_mensajeria");
    expect(CANCELAR_ROLES).not.toContain("operador:calendario_mensajeria");
  });
});

describe("Finanzas: contador es siempre solo-lectura", () => {
  it("contador puede leer finanzas", () => {
    expect(FINANZAS_LECTURA_ROLES).toContain("contador");
  });
  it("contador NUNCA puede escribir un movimiento financiero", () => {
    expect(FINANZAS_ESCRITURA_ROLES).not.toContain("contador");
    expect(FINANZAS_ESCRITURA_ROLES).toEqual(["admin_gestora"]);
  });
});

describe("PLATFORM_ROLE_BY_VERTICAL_ROLE", () => {
  it("cubre los 6 roles sin dejar ninguno sin mapear", () => {
    for (const role of RENTAS_VERTICAL_ROLES) {
      expect(PLATFORM_ROLE_BY_VERTICAL_ROLE[role]).toBeDefined();
    }
  });
  it("admin_gestora mapea a owner (techo de plataforma)", () => {
    expect(PLATFORM_ROLE_BY_VERTICAL_ROLE.admin_gestora).toBe("owner");
  });
  it("contador mapea a viewer", () => {
    expect(PLATFORM_ROLE_BY_VERTICAL_ROLE.contador).toBe("viewer");
  });
});
