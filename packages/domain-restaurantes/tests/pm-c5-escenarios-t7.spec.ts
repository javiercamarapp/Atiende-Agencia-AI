// PM-C5 -- los 71 escenarios de la muestra anonimizada de chats reales de T7 entran al arnes de evaluacion. Lo verificable de forma
// determinista: estructura, que NO haya datos personales (el repo es publico), que los pendientes de decision no cuenten, y que las
// cifras que citan los escenarios coincidan con lo que cobra el motor real de pedidos sobre el catalogo sembrado de T7.
import { describe, expect, it, vi } from "vitest";
import { DECISIONES_PENDIENTES, cargarEscenariosT7, escenariosT7Activos, escenariosT7PendientesDeDecision } from "../src/evals/agente-pm/escenarios-t7.ts";
import { quoteOrder } from "../src/orders.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const suite = cargarEscenariosT7();

describe("escenarios de T7: estructura", () => {
  it("son 71, con id unico T7-001..T7-071, de chat y de la sucursal T7", () => {
    expect(suite.escenarios).toHaveLength(71);
    expect(suite.escenarios.map((e) => e.id)).toEqual(Array.from({ length: 71 }, (_, i) => `T7-${String(i + 1).padStart(3, "0")}`));
    for (const e of suite.escenarios) {
      expect(e.canal, e.id).toBe("chat");
      expect(e.sucursal, e.id).toBe("garcia-lavin");
      expect(e.turnos_cliente.length, e.id).toBeGreaterThan(0);
      for (const t of e.turnos_cliente) expect(typeof t === "string" && t.length > 0, e.id).toBe(true);
      expect(e.comportamiento_esperado.length, e.id).toBeGreaterThan(20);
      expect(e.que_no_debe_hacer.length, e.id).toBeGreaterThan(5);
    }
  });

  it("la intencion identifica el escenario: ninguna se repite", () => {
    expect(new Set(suite.escenarios.map((e) => e.intencion)).size).toBe(71);
  });
});

