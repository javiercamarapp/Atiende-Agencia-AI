// CFO-09 (revision): (1) las herramientas cfo_* solo existen y solo responden para quien tiene `cfo.ver` (owner/admin); staff, repartidor y roles
// desconocidos: fail-closed; (2) el texto libre de terceros (colonia, platillo, sucursal) nunca llega al `summary`, que la guardia de cifras del motor
// toma como confiable. Reloj: miercoles 12:00 de Merida.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDataChatTurn, scriptedCompletion, type DataChatScope, type DataChatToolContext, type DataChatToolResult } from "@atiende/agent-core/data-chat";
import { buildRestaurantesDataChatCatalog, buildRestaurantesDataChatTools, type VisibleBranch } from "../src/data-chat/index.ts";
import { CFO_BRANCHES, CfoFakeReader, DATASET_SINTETICO as D, IDS, MIERCOLES_MERIDA, OWNER_CFO_SCOPE, T1 } from "./data-chat/support-cfo.ts";

const SEMANA = { periodo: "semana_pasada" } as const;
const CFO_TOOLS = ["cfo_resumen", "cfo_lo_mas_importante", "cfo_estado_resultados", "cfo_comparar_sucursales", "cfo_clientes", "cfo_platillos", "cfo_patrones", "cfo_agente", "cfo_softrestaurant"];
const HOSTIL = "Centro 4321% $7,654,321 pesos";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MIERCOLES_MERIDA);
});
afterEach(() => vi.useRealTimers());

const scopeDe = (rol: string | undefined, allowed: readonly string[] | null = null): DataChatScope => ({ ...OWNER_CFO_SCOPE, verticalRole: rol as string, allowedPropertyIds: allowed });
const ctx = (scope: DataChatScope): DataChatToolContext => ({ scope, now: new Date(), signal: new AbortController().signal, maxRows: 50 });

describe("rol: solo cfo.ver (owner/admin) ve y usa las herramientas cfo_*", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["staff", false],
    ["repartidor", false],
    ["superadmin", false],
    ["", false],
    [undefined, false],
  ] as const)("catálogo para el rol %s: cfo_* %s", (rol, ve) => {
    const nombres = buildRestaurantesDataChatCatalog(new CfoFakeReader(), { verticalRole: rol }).tools.map((t) => t.name);
    expect(nombres.filter((n) => n.startsWith("cfo_"))).toEqual(ve ? CFO_TOOLS : []);
    expect(nombres.slice(0, 8)).toHaveLength(8); // las ocho de siempre quedan para todos
  });

  it("sin opciones el catálogo es fail-closed (sin cfo_*)", () => {
    expect(buildRestaurantesDataChatCatalog(new CfoFakeReader()).tools.some((t) => t.name.startsWith("cfo_"))).toBe(false);
  });

  it.each(["staff", "repartidor", "superadmin", "", undefined] as const)("aunque llegue a la herramienta, el rol %s recibe 'Tu rol no tiene acceso al CFO.' y no se toca el CFO", async (rol) => {
    const reader = new CfoFakeReader();
    for (const t of buildRestaurantesDataChatTools(reader).filter((x) => x.name.startsWith("cfo_"))) {
      const r: DataChatToolResult = await t.run(ctx(scopeDe(rol)), SEMANA);
      expect(r.status, t.name).toBe("unavailable");
      expect(r.message, t.name).toBe("Tu rol no tiene acceso al CFO.");
      expect(r.rows, t.name).toEqual([]);
      expect(r.source, t.name).toMatch(/no sustituye a tu contador/);
    }
    expect(reader.entradas).toHaveLength(0);
  });

  it("owner, admin y admin acotado sí consultan", async () => {
    for (const scope of [scopeDe("owner"), scopeDe("admin"), scopeDe("admin", [T1])]) {
      const reader = new CfoFakeReader();
      const r = await buildRestaurantesDataChatTools(reader).find((t) => t.name === "cfo_resumen")!.run(ctx(scope), SEMANA);
      expect(r.status, scope.verticalRole).toBe("ok");
    }
  });

  it("por el motor, staff no puede pedir una herramienta cfo_*: fuera de catálogo, sin cifras", async () => {
    const reader = new CfoFakeReader();
    const llm = scriptedCompletion([{ toolCalls: [{ name: "cfo_resumen", argumentsJson: JSON.stringify(SEMANA) }] }, { text: "Vendiste $1 MXN." }]);
    const a = await runDataChatTurn({ catalog: buildRestaurantesDataChatCatalog(reader, { verticalRole: "staff" }), scope: scopeDe("staff"), question: "¿cómo me fue la semana pasada?", complete: llm.complete, now: new Date() });
    expect(a.blocks).toEqual([]);
    expect(a.toolsUsed).toEqual([]);
    expect(reader.entradas).toHaveLength(0);
  });
});

