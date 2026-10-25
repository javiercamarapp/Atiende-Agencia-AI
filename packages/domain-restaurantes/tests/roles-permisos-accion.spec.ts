// PL-23 -- matriz de permisos por accion: cada accion x cada rol, fail-closed y consistencia con MANAGER_ROLES/STAFF_INVITE_ROLES.
import { describe, expect, it } from "vitest";
import { ACCIONES_RESTAURANTES, ACCIONES_RESTAURANTES_LISTA, MANAGER_ROLES, RESTAURANTES_ROLES, ACCIONES_PERFIL_OPERATIVO, perfilPuede, STAFF_INVITE_ROLES, permisosEfectivos, puedeEjecutar, rolesParaAccion } from "../src/index.ts";

const ESPERADO: Record<string, Record<string, boolean>> = {
  "catalogo.ver": { owner: true, admin: true, staff: true, repartidor: false },
  "catalogo.precio": { owner: true, admin: true, staff: false, repartidor: false },
  "catalogo.disponibilidad": { owner: true, admin: true, staff: true, repartidor: false },
  "promociones.ver": { owner: true, admin: true, staff: false, repartidor: false },
  "promociones.editar": { owner: true, admin: true, staff: false, repartidor: false },
  "sucursal.ver": { owner: true, admin: true, staff: true, repartidor: false },
  "sucursal.editar": { owner: true, admin: true, staff: false, repartidor: false },
  "pedidos.gestionar": { owner: true, admin: true, staff: true, repartidor: false },
  "cfo.ver": { owner: true, admin: true, staff: false, repartidor: false },
  "cfo.capturar": { owner: true, admin: true, staff: false, repartidor: false },
  "cfo.importar_sr": { owner: true, admin: true, staff: false, repartidor: false },
  "cfo.exportar": { owner: true, admin: true, staff: false, repartidor: false },
  // Panel movil del operador (PLAN-PANEL-OPERADOR D1). El rol `staff` cubre a cajero y encargado; separar al cajero (que NO cancela ni
  // despacha) exige un perfil operativo en la membresia y lo resuelve el backend (paquete A1), no esta matriz de roles.
  "pedidos.capturar": { owner: true, admin: true, staff: true, repartidor: false },
  "viajes.despachar": { owner: true, admin: true, staff: true, repartidor: false },
  "pedidos.cancelar": { owner: true, admin: true, staff: true, repartidor: false },
  "turno.ver": { owner: true, admin: true, staff: true, repartidor: false },
  "entrega.deshacer_forzado": { owner: true, admin: true, staff: true, repartidor: false },
};

describe("matriz de permisos por accion (PL-23)", () => {
  it("la tabla esperada cubre exactamente las acciones de la matriz", () => {
    expect([...ACCIONES_RESTAURANTES_LISTA].sort()).toEqual(Object.keys(ESPERADO).sort());
  });

  for (const [accion, porRol] of Object.entries(ESPERADO)) {
    for (const rol of RESTAURANTES_ROLES) {
      it(`${accion} x ${rol} -> ${porRol[rol]}`, () => {
        expect(puedeEjecutar(rol, accion)).toBe(porRol[rol]);
      });
    }
  }

  it("fail-closed: accion desconocida, rol desconocido o ausente se niegan", () => {
    expect(rolesParaAccion("catalogo.borrar_todo")).toEqual([]);
    expect(rolesParaAccion("toString")).toEqual([]);
    expect(rolesParaAccion("__proto__")).toEqual([]);
    expect(puedeEjecutar("owner", "no.existe")).toBe(false);
    expect(puedeEjecutar("superadmin", "catalogo.ver")).toBe(false);
    expect(puedeEjecutar(undefined, "catalogo.ver")).toBe(false);
    expect(puedeEjecutar(null, "catalogo.ver")).toBe(false);
    expect(puedeEjecutar("", "catalogo.ver")).toBe(false);
  });

  it("nunca es mas amplia que los gestores ni mas angosta que owner/admin: staff solo gana ver y disponibilidad; el repartidor nada", () => {
    for (const accion of ACCIONES_RESTAURANTES_LISTA) {
      const roles = ACCIONES_RESTAURANTES[accion] as readonly string[];
      for (const r of roles) expect(MANAGER_ROLES as readonly string[]).toContain(r);
      for (const r of STAFF_INVITE_ROLES) expect(roles).toContain(r);
      expect(roles).not.toContain("repartidor");
    }
  });

  it("permisosEfectivos refleja la matriz para cada rol", () => {
    expect(permisosEfectivos("staff")).toMatchObject({ "catalogo.disponibilidad": true, "catalogo.precio": false, "promociones.editar": false, "sucursal.editar": false });
    expect(permisosEfectivos("admin")["catalogo.precio"]).toBe(true);
    expect(Object.values(permisosEfectivos("repartidor")).every((v) => v === false)).toBe(true);
    expect(Object.values(permisosEfectivos(undefined)).every((v) => v === false)).toBe(true);
  });
});

describe("matriz del perfil operativo del staff (cajero / encargado)", () => {
  const ESPERADO_PERFIL: Record<string, Record<string, boolean>> = {
    capturar: { cajero: true, encargado: true },
    gestionar: { cajero: true, encargado: true },
    despachar: { cajero: false, encargado: true },
    cancelar: { cajero: false, encargado: true },
  };
  it("cubre exactamente las acciones esperadas", () => {
    expect(Object.keys(ACCIONES_PERFIL_OPERATIVO).sort()).toEqual(Object.keys(ESPERADO_PERFIL).sort());
  });
  for (const [accion, porPerfil] of Object.entries(ESPERADO_PERFIL)) {
    for (const [perfil, ok] of Object.entries(porPerfil)) {
      it(`${accion} x ${perfil} -> ${ok}`, () => {
        expect(perfilPuede(perfil, accion)).toBe(ok);
      });
    }
  }
  it("perfil nulo = encargado; accion o perfil desconocido se niega a quien no es encargado", () => {
    expect(perfilPuede(null, "despachar")).toBe(true);
    expect(perfilPuede(undefined, "cancelar")).toBe(true);
    expect(perfilPuede("cajero", "toString")).toBe(false);
    expect(perfilPuede("gerente", "despachar")).toBe(false);
  });
});
