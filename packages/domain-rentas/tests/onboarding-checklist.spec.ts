// Rn-36 -- calculo del checklist de onboarding: cada punto se marca SOLO con el dato real; lo no medible es no_disponible.
import { describe, expect, it } from "vitest";
import { calcularChecklistOnboardingRentas } from "../src/onboarding-checklist/calculo.ts";
import type { DatosOnboardingRentas } from "../src/onboarding-checklist/calculo.ts";

const VACIO: DatosOnboardingRentas = {
  unidades: 0,
  feeds: { activos: 0, sincronizados: 0 },
  unidadesConTarifaBase: 0,
  reglasComision: 0,
  propiedadesConAccesoActivo: 0,
  staff: { miembros: 1, invitacionesPendientes: 0 },
  propietarios: 0,
  plantillasAprobadas: 0,
};
const estado = (d: DatosOnboardingRentas, clave: string) => calcularChecklistOnboardingRentas(d).puntos.find((p) => p.clave === clave)!;

describe("calcularChecklistOnboardingRentas", () => {
  it("sin datos: todo pendiente, 0%, no listo para operar", () => {
    const c = calcularChecklistOnboardingRentas(VACIO);
    expect(c.puntos.every((p) => p.estado === "pendiente")).toBe(true);
    expect(c).toMatchObject({ medibles: 7, hechos: 0, porcentaje: 0, listoParaOperar: false });
  });

  it("iCal conectado: solo cuenta un feed ACTIVO; un feed pausado no marca el punto", () => {
    expect(estado({ ...VACIO, feeds: { activos: 0, sincronizados: 0 } }, "ical").estado).toBe("pendiente");
    expect(estado({ ...VACIO, feeds: { activos: 1, sincronizados: 0 } }, "ical")).toMatchObject({ estado: "hecho", detalle: "1 feed activo, 0 ya sincronizados" });
  });

  it("tarifa base: exige TODAS las unidades y nunca se marca sin unidades", () => {
    expect(estado({ ...VACIO, unidades: 0, unidadesConTarifaBase: 0 }, "tarifa_base")).toMatchObject({ estado: "pendiente", detalle: "Aún no hay unidades" });
    expect(estado({ ...VACIO, unidades: 3, unidadesConTarifaBase: 2 }, "tarifa_base")).toMatchObject({ estado: "pendiente", detalle: "2 de 3 unidades con tarifa" });
    expect(estado({ ...VACIO, unidades: 3, unidadesConTarifaBase: 3 }, "tarifa_base").estado).toBe("hecho");
    expect(estado({ ...VACIO, unidades: 1, unidadesConTarifaBase: 1 }, "tarifa_base").detalle).toBe("1 de 1 unidad con tarifa");
  });

  it("reglas de comision, politica de acceso, propietarios y plantilla se marcan con su conteo real", () => {
    expect(estado({ ...VACIO, reglasComision: 1 }, "reglas_comision").estado).toBe("hecho");
    expect(estado({ ...VACIO, propiedadesConAccesoActivo: 1 }, "acceso_huesped").estado).toBe("hecho");
    expect(estado({ ...VACIO, propietarios: 2 }, "propietarios")).toMatchObject({ estado: "hecho", detalle: "2 propietarios" });
    expect(estado({ ...VACIO, plantillasAprobadas: 1 }, "plantilla")).toMatchObject({ estado: "hecho", detalle: "1 plantilla aprobada" });
  });

  it("staff invitado: un segundo miembro o una invitacion pendiente lo marca; el dueño solo no", () => {
    expect(estado({ ...VACIO, staff: { miembros: 1, invitacionesPendientes: 0 } }, "staff").estado).toBe("pendiente");
    expect(estado({ ...VACIO, staff: { miembros: 2, invitacionesPendientes: 0 } }, "staff").estado).toBe("hecho");
    expect(estado({ ...VACIO, staff: { miembros: 1, invitacionesPendientes: 1 } }, "staff").estado).toBe("hecho");
  });

  it("lo no medible (null) es no_disponible, no cuenta para el progreso y no bloquea 'listo'", () => {
    const todoNull: DatosOnboardingRentas = { unidades: null, feeds: null, unidadesConTarifaBase: null, reglasComision: null, propiedadesConAccesoActivo: null, staff: null, propietarios: null, plantillasAprobadas: null };
    const c = calcularChecklistOnboardingRentas(todoNull);
    expect(c.puntos.every((p) => p.estado === "no_disponible" && p.detalle === null)).toBe(true);
    expect(c).toMatchObject({ medibles: 0, hechos: 0, porcentaje: 0, listoParaOperar: false });
    const parcial = calcularChecklistOnboardingRentas({ ...todoNull, propietarios: 1 });
    expect(parcial).toMatchObject({ medibles: 1, hechos: 1, porcentaje: 100, listoParaOperar: true });
  });

  it("listo para operar = todos los obligatorios hechos; los recomendados (acceso, staff, plantilla) solo suben el porcentaje", () => {
    const obligatorios: DatosOnboardingRentas = { ...VACIO, unidades: 1, feeds: { activos: 1, sincronizados: 1 }, unidadesConTarifaBase: 1, reglasComision: 1, propietarios: 1 };
    const c = calcularChecklistOnboardingRentas(obligatorios);
    expect(c.listoParaOperar).toBe(true);
    expect(c.porcentaje).toBe(57); // 4 de 7
    expect(c.puntos.filter((p) => p.obligatorio).map((p) => p.clave)).toEqual(["ical", "tarifa_base", "reglas_comision", "propietarios"]);
  });
});
