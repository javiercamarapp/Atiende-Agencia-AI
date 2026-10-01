// Rn-18 / Rn-19 / Rn-20 -- clientes web de reglas de comision, catalogo y staff de rentas: URL, metodo y cuerpo reales.
import { describe, expect, it, vi } from "vitest";
import { basisPointsAPorcentaje, cargarReglasSugeridas, crearReglaComision, editarReglaComision, fetchReglasComision, porcentajeABasisPoints } from "../src/verticals/rentas/lib/reglas-comision-client.ts";
import { crearPropiedad, crearPropietario, crearUnidad, editarPropiedad, editarPropietario, editarUnidad, fetchCatalogo } from "../src/verticals/rentas/lib/catalogo-client.ts";
import { createStaffInvite, fetchOrgMembers, fetchStaffInvites, removeStaffMember, revokeStaffInvite, STAFF_ROLE_OPTIONS, updateStaffRole } from "../src/verticals/rentas/lib/staff-client.ts";

function espiar(cuerpoRespuesta: unknown = {}, ok = true, status = 200) {
  const llamadas: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
    return { ok, status, json: async () => cuerpoRespuesta } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, llamadas };
}

describe("reglas de comision", () => {
  it("GET/POST/PATCH/sugeridas pegan a las URLs y metodos del servidor con el token", async () => {
    const { fetchImpl, llamadas } = espiar({ reglas: [], canales: [], canalesSinRegla: [], id: "r1", creadas: 4 });
    await fetchReglasComision(fetchImpl, "http://api.local", "tok", "prop-1");
    await crearReglaComision(fetchImpl, "http://api.local", "tok", "prop-1", { canalCodigo: "booking", alcance: "organizacion", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "contrato" });
    await editarReglaComision(fetchImpl, "http://api.local", "tok", "prop-1", "r1", { yaNetoDeComision: false, comisionBasisPoints: 1800, fuente: "contrato firmado" });
    await cargarReglasSugeridas(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(llamadas.map((l) => `${l.method} ${l.url}`)).toEqual([
      "GET http://api.local/rentas/prop-1/finanzas/reglas-comision",
      "POST http://api.local/rentas/prop-1/finanzas/reglas-comision",
      "PATCH http://api.local/rentas/prop-1/finanzas/reglas-comision/r1",
      "POST http://api.local/rentas/prop-1/finanzas/reglas-comision/sugeridas",
    ]);
    expect(llamadas[1]!.body).toEqual({ canalCodigo: "booking", alcance: "organizacion", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "contrato" });
    expect(llamadas.every((l) => l.auth === "Bearer tok")).toBe(true);
  });

  it("un error del servidor propaga su mensaje real (409 duplicado)", async () => {
    const { fetchImpl } = espiar({ message: "ya existe una regla para ese canal y alcance" }, false, 409);
    await expect(crearReglaComision(fetchImpl, "http://api.local", "tok", "prop-1", { canalCodigo: "booking", alcance: "organizacion", yaNetoDeComision: false, comisionBasisPoints: 1, fuente: "abc" })).rejects.toThrow("ya existe una regla para ese canal y alcance");
  });

  it("porcentaje <-> puntos base: exacto, con 2 decimales, y rechaza lo fuera de rango o con forma rara", () => {
    expect(porcentajeABasisPoints("15")).toBe(1500);
    expect(porcentajeABasisPoints("15.5")).toBe(1550);
    expect(porcentajeABasisPoints("15,25")).toBe(1525);
    expect(porcentajeABasisPoints("0")).toBe(0);
    expect(porcentajeABasisPoints("100")).toBe(10000);
    for (const t of ["", "abc", "-1", "101", "15.555", "1e2", "15%"]) expect(porcentajeABasisPoints(t), t).toBeNull();
    expect(basisPointsAPorcentaje(1550)).toBe("15.50 %");
    expect(basisPointsAPorcentaje(0)).toBe("0.00 %");
  });
});

describe("catalogo", () => {
  it("cada operacion pega a su ruta con su metodo y cuerpo (null quita propietario/correo)", async () => {
    const { fetchImpl, llamadas } = espiar({ id: "x", propertyId: "p2" });
    await fetchCatalogo(fetchImpl, "http://api.local", "tok", "prop-1");
    await editarPropiedad(fetchImpl, "http://api.local", "tok", "prop-1", { zonaHoraria: "America/Cancun", moneda: "USD" });
    await crearPropiedad(fetchImpl, "http://api.local", "tok", "prop-1", { nombre: "Casa", zonaHoraria: "America/Cancun", moneda: "MXN" });
    await crearUnidad(fetchImpl, "http://api.local", "tok", "prop-1", { nombre: "Suite", propietarioId: null, duracionMinimaNoches: 2 });
    await editarUnidad(fetchImpl, "http://api.local", "tok", "prop-1", "u1", { propietarioId: null });
    await crearPropietario(fetchImpl, "http://api.local", "tok", "prop-1", { nombre: "Ana", email: null });
    await editarPropietario(fetchImpl, "http://api.local", "tok", "prop-1", "o1", { email: null });
    const base = "http://api.local/v1/rentas/prop-1/admin/catalogo";
    expect(llamadas.map((l) => `${l.method} ${l.url}`)).toEqual([
      `GET ${base}`,
      `PATCH ${base}/propiedad`,
      `POST ${base}/propiedades`,
      `POST ${base}/unidades`,
      `PATCH ${base}/unidades/u1`,
      `POST ${base}/propietarios`,
      `PATCH ${base}/propietarios/o1`,
    ]);
    expect(llamadas[4]!.body).toEqual({ propietarioId: null });
    expect(llamadas[6]!.body).toEqual({ email: null });
  });

  it("un 503 (migracion 027 sin aplicar) llega como el mensaje honesto del servidor", async () => {
    const { fetchImpl } = espiar({ message: "Crear una unidad todavía no está disponible en esta base de datos" }, false, 503);
    await expect(crearUnidad(fetchImpl, "http://api.local", "tok", "prop-1", { nombre: "S", propietarioId: null, duracionMinimaNoches: 1 })).rejects.toThrow(/todavía no está disponible/);
  });
});

describe("staff", () => {
  it("invitar, listar, revocar, miembros, cambiar rol y baja pegan a /v1/rentas/:propertyId/admin/staff/*", async () => {
    const { fetchImpl, llamadas } = espiar({ invitations: [], miembros: [], ok: true, id: "u1" });
    await createStaffInvite(fetchImpl, "http://api.local", "tok", "prop-1", { email: "a@b.mx", verticalRole: "limpieza" });
    await fetchStaffInvites(fetchImpl, "http://api.local", "tok", "prop-1");
    await revokeStaffInvite(fetchImpl, "http://api.local", "tok", "prop-1", "i1");
    await fetchOrgMembers(fetchImpl, "http://api.local", "tok", "prop-1");
    await updateStaffRole(fetchImpl, "http://api.local", "tok", "prop-1", "u1", "contador");
    await removeStaffMember(fetchImpl, "http://api.local", "tok", "prop-1", "u1");
    const base = "http://api.local/v1/rentas/prop-1/admin/staff";
    expect(llamadas.map((l) => `${l.method} ${l.url}`)).toEqual([
      `POST ${base}/invitaciones`,
      `GET ${base}/invitaciones`,
      `DELETE ${base}/invitaciones/i1`,
      `GET ${base}/miembros`,
      `PATCH ${base}/miembros/u1`,
      `DELETE ${base}/miembros/u1`,
    ]);
    expect(llamadas[0]!.body).toEqual({ email: "a@b.mx", verticalRole: "limpieza" });
    expect(llamadas[4]!.body).toEqual({ verticalRole: "contador" });
  });

  it("los 6 roles de rentas, de menor a mayor alcance", () => {
    expect(STAFF_ROLE_OPTIONS).toEqual(["limpieza", "contador", "operador:solo_calendario", "operador:calendario_mensajeria", "operador:acceso_total", "admin_gestora"]);
  });
});
