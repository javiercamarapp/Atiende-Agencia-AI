import { describe, expect, it } from "vitest";
import { createRouteAreaMap } from "../src/index.ts";

type Area = "operacion" | "dinero" | "administracion";

function buildMap() {
  return createRouteAreaMap<Area>({
    areasByRole: {
      owner: ["operacion", "dinero", "administracion"],
      admin: ["operacion", "dinero", "administracion"],
      member: ["operacion"],
      // "viewer" a propósito ausente: fail-closed para rol declarado pero sin fila.
    },
    areaByRoute: {
      "/dashboard": "operacion",
      "/dashboard/facturacion": "dinero",
      "/admin/usuarios": "administracion",
    },
    routesForAnyKnownRole: new Set(["/dashboard/mi-perfil"]),
  });
}

describe("createRouteAreaMap", () => {
  it("areasOf: rol declarado devuelve sus áreas", () => {
    expect(buildMap().areasOf("member")).toEqual(["operacion"]);
  });

  it("areasOf: rol NO declarado (ni siquiera 'viewer') no ve ningún área — fail-closed", () => {
    expect(buildMap().areasOf("viewer")).toEqual([]);
    expect(buildMap().areasOf("rol-inventado")).toEqual([]);
  });

  it("canViewRoute: rol con el área de la ruta -> true", () => {
    expect(buildMap().canViewRoute("admin", "/admin/usuarios")).toBe(true);
  });

  it("canViewRoute: rol sin el área de la ruta -> false", () => {
    expect(buildMap().canViewRoute("member", "/admin/usuarios")).toBe(false);
    expect(buildMap().canViewRoute("member", "/dashboard/facturacion")).toBe(false);
  });

  it("canViewRoute: ruta NO clasificada -> false para CUALQUIER rol, incluido owner — el error caro es enseñar de más", () => {
    const map = buildMap();
    expect(map.canViewRoute("owner", "/dashboard/ruta-nueva-sin-clasificar")).toBe(false);
    expect(map.areaOfRoute("/dashboard/ruta-nueva-sin-clasificar")).toBeUndefined();
  });

  it("routesForAnyKnownRole: cualquier rol CON al menos un área ve la ruta, sin importar a qué área pertenezca", () => {
    const map = buildMap();
    expect(map.canViewRoute("member", "/dashboard/mi-perfil")).toBe(true);
    expect(map.canViewRoute("owner", "/dashboard/mi-perfil")).toBe(true);
  });

  it("routesForAnyKnownRole: un rol SIN ningún área (ni siquiera declarado) tampoco ve estas rutas — ni el perfil es gratis", () => {
    expect(buildMap().canViewRoute("viewer", "/dashboard/mi-perfil")).toBe(false);
  });
});