describe("escenarios de T7: sin datos personales (repo publico)", () => {
  const texto = (e: (typeof suite.escenarios)[number]) => [...e.turnos_cliente, e.comportamiento_esperado, e.que_no_debe_hacer, e.intencion].join("\n");
  const PATRONES: ReadonlyArray<readonly [string, RegExp]> = [
    ["telefono (7 o mas digitos, con o sin separadores)", /(?:\+?\d[\s().-]?){7,}/],
    ["correo", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["enlace", /https?:\/\/|www\.|maps\.app|goo\.gl/i],
    ["coordenadas", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
    ["direccion con numero (calle, calle N, #N, numero N)", /\b(?:calle|c\.)\s*\d+|#\s*\d+|\bn[uú]mero\s+\d+/i],
    ["presentacion con nombre propio", /\b(?:me llamo|mi nombre es|soy)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/],
  ];
  it.each(PATRONES)("ningun escenario trae %s", (_nombre, patron) => {
    const culpables = suite.escenarios.filter((e) => patron.test(texto(e))).map((e) => e.id);
    expect(culpables).toEqual([]);
  });

  it("los datos del cliente vienen como marcadores ([NOMBRE], [TEL], [LINK DE MAPS], [DIRECCIÓN...])", () => {
    const marcadores = new Set(suite.escenarios.flatMap((e) => e.turnos_cliente.flatMap((t) => t.match(/\[[A-ZÁÉÍÓÚ ]+[^\]]*\]/g) ?? [])).map((m) => m.slice(1, 4)));
    expect(marcadores.size).toBeGreaterThan(3);
  });
});

describe("escenarios de T7: pendientes de decision no fallan el CI", () => {
  it("un escenario es pendiente_decision si y solo si depende de una decision de Javier aun abierta", () => {
    for (const e of suite.escenarios) {
      const depende = e.dudas.some((d) => DECISIONES_PENDIENTES.includes(d));
      expect(e.estado, `${e.id} dudas=${e.dudas.join(",")}`).toBe(depende ? "pendiente_decision" : "activo");
    }
  });

  it("63 activos y 8 pendientes (P1/P18 programados antes de abrir, P3/P7 cobertura, P22 menu, P25 celulares)", () => {
    expect(escenariosT7Activos()).toHaveLength(63);
    expect(escenariosT7PendientesDeDecision().map((e) => e.id)).toEqual(["T7-007", "T7-010", "T7-018", "T7-027", "T7-036", "T7-053", "T7-054", "T7-065"]);
  });

  it("las decisiones ya tomadas (P5, P11, P12, P19, P20) no dejan ningun escenario pendiente", () => {
    for (const resuelta of ["P5", "P11", "P12", "P19", "P20"]) expect(DECISIONES_PENDIENTES).not.toContain(resuelta);
    expect(escenariosT7Activos().some((e) => e.dudas.includes("P19"))).toBe(true);
  });
});

describe("escenarios de T7: las cifras citadas coinciden con el motor real sobre el catalogo de T7", () => {
  const { data, agent } = loadSeedInputs();
  const plan = buildPmSeedPlan(data, agent);

  type Renglon = readonly [producto: string, piezas: number, tortilla?: "maiz" | "harina"];
  async function total(items: readonly Renglon[], doubleSalsas: readonly ("crema_ajo" | "salsa_verde")[] = []): Promise<number> {
    // Martes 14:00 en Merida: abierto y sin 2x1; el horario se evalua con el reloj real, asi que se fija.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T20:00:00Z"));
    try {
      const world = await buildInMemoryPmWorld(plan);
      const q = await quoteOrder(world.repo, {
        organizationId: world.organizationId,
        branchSlug: "garcia-lavin",
        canal: "recoger",
        items: items.map(([producto, requestedQuantity, tortilla]) => ({ productId: world.productIds.get(producto)!, requestedQuantity, ...(tortilla ? { tortilla } : {}) })),
        ...(doubleSalsas.length > 0 ? { doubleSalsas } : {}),
      });
      return q.total;
    } finally {
      vi.useRealTimers();
    }
  }

  const casos: Array<[string, string, readonly Renglon[], number, ("crema_ajo" | "salsa_verde")[]?]> = [
    ["T7-001", "1/4 kg de bistec", [["Bistec de Res — 250 g", 1]], 275],
    ["T7-014", "kilo de bistec", [["Bistec de Res — 1 kg", 1]], 1100],
    ["T7-060", "kilo de pastor, bistec, arrachera y costilla", [["Pastor — 1 kg", 1], ["Bistec de Res — 1 kg", 1], ["Arrachera — 1 kg", 1], ["Costilla de Res — 1 kg", 1]], 900 + 1100 + 1400 + 950],
    ["T7-061", "1/4 kg de pechuga (fraccion con .50)", [["Pechuga de Pollo — 250 g", 1]], 237.5],
    ["T7-022", "nachos de bistec + extra salsa (ajo)", [["Nachos de Bistec", 1]], 392, ["crema_ajo"]],
    ["T7-045", "2 frijoles + frances suizo de pastor + chicharron + extra pina", [["Frijol con Tostada", 2], ["Francés Suizo de Pastor", 1], ["Chicharrón de Queso", 1], ["Extra Piña", 1]], 639],
    ["T7-052", "2 charros + 2 ordenes de bistec + alambre suizo de bistec", [["Frijoles Charros Normal", 2], ["Tacos de Bistec de Res (orden de 3)", 6, "maiz"], ["Alambre Suizo de Bistec", 1]], 948],
    ["T7-059", "1/2 kg de pastor + 1/2 kg de bistec + 2 frijoles", [["Pastor — 500 g", 1], ["Bistec de Res — 500 g", 1], ["Frijol con Tostada", 2]], 1186],
    ["T7-038", "medio kilo de bistec + chicharron de queso", [["Bistec de Res — 500 g", 1], ["Chicharrón de Queso", 1]], 722],
    ["T7-071", "1/2 kg de pastor + 1/4 de bistec + frijol + chicharron", [["Pastor — 500 g", 1], ["Bistec de Res — 250 g", 1], ["Frijol con Tostada", 1], ["Chicharrón de Queso", 1]], 990],
    ["T7-031", "kilo de bistec + 1/2 kg de pastor + flauta de pechuga", [["Bistec de Res — 1 kg", 1], ["Pastor — 500 g", 1], ["Flauta de Pechuga", 1]], 1833],
    ["T7-053", "1.5 kg de pastor + kilo de bistec + 2 y 2 ordenes de quesadillas + 4 frijoles + 2 papadzules", [["Pastor — 1.5 kg", 1], ["Bistec de Res — 1 kg", 1], ["Quesadilla de Champiñones", 6, "harina"], ["Quesadilla de Chorizo", 6, "harina"], ["Frijol con Tostada", 4], ["Papadzules (orden de 5)", 10]], 3734],
  ];

  it.each(casos)("%s: %s cuesta lo que dice el escenario", async (id, _descripcion, items, esperado, salsas) => {
    expect(await total(items, salsas ?? []), id).toBe(esperado);
    // y la cifra esta escrita en el propio escenario (o, para los renglones sueltos, su componente)
    const escenario = suite.escenarios.find((e) => e.id === id)!;
    const cifras = [...escenario.comportamiento_esperado.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
    expect(cifras.length, `${id} cita cifras`).toBeGreaterThan(0);
  });
});
