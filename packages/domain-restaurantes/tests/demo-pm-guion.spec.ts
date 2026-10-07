// DEMO-PM -- el guion `docs/demo-pm/guion.md` no promete nada que el codigo no haga: cada cifra que cita sale del motor real de pedidos
// sobre el catalogo sembrado de T7, los pines asignan la sucursal que dice el guion, los escenarios salen de los 71 de eval (activos) y las
// reglas conversacionales que el guion atribuye al agente estan en su prompt. Si cambia un precio o el prompt, este archivo falla.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { cargarEscenariosT7 } from "../src/evals/agente-pm/escenarios-t7.ts";
import { quoteOrder } from "../src/orders.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { formatLocationMessage, parseSharedLocation } from "../src/whatsapp/location.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const RAIZ = new URL("../../../", import.meta.url);
const guion = readFileSync(new URL("docs/demo-pm/guion.md", RAIZ), "utf8");
const runbook = readFileSync(new URL("docs/demo-pm/runbook.md", RAIZ), "utf8");

interface Cifras {
  pedidoMinimo: { renglones: Array<[string, number]>; suma: number; faltan: number };
  pines: Array<{ escenario: number; lat: number; lng: number; sucursal: string; telefono?: string }>;
  escenarios: Array<{ n: number; ids: string[]; canal: "recoger" | "domicilio"; renglones: Array<[string, number, ("maiz" | "harina" | "mixta")?]>; dobleSalsas?: ("crema_ajo" | "salsa_verde")[]; total: number }>;
  conversacionales: Array<{ n: number; ids: string[] }>;
  reglasDelPrompt: Record<string, string>;
}
const bloque = /```json cifras-guion\n([\s\S]*?)\n```/.exec(guion);
const cifras = JSON.parse(bloque![1]!) as Cifras;

const pesos = (n: number) => `$${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;
/** Texto de la seccion `## Escenario N:` (hasta el siguiente `## `). */
function seccion(n: number): string {
  const inicio = guion.indexOf(`## Escenario ${n}:`);
  expect(inicio, `existe la seccion del escenario ${n}`).toBeGreaterThanOrEqual(0);
  const fin = guion.indexOf("\n## ", inicio + 5);
  return guion.slice(inicio, fin < 0 ? undefined : fin);
}

