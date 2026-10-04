// CR10: el horario del prompt de PM sale del horario cargado de cada sucursal, no de una constante del codigo.
import { describe, expect, it } from "vitest";
import { describirExcepcionHorario, describirHorarioSemanal, horaLegible } from "../src/horarios.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { componerHorarioPedidosTexto, textoHorarioPedidosPm } from "../src/whatsapp/horario-prompt.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";

const DOBLE_TURNO_PM = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] as const;

describe("texto legible del horario", () => {
  it("horas en formato de caja", () => {
    expect([horaLegible("12:00"), horaLegible("01:00"), horaLegible("18:30"), horaLegible("00:00"), horaLegible("23:00")]).toEqual(["12 pm", "1 am", "6:30 pm", "12 am", "11 pm"]);
  });
  it("12 pm a 1 am todos los dias (el horario del dueño)", () => {
    expect(describirHorarioSemanal(DOBLE_TURNO_PM)).toBe("todos los días de 12 pm a 1 am");
  });
  it("agrupa dias iguales, separa distintos y soporta doble turno", () => {
    expect(
      describirHorarioSemanal([
        { dias: [1, 2, 3, 4, 5], abre: "18:00", cierra: "01:00" },
        { dias: [6, 0], abre: "12:00", cierra: "01:00" },
      ]),
    ).toBe("lunes a viernes de 6 pm a 1 am; sábado y domingo de 12 pm a 1 am");
    expect(
      describirHorarioSemanal([
        { dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "16:00" },
        { dias: [0, 1, 2, 3, 4, 5, 6], abre: "18:00", cierra: "01:00" },
      ]),
    ).toBe("todos los días de 12 pm a 4 pm y de 6 pm a 1 am");
  });
  it("horario vacio -> null; puente cerrado -> 'cerrada'", () => {
    expect(describirHorarioSemanal([])).toBeNull();
    expect(describirExcepcionHorario({ fechaDesde: "2026-10-12", fechaHasta: "2026-10-12", horario: [] })).toBe("el 12/10: cerrada");
    expect(describirExcepcionHorario({ fechaDesde: "2026-10-12", fechaHasta: "2026-10-14", horario: DOBLE_TURNO_PM })).toBe("del 12/10 al 14/10: todos los días de 12 pm a 1 am");
  });
});

describe("componerHorarioPedidosTexto", () => {
  it("sin ningun horario cargado -> null (el prompt usa su valor por omision)", () => {
    expect(componerHorarioPedidosTexto([{ nombre: "Francisco de Montejo", slug: "fco-montejo", horario: null, puentes: [] }])).toBeNull();
  });
  it("una sucursal sin horario conserva el texto del codigo y las demas el cargado", () => {
    const t = componerHorarioPedidosTexto([
      { nombre: "García Lavín", slug: "garcia-lavin", horario: DOBLE_TURNO_PM, puentes: [] },
      { nombre: "Pensiones", slug: "pensiones", horario: null, puentes: [] },
    ])!;
    expect(t).toContain("García Lavín: todos los días de 12 pm a 1 am");
    expect(t).toContain("Pensiones: todos los días de 6 pm a 12 am");
    expect(t).toContain("Galerías: no toma pedidos por este medio");
  });
});

const BRANCH = (propertyId: string, name: string, slug: string) => ({ propertyId, name, slug, address: null });
function promptCon(horarioPedidosTexto: string | null | undefined, canal: "whatsapp" | "voz" = "whatsapp") {
  return buildPmSystemPrompt({
    canal,
    businessName: "Los Taquitos de PM",
    agentName: "el asistente virtual",
    deliveryTimeText: "de 40 a 50 minutos",
    saludo: "Buenas tardes",
    branches: [BRANCH("p2", "Francisco de Montejo", "fco-montejo")],
    entryBranch: null,
    customer: { isNew: true },
    ...(horarioPedidosTexto !== undefined ? { horarioPedidosTexto } : {}),
  });
}

describe("prompt de PM con horario cargado", () => {
  it("con branch_policy 12:00-01:00 el prompt de T2 dice 12 pm a 1 am y no el 6 pm viejo", () => {
    const texto = componerHorarioPedidosTexto([{ nombre: "Francisco de Montejo", slug: "fco-montejo", horario: DOBLE_TURNO_PM, puentes: [] }])!;
    for (const canal of ["whatsapp", "voz"] as const) {
      const p = promptCon(texto, canal);
      expect(p).toContain("Francisco de Montejo: todos los días de 12 pm a 1 am");
      expect(p).not.toContain("Francisco de Montejo: lunes a viernes de 6 pm a 12 am");
    }
  });
  it("sin horario generado el prompt conserva el valor por omision", () => {
    expect(promptCon(undefined)).toContain("Francisco de Montejo: lunes a viernes de 6 pm a 12 am");
    expect(promptCon(null)).toContain("Francisco de Montejo: lunes a viernes de 6 pm a 12 am");
  });
  it("una excepcion de puente cargada aparece en el prompt", () => {
    const texto = componerHorarioPedidosTexto([
      { nombre: "García Lavín", slug: "garcia-lavin", horario: DOBLE_TURNO_PM, puentes: [{ fechaDesde: "2026-10-12", fechaHasta: "2026-10-12", horario: [] }] },
    ])!;
    expect(promptCon(texto)).toContain("excepciones por fecha, mandan sobre el horario normal: el 12/10: cerrada");
  });
  it("el comportamiento de voz sembrado con horario cargado cabe en el tope", () => {
    const texto = componerHorarioPedidosTexto([{ nombre: "García Lavín", slug: "garcia-lavin", horario: DOBLE_TURNO_PM, puentes: [] }]);
    const voz = comportamientoVozPm({ businessName: "Los Taquitos de PM", agentName: "el asistente virtual", deliveryTimeText: "de 40 a 50 minutos", branches: [BRANCH("p7", "García Lavín", "garcia-lavin")], horarioPedidosTexto: texto });
    expect(voz).toContain("García Lavín: todos los días de 12 pm a 1 am");
  });
});

describe("textoHorarioPedidosPm (lee del repositorio)", () => {
  it("compone el texto de branch_policy de cada sucursal activa y refleja un puente cargado", async () => {
    const f = buildRestaurantFixture();
    const branches = await f.repo.listBranchesForOrganization(f.organizationId);
    expect(branches.length).toBeGreaterThan(0);
    // Sin horario cargado en ninguna sucursal: null (valor por omision del prompt).
    expect(await textoHorarioPedidosPm(f.repo, branches, new Date("2026-10-10T18:00:00Z"))).toBeNull();
    f.repo.seedBranchPolicy(f.propertyId, { horario: DOBLE_TURNO_PM });
    const t = await textoHorarioPedidosPm(f.repo, branches, new Date("2026-10-10T18:00:00Z"));
    expect(t).toContain("Francisco de Montejo: todos los días de 12 pm a 1 am");
    await f.repo.createBranchHoursException(f.organizationId, { propertyId: f.propertyId, fechaDesde: "2026-10-12", fechaHasta: "2026-10-12", horario: [], motivo: "Puente" });
    const conPuente = await textoHorarioPedidosPm(f.repo, branches, new Date("2026-10-10T18:00:00Z"));
    expect(conPuente).toContain("el 12/10: cerrada");
  });
});
