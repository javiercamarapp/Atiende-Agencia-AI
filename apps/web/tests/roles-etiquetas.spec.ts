import { describe, expect, it } from "vitest";
import { etiquetaRol } from "../src/lib/roles.ts";

describe("etiquetaRol (tarjeta de usuario del Sidebar)", () => {
  // Copia de los roles de packages/domain-*/src/roles.ts (apps/web no depende de los paquetes de dominio, ver los *_NAV_ROLES de cada shell).
  const todos = [
    "owner", "admin", "staff", // citas, restaurantes
    "repartidor", // restaurantes
    "gm", "frontdesk", "reservations", "housekeeping", "maintenance", "fnb", "accountant", // hoteles
    "contador", "auditor", "readonly", // despachos
    "analyst", "writer", "reviewer", "viewer", // licitaciones
    "admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario", "limpieza", // rentas
  ];

  it("cada rol real de las 6 verticales tiene una etiqueta legible distinta del slug", () => {
    for (const rol of todos) {
      const etiqueta = etiquetaRol(rol);
      expect(etiqueta, `rol ${rol}`).toBeDefined();
      expect(etiqueta, `rol ${rol}`).not.toBe(rol);
    }
  });

  it("sin rol no inventa nada y un rol desconocido se muestra tal cual", () => {
    expect(etiquetaRol(undefined)).toBeUndefined();
    expect(etiquetaRol(null)).toBeUndefined();
    expect(etiquetaRol("")).toBeUndefined();
    expect(etiquetaRol("rol-nuevo")).toBe("rol-nuevo");
  });
});