describe("estructura del guion", () => {
  it("trae 10 escenarios (el encargo pide 8 a 12), cada uno con su origen en los escenarios de eval y la etiqueta [Servidor] o [Agente]", () => {
    const titulos = [...guion.matchAll(/^## Escenario (\d+):/gm)].map((m) => Number(m[1]));
    expect(titulos).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const n of titulos) {
      const t = seccion(n);
      expect(t, `escenario ${n}`).toMatch(/\*Origen: [^*]*T7-\d{3}/);
      expect(t, `escenario ${n}`).toMatch(/\*\*Se ve \[(Servidor|Agente)\]\*\*/);
      expect(t, `escenario ${n}`).toContain("**Se escribe**");
    }
  });

  it("los escenarios que dependen del pedido del 1 (7, 8 y 10) mandan a la pestana A y los demas a la B, porque 'Nueva conversacion' borra la sesion", () => {
    expect(guion).toContain("**«Nueva conversación» la borra**");
    expect(seccion(1)).toContain("pestaña A");
    for (const n of [7, 8, 10]) expect(seccion(n), `escenario ${n}`).toContain("pestaña A");
    for (const n of [7, 8, 10]) expect(seccion(n), `escenario ${n}`).not.toMatch(/Nueva conversaci[oó]n\*\*/);
    for (const n of [2, 3, 4, 5, 6, 9]) expect(seccion(n), `escenario ${n}`).toContain("pestaña B");
    expect(seccion(10)).toContain("En preparación");
  });

  it("el escenario 8 deja la toma de la queja cerrada antes del 9 y el 10 (con una toma abierta el agente calla, R-21) y el 1 cierra su carrito", () => {
    const s8 = seccion(8);
    expect(s8).toMatch(/Tomar conversaci[oó]n/);
    expect(s8).toMatch(/Marcar como resuelta/);
    expect(s8.indexOf("Marcar como resuelta")).toBeGreaterThan(s8.indexOf("`queja`"));
    expect(seccion(10)).toMatch(/resuelta/);
    expect(seccion(1)).toContain("No, gracias, era para saber");
  });

  it("cubre lo que pidio el encargo: recurrente, todas las salsas, 1/4 de kilo, fuera de zona, cambio tras confirmar, queja por faltante y factura", () => {
    const temas: Array<[string, RegExp]> = [
      ["pedido recurrente", /recurrente/i],
      ["todas las salsas", /todas las salsas/i],
      ["1/4 de kilo", /cuarto/i],
      ["fuera de zona", /fuera de zona/i],
      ["cambio tras confirmar", /despu[eé]s de confirmar/i],
      ["queja por faltante", /queja por un faltante/i],
      ["factura", /factura/i],
    ];
    for (const [tema, re] of temas) expect(re.test(guion), tema).toBe(true);
  });

  it("cada escenario cita ids que EXISTEN en los 71 y estan ACTIVOS (ninguno pendiente de decision)", () => {
    const suite = cargarEscenariosT7();
    const activos = new Map(suite.escenarios.map((e) => [e.id, e.estado]));
    const todos = [...cifras.escenarios, ...cifras.conversacionales];
    for (const e of todos) {
      for (const id of e.ids) {
        expect(activos.get(id), `${id} (escenario ${e.n})`).toBe("activo");
        expect(seccion(e.n), `${id} aparece en la seccion ${e.n}`).toContain(id);
      }
    }
    expect(new Set(todos.map((e) => e.n))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });

  it("repo publico: ni correos ni enlaces reales ni datos personales; los telefonos del guion son ficticios", () => {
    expect(guion).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(guion).not.toMatch(/https?:\/\/(?!<)/);
    const telefonos = [...guion.matchAll(/(?<![\d.-])\d{10}(?![\d.])/g)].map((m) => m[0]);
    expect(telefonos.length).toBeGreaterThan(0);
    for (const t of telefonos) expect(t.startsWith("999000"), `telefono ficticio ${t}`).toBe(true);
  });

  it("el guion y el runbook se citan entre si y existen los scripts npm que mencionan", () => {
    expect(guion).toContain("docs/demo-pm/runbook.md");
    expect(runbook).toContain("docs/demo-pm/guion.md");
    const pkg = JSON.parse(readFileSync(new URL("package.json", RAIZ), "utf8")) as { scripts: Record<string, string> };
    for (const script of new Set([...guion.matchAll(/npm run (demo:[a-z]+)/g)].map((m) => m[1]!))) expect(pkg.scripts[script], script).toBeDefined();
    for (const script of new Set([...runbook.matchAll(/npm run (demo:[a-z]+)/g)].map((m) => m[1]!))) expect(pkg.scripts[script], script).toBeDefined();
    expect(existsSync(new URL("scripts/seed-pm-demo/demo-pm.mjs", RAIZ))).toBe(true);
  });
});

describe("las cifras del guion salen del motor real sobre el catalogo de T7", () => {
  const { data, agent } = loadSeedInputs();
  const plan = buildPmSeedPlan(data, agent);

  async function conMundo<T>(fn: (world: Awaited<ReturnType<typeof buildInMemoryPmWorld>>) => Promise<T>): Promise<T> {
    // Martes 14:00 en Merida: T7 abierta y sin promocion; el reloj se fija porque el horario se evalua con la hora real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T20:00:00Z"));
    try {
      return await fn(await buildInMemoryPmWorld(plan));
    } finally {
      vi.useRealTimers();
    }
  }

  it.each(cifras.escenarios.map((e) => [`escenario ${e.n}: ${e.renglones.map((r) => `${r[1]} x ${r[0]}`).join(" + ")}`, e] as const))("%s", async (_nombre, e) => {
    const total = await conMundo(async (world) => {
      const q = await quoteOrder(world.repo, {
        organizationId: world.organizationId,
        branchSlug: "garcia-lavin",
        canal: e.canal,
        ...(e.canal === "domicilio" ? { colonia: "Temozón Norte" } : {}),
        items: e.renglones.map(([producto, requestedQuantity, tortilla]) => ({ productId: world.productIds.get(producto)!, requestedQuantity, ...(tortilla ? { tortilla } : {}) })),
        ...(e.dobleSalsas ? { doubleSalsas: e.dobleSalsas } : {}),
      });
      return q.total;
    });
    expect(total).toBe(e.total);
    expect(seccion(e.n), `el guion cita ${pesos(e.total)}`).toContain(pesos(e.total));
  });

  it("escenario 6: el motor rechaza el pedido a domicilio por debajo del minimo con las cifras que cita el guion", async () => {
    const mensaje = await conMundo(async (world) => {
      try {
        await quoteOrder(world.repo, {
          organizationId: world.organizationId,
          branchSlug: "garcia-lavin",
          canal: "domicilio",
          items: cifras.pedidoMinimo.renglones.map(([producto, requestedQuantity]) => ({ productId: world.productIds.get(producto)!, requestedQuantity })),
        });
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(mensaje).toContain(`$${cifras.pedidoMinimo.suma}`);
    expect(mensaje).toContain(`faltan $${cifras.pedidoMinimo.faltan}`);
    expect(seccion(6)).toContain(`$${cifras.pedidoMinimo.suma}; faltan $${cifras.pedidoMinimo.faltan}`);
  });

  it("escenario 4: 4 tacos de bistec se rechazan con 'puedes pedir 3 o 6'", async () => {
    const mensaje = await conMundo(async (world) => {
      try {
        await quoteOrder(world.repo, { organizationId: world.organizationId, branchSlug: "garcia-lavin", canal: "recoger", items: [{ productId: world.productIds.get("Tacos de Bistec de Res (orden de 3)")!, requestedQuantity: 4, tortilla: "maiz" }] });
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(mensaje).toContain("Pediste 4; puedes pedir 3 o 6");
    expect(seccion(4)).toContain("Pediste 4; puedes pedir 3 o 6");
  });

  it("los pines que el guion manda a escribir son el marcador real de ubicacion y asignan la sucursal que dice el guion (via coordenadas)", async () => {
    for (const pin of cifras.pines) {
      const marcador = formatLocationMessage({ latitude: pin.lat, longitude: pin.lng });
      expect(parseSharedLocation(marcador)).toEqual({ lat: pin.lat, lng: pin.lng });
      expect(seccion(pin.escenario), `escenario ${pin.escenario} escribe el marcador exacto`).toContain(marcador);
      const r = await conMundo((world) => invokeAgentTool(world.repo, { organizationId: world.organizationId, channel: "whatsapp" } as never, "buscar_sucursal_cercana", { colonia: "Vergel", lat: pin.lat, lng: pin.lng }));
      expect((r as { result: unknown }).result).toMatchObject({ encontrada: true, branch_slug: pin.sucursal, via: "coordenadas" });
      if (pin.telefono) {
        expect(seccion(pin.escenario)).toContain(pin.telefono);
        expect(data.sucursales.find((s: { slug: string }) => s.slug === pin.sucursal)!.telefono).toBe(pin.telefono);
      }
    }
  });

  it("sin pin, una colonia que el negocio aun no cargo NO se reconoce (por eso el agente pide el pin): la nota honesta del guion es cierta", async () => {
    const r = await conMundo((world) => invokeAgentTool(world.repo, { organizationId: world.organizationId, channel: "whatsapp" } as never, "buscar_sucursal_cercana", { colonia: "Vergel" }));
    expect((r as { result: unknown }).result).toMatchObject({ encontrada: false, estado: "no_reconocida" });
    expect(guion).toContain("mapa de colonias");
  });

  it("QA-PM-R2: el relleno del modelo (lat 0, lng 0, max_km 0) se ignora: ni cae a 9,967 km (fuera de zona) ni rechaza el radio; manda la colonia", async () => {
    const relleno = { colonia: "Vergel", lat: 0, lng: 0, max_km: 0 };
    const sinRelleno = await conMundo((world) => invokeAgentTool(world.repo, { organizationId: world.organizationId, channel: "whatsapp" } as never, "buscar_sucursal_cercana", { colonia: "Vergel" }));
    const conRelleno = await conMundo((world) => invokeAgentTool(world.repo, { organizationId: world.organizationId, channel: "whatsapp" } as never, "buscar_sucursal_cercana", relleno));
    expect((conRelleno as { result: unknown }).result).toEqual((sinRelleno as { result: unknown }).result);
  });
});

describe("lo que el guion atribuye al agente esta en su prompt y en sus datos", () => {
  const { data } = loadSeedInputs();
  const prompt = buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: "el asistente virtual",
    deliveryTimeText: data.agente_whatsapp.tiempo_entrega,
    saludo: "Buenas noches",
    branches: [],
    entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" },
    customer: { isNew: true },
  });

  it("las reglas conversacionales de los escenarios 7 a 10 existen en el prompt del perfil taqueria_pm", () => {
    for (const [n, regla] of Object.entries(cifras.reglasDelPrompt)) {
      expect(prompt, `escenario ${n}: ${regla}`).toContain(regla);
    }
    expect(prompt).toContain("cancelacion_modificacion");
    expect(prompt).toContain("tiempos_entrega");
  });

  it("las salsas basicas, el pin opcional (una sola vez), la repeticion en lista, la propina solo con tarjeta y 'ofrezca recoger' (escenarios 1, 2 y 5) estan en el prompt", () => {
    expect(prompt).toContain("roja, verde, cebolla con cilantro y limones");
    expect(prompt).toMatch(/PIN A REPARTO \(ayuda opcional, no requisito\): ofrézcalo UNA SOLA VEZ/);
    expect(prompt).toContain("Permítame repetirle su pedido");
    expect(prompt).toContain("No pregunte propina con efectivo");
    expect(prompt).toMatch(/ofrezca recoger en la sucursal de este chat/);
    expect(prompt).toContain("CLIENTE RECURRENTE");
  });

  it("los tiempos que promete el guion (60 a 75 min, pico 75 a 90) son los sembrados para T7 (fila propia de T7; la de la organizacion lleva el dato del dueño)", () => {
    const t7 = data.agente_whatsapp.tiempo_entrega_por_sucursal!.T7!;
    expect(t7).toContain("60 a 75");
    expect(t7).toContain("75 a 90");
    expect(guion).toContain("60 a 75");
    expect(guion).toContain("75 a 90");
  });

  it("las cifras del panel que cita el guion son las del perfil de volumen t7", async () => {
    const { DEMO_PERFIL_T7 } = await import("../src/seed/demo-volume.ts");
    expect(guion).toContain(`**${DEMO_PERFIL_T7.pedidos} pedidos en ${DEMO_PERFIL_T7.dias} días, solo T7**`);
    expect(guion).toContain(`${DEMO_PERFIL_T7.clientesRecurrentes} son recurrentes`);
    expect(Math.round((DEMO_PERFIL_T7.pedidosRecurrentes / DEMO_PERFIL_T7.pedidos) * 100)).toBe(73);
    expect(guion).toContain("**73 %**");
  });
});