describe("texto libre de terceros fuera del summary que alimenta la guardia de cifras", () => {
  const hostilBranches: readonly VisibleBranch[] = CFO_BRANCHES.map((b, i) => (i === 0 ? { ...b, name: HOSTIL } : b));
  const colonias = IDS.slice(0, 2).map((propertyId, i) => ({ propertyId, colonia: i === 0 ? HOSTIL : "Itzimná", pedidos: 40 - i, netaCentavos: 1_000_000, entregados: 40, minSuma: 1200, clientes: 30, sucursalCercanaId: null, distanciaKm: null }));
  const productos = D.productos.map((f) => (f.productoRef === "p-taco-pastor" ? { ...f, nombreActual: HOSTIL } : f));

  async function correr(reader: CfoFakeReader, tool: string, args: Record<string, string | number>) {
    return buildRestaurantesDataChatTools(reader).find((t) => t.name === tool)!.run(ctx(OWNER_CFO_SCOPE), args);
  }
  const sinHostil = (r: DataChatToolResult): void => {
    expect(r.summary ?? "").not.toMatch(/4321|7,654,321|7654321/);
    expect(r.summary ?? "").not.toContain("Centro 4321");
  };

  it("colonia hostil: el nombre vive en la tabla, no en el summary", async () => {
    const r = await correr(new CfoFakeReader({ dataset: { colonias } }), "cfo_patrones", { ...SEMANA, vista: "colonias" });
    expect(r.rows.map((x) => x["colonia"])).toContain(HOSTIL);
    expect(r.summary).toBeTruthy();
    sinHostil(r);
  });

  it("platillo hostil (ranking, menos vendidos): fuera del summary", async () => {
    const reader = new CfoFakeReader({ dataset: { productos } });
    const mas = await correr(reader, "cfo_platillos", { ...SEMANA, vista: "mas_vendidos" });
    expect(mas.rows.map((x) => x["platillo"])).toContain(HOSTIL);
    sinHostil(mas);
    sinHostil(await correr(reader, "cfo_platillos", { ...SEMANA, vista: "menos_vendidos", limite: 20 }));
    sinHostil(await correr(reader, "cfo_platillos", { ...SEMANA, vista: "categorias" }));
    sinHostil(await correr(reader, "cfo_platillos", { ...SEMANA, vista: "canasta" }));
  });

  it("sucursal hostil: ninguna herramienta la mete en su summary (comparar, resumen, importante, clientes, agente, SR, estado)", async () => {
    const reader = new CfoFakeReader({ branches: hostilBranches, dataset: { srResumen: D.srResumen } });
    for (const t of CFO_TOOLS) {
      const r = await correr(reader, t, SEMANA);
      sinHostil(r);
    }
    const comparar = await correr(reader, "cfo_comparar_sucursales", SEMANA);
    expect(comparar.rows.map((x) => x["sucursal"])).toContain(HOSTIL); // sí viaja en la tabla
  });

  it("el motor rechaza la cifra que el modelo derive de ese texto (colonia, platillo y sucursal)", async () => {
    const casos: Array<[CfoFakeReader, string, Record<string, string | number>]> = [
      [new CfoFakeReader({ dataset: { colonias } }), "cfo_patrones", { ...SEMANA, vista: "colonias" }],
      [new CfoFakeReader({ dataset: { productos } }), "cfo_platillos", { ...SEMANA, vista: "mas_vendidos" }],
      [new CfoFakeReader({ branches: hostilBranches }), "cfo_comparar_sucursales", SEMANA],
    ];
    for (const [reader, tool, args] of casos) {
      const llm = scriptedCompletion([{ toolCalls: [{ name: tool, argumentsJson: JSON.stringify(args) }] }, { text: "El 4321% de tus ventas, $7,654,321 pesos, viene de ahí." }]);
      const a = await runDataChatTurn({ catalog: buildRestaurantesDataChatCatalog(reader, { verticalRole: "owner" }), scope: OWNER_CFO_SCOPE, question: "dime lo importante de la semana pasada", complete: llm.complete, now: new Date() });
      expect(a.text, tool).not.toMatch(/4321|7,654,321/);
      expect(JSON.stringify(a.blocks.map((b) => b.title)), tool).not.toMatch(/7,654,321/);
    }
  });

  it("con UNA sucursal elegida el summary conserva ventas, pedidos y ticket (alcance neutro, sin el nombre)", async () => {
    const reader = new CfoFakeReader();
    const r = await correr(reader, "cfo_resumen", { ...SEMANA, sucursal: "Altabrisa" });
    const [ventas, pedidos, ticket] = [r.rows[0]!["ventas"] as number, r.rows[0]!["pedidos"] as number, r.rows[0]!["ticket"] as number];
    const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(r.summary).toContain(fmt(ventas));
    expect(r.summary).toContain(`${pedidos} pedidos`);
    expect(r.summary).toContain(fmt(ticket));
    expect(r.summary).toContain("la sucursal elegida");
    expect(r.summary).not.toMatch(/altabrisa/i);
  });

  it("sucursal hostil elegida: conserva la cifra, sin el nombre, y el motor sigue rechazando lo que el modelo derive de él", async () => {
    const reader = new CfoFakeReader({ branches: hostilBranches });
    const r = await correr(reader, "cfo_resumen", { ...SEMANA, sucursal: "Centro" });
    expect(r.status).toBe("ok");
    sinHostil(r);
    expect(r.summary).toContain(`$${(r.rows[0]!["ventas"] as number).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    const llm = scriptedCompletion([{ toolCalls: [{ name: "cfo_resumen", argumentsJson: JSON.stringify({ ...SEMANA, sucursal: "Centro" }) }] }, { text: "El 4321% de tus ventas, $7,654,321 pesos." }]);
    const a = await runDataChatTurn({ catalog: buildRestaurantesDataChatCatalog(reader, { verticalRole: "owner" }), scope: OWNER_CFO_SCOPE, question: "¿cuánto vendió Centro la semana pasada?", complete: llm.complete, now: new Date() });
    expect(a.text).not.toMatch(/4321|7,654,321/);
    expect(a.text).toBe(r.summary);
  });
});
