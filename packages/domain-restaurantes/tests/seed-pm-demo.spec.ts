// R-01 -- seed de la cuenta demo "Los Taquitos de PM": plan, validaciones, salvaguardas de la CLI,
// sincronia de assertions.sql y consistencia de las evals del agente contra el motor REAL de pedidos
// (el menu sembrado + la promocion 2x1 del lunes). Postgres real: scripts/verify-restaurantes-seed-pm/.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { PromotionError } from "../src/errors.ts";
import {
  buildPmSeedPlan,
  COMPORTAMIENTO_MAX,
  extraerComportamiento,
  PmSeedError,
  renderPmSeedDoBlock,
  renderPmSeedPlpgsql,
  renderSchemaPreflightSql,
  slugify,
  validarArchivosAgente,
} from "../src/seed/pm-demo.ts";
import { assertPuedeAplicar, describirObjetivo, parseSeedArgs, SeedTargetError } from "../src/seed/target-safety.ts";
import { construirAssertions } from "../../../scripts/verify-restaurantes-seed-pm/generar-assertions.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { data, agent } = loadSeedInputs();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("buildPmSeedPlan", () => {
  const plan = buildPmSeedPlan(data, agent);

  it("modela las 6 sucursales: 5 activas con datos y T4 registrada, inactiva y sin menu", () => {
    expect(plan.branches).toHaveLength(6);
    expect(plan.branches.filter((b) => b.status === "active").map((b) => b.slug).sort()).toEqual(["altabrisa", "fco-montejo", "garcia-lavin", "pensiones", "prol-montejo"]);
    const t4 = plan.branches.find((b) => b.slug === "t4-pendiente")!;
    expect(t4).toMatchObject({ status: "inactive", menu: null, lat: null, lng: null, phone: null });
  });

  it("251 productos (245 + 6 regionales); los 42 de alcohol son no_domicilio y solo ellos", () => {
    expect(plan.products).toHaveLength(251);
    expect(plan.products.filter((p) => p.noDomicilio)).toHaveLength(42);
    expect(plan.products.find((p) => p.name === "Heineken")!.noDomicilio).toBe(true);
    expect(plan.products.find((p) => p.name === "Taco Al Pastor (individual)")!.noDomicilio).toBe(false);
    // Cervezas mezcla con y sin alcohol: la marca va por producto, no por categoria.
    const cervezas = plan.products.filter((p) => p.categorySlug === "cervezas");
    expect(cervezas.some((p) => p.noDomicilio) && cervezas.some((p) => !p.noDomicilio)).toBe(true);
  });

  it("precios por sucursal: 3 de menu grande x 251 + 2 de menu chico x 245 = 1243", () => {
    expect(plan.summary.branchProducts).toBe(3 * 251 + 2 * 245);
  });

  it("politica PM: franja 12:00-01:00 todos los dias, minimo a domicilio $200, propina solo con tarjeta", () => {
    expect(plan.policy).toEqual({
      horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }],
      pedidoMinimoDomicilio: 200,
      pedidoMinimoRecoger: null,
      propinaPolitica: "solo_tarjeta",
    });
  });

  it("solo se carga el 2x1 del lunes (solo recoger); el combo del martes se reporta como no cargado", () => {
    expect(plan.promotions).toEqual([
      expect.objectContaining({ code: "LUNES2X1PM", type: "bogo", daysOfWeek: [1], channels: ["recoger"], productNames: ["Taco Al Pastor (individual)"] }),
    ]);
    expect(plan.summary.skippedPromotions.join(" ")).toMatch(/PROMO-MAR/);
  });

  it("zonas: solo puntos de sucursales con coordenadas (T3 y T4 no tienen); nada inventado", () => {
    expect(plan.zones.map((z) => z.name).sort()).toEqual(["Francisco de Montejo", "Prolongación Montejo", "Victory Altabrisa", "Victory Platz (García Lavín)"]);
  });

  it("el comportamiento de voz cabe en el tope de la migracion 025 y la voz no se habilita", () => {
    expect(plan.voice.comportamiento.length).toBeLessThanOrEqual(COMPORTAMIENTO_MAX);
    expect(plan.voice.comportamiento).toMatch(/REGLAS DURAS/);
    expect(plan.voice.greetings).toHaveLength(5);
    expect(renderPmSeedPlpgsql(plan)).toMatch(/false, v->'voice'->>'voiceId'/);
  });

  it("el plan es determinista", () => {
    expect(JSON.stringify(buildPmSeedPlan(data, agent))).toBe(JSON.stringify(plan));
  });
});

describe("buildPmSeedPlan -- rechaza datos que rompen el modelo", () => {
  type Mutable = { sucursales: Array<Record<string, unknown>>; productos: Array<Record<string, unknown>>; promociones: Array<Record<string, unknown>>; organizacion: Record<string, unknown>; horario_general: Record<string, unknown>; reglas: Record<string, unknown> };
  const sucursal = (d: Mutable, id: string) => d.sucursales.find((b) => b.id === id)!;
  const casos: Array<[string, (d: Mutable) => void, RegExp]> = [
    ["menos de 6 sucursales", (d) => { d.sucursales.pop(); }, /6 sucursales/],
    ["T4 activa", (d) => { sucursal(d, "T4").activa = true; }, /inactiva|menu/],
    ["sucursal activa sin menu", (d) => { sucursal(d, "T1").menu = null; }, /necesita menu/],
    ["slug duplicado", (d) => { sucursal(d, "T2").slug = "altabrisa"; }, /duplicada/],
    ["lat sin lng", (d) => { sucursal(d, "T1").lng = null; }, /juntas/],
    ["producto con precio 0", (d) => { d.productos[0]!.precio = 0; }, /precio invalido/],
    ["producto duplicado", (d) => { d.productos[1]!.nombre = d.productos[0]!.nombre; }, /duplicado/],
    ["categoria desconocida", (d) => { d.productos[0]!.categoria = "Inventada"; }, /categoria desconocida/],
    ["promocion a domicilio", (d) => { d.promociones[0]!.canales = ["domicilio"]; }, /no aplican a domicilio/],
    ["promocion sobre producto inexistente", (d) => { d.promociones[0]!.productos = ["Fantasma"]; }, /no existe en el menu/],
    ["codigo de promocion invalido", (d) => { d.promociones[0]!.codigo = "mal codigo"; }, /invalido/],
    ["zona horaria invalida", (d) => { d.organizacion.zona_horaria = "Marte/Olimpo"; }, /Zona horaria/],
    ["horario con abre = cierra", (d) => { d.horario_general.cierra = "12:00"; }, /no pueden ser iguales/],
    ["minimo invalido", (d) => { d.reglas.pedido_minimo_domicilio = -5; }, /pedido_minimo_domicilio/],
    ["sin alcohol marcado", (d) => { for (const p of d.productos) p.es_alcohol = false; }, /alcohol/],
  ];
  it.each(casos)("%s", (_nombre, mutar, mensaje) => {
    const copia = clone(data);
    mutar(copia as unknown as Mutable);
    expect(() => buildPmSeedPlan(copia, agent)).toThrow(PmSeedError);
    expect(() => buildPmSeedPlan(copia, agent)).toThrow(mensaje);
  });
});

describe("archivos del agente (prompt, tools, evals)", () => {
  it("son coherentes: 6 herramientas, 68 casos y el prompt las menciona todas", () => {
    const r = validarArchivosAgente(agent);
    expect(r.herramientas).toEqual(["buscar_ultimo_pedido", "asignar_sucursal", "consultar_menu", "cotizar", "crear_comanda", "escalar"]);
    expect(r.casos).toBe(68);
  });

  it("rechaza herramientas duplicadas, casos duplicados y un prompt que no menciona una herramienta", () => {
    const tools = (agent.tools as unknown[]).slice();
    expect(() => validarArchivosAgente({ ...agent, tools: [...tools, tools[0]] })).toThrow(/duplicada/);
    const evals = clone(agent.evals) as { casos: Array<{ id: string }> };
    evals.casos[1]!.id = evals.casos[0]!.id;
    expect(() => validarArchivosAgente({ ...agent, evals })).toThrow(/duplicado/);
    expect(() => validarArchivosAgente({ ...agent, systemPrompt: agent.systemPrompt.replaceAll("escalar", "derivar") })).toThrow(/no menciona/);
    expect(() => validarArchivosAgente({ ...agent, tools: [] })).toThrow(/lista no vacia/);
  });

  it("extraerComportamiento exige las secciones y respeta el tope", () => {
    expect(() => extraerComportamiento(agent.systemPrompt, ["# NO EXISTE"])).toThrow(/no tiene la seccion/);
    expect(() => extraerComportamiento("# A\n" + "x".repeat(COMPORTAMIENTO_MAX), ["# A"])).toThrow(/maximo/);
  });
});

describe("SQL del seed", () => {
  const plan = buildPmSeedPlan(data, agent);

  it("es acotado a la organizacion y no contiene operaciones destructivas", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).not.toMatch(/\bdelete\b|\btruncate\b|\bdrop\b|\balter\b|\bgrant\b|password_hash/i);
    expect(sql).toMatch(/ya existe en otra vertical/);
    // La voz no se vuelve a deshabilitar ni habilitar al re-ejecutar; los usos de la promocion no se reinician.
    expect(sql).not.toMatch(/set[^;]*habilitado/i);
    expect(sql).not.toMatch(/times_used|is_active = excluded/);
  });

  it("el bloque DO usa dollar-quoting propio y el correo del dueño solo enlaza a un usuario existente", () => {
    expect(renderPmSeedDoBlock(plan)).toMatch(/^do \$seed_pm\$[\s\S]*\$seed_pm\$;$/);
    const conDueno = renderPmSeedPlpgsql(plan, { ownerEmail: "Dueno@Ejemplo.com" });
    expect(conDueno).toMatch(/lower\(email\) = 'dueno@ejemplo\.com'/);
    expect(conDueno).toMatch(/no se crea membresia/);
    expect(renderPmSeedPlpgsql(plan)).not.toMatch(/core\.membership/);
    expect(() => renderPmSeedPlpgsql(plan, { ownerEmail: "x'; drop table core.organization; --@a.com" })).toThrow(/ownerEmail invalido/);
  });

  it("los datos con comillas, $ o saltos de linea viajan dentro del JSON sin romper el SQL", () => {
    const copia = clone(data) as unknown as { productos: Array<Record<string, unknown>>; promociones: unknown[] };
    copia.productos[0] = { ...copia.productos[0]!, nombre: "Taco 'del Rey'", descripcion: "linea1\nlinea2 \\ barra" };
    copia.promociones = [];
    const sql = renderPmSeedPlpgsql(buildPmSeedPlan(copia as unknown as typeof data, agent));
    expect(sql).toContain("Taco 'del Rey'");
    const conDelimitador = clone(data) as unknown as { productos: Array<Record<string, unknown>> };
    conDelimitador.productos[0] = { ...conDelimitador.productos[0]!, descripcion: "intento $pm$ cierre" };
    expect(() => renderPmSeedPlpgsql(buildPmSeedPlan(conDelimitador as unknown as typeof data, agent))).toThrow(/delimitador/);
  });

  it("el preflight pide las migraciones 022, 023, 025 y 027", () => {
    const sql = renderSchemaPreflightSql();
    for (const m of ["022_zona_horaria_branch_detail", "023_modelo_pm", "025_voz_config", "027_promociones_2x1"]) expect(sql).toContain(m);
  });

  it("assertions.sql del verify esta sincronizado con el seed (regenerar con generar-assertions.ts)", () => {
    const committed = readFileSync(path.join(HERE, "../../../scripts/verify-restaurantes-seed-pm/assertions.sql"), "utf8");
    expect(committed).toBe(construirAssertions());
  });

  it("slugify quita acentos y signos", () => {
    expect(slugify("Tacos Suizos")).toBe("tacos-suizos");
    expect(slugify("Boyo-Hamburguesas")).toBe("boyo-hamburguesas");
    expect(slugify("Francés Suizo")).toBe("frances-suizo");
    expect(() => slugify("***")).toThrow(PmSeedError);
  });
});

describe("salvaguardas de la CLI", () => {
  it("describe la base sin exponer usuario ni contraseña", () => {
    const t = describirObjetivo("postgresql://postgres:supersecreto@db.abc.supabase.co:6543/postgres");
    expect(t).toMatchObject({ host: "db.abc.supabase.co", port: "6543", database: "postgres", isLocal: false });
    expect(t.label).not.toMatch(/supersecreto|postgres:/);
    expect(t.label).toMatch(/REMOTA/);
  });

  it("localhost, 127.0.0.1, ::1 y socket local son locales", () => {
    for (const url of ["postgresql://u@localhost/db", "postgres://u@127.0.0.1:5433/db", "postgresql://u@[::1]/db", "postgresql:///db?host=/tmp/pgsock"]) {
      expect(describirObjetivo(url).isLocal, url).toBe(true);
    }
  });

  it("sin URL, con URL basura o con otro protocolo se rechaza (y no lee DATABASE_URL)", () => {
    expect(() => describirObjetivo(undefined)).toThrow(/SEED_DATABASE_URL/);
    expect(() => describirObjetivo("   ")).toThrow(SeedTargetError);
    expect(() => describirObjetivo("no es una url")).toThrow(/no es una URL/);
    expect(() => describirObjetivo("mysql://u@h/db")).toThrow(/postgresql/);
  });

  it("sin --apply nunca escribe; local escribe con --apply; remota exige --confirm-host exacto", () => {
    const local = describirObjetivo("postgresql://u@127.0.0.1/db");
    const remota = describirObjetivo("postgresql://u:p@db.prod.example.com/postgres");
    expect(() => assertPuedeAplicar(local, { apply: false, confirmHost: null })).toThrow(/dry-run/);
    expect(() => assertPuedeAplicar(local, { apply: true, confirmHost: null })).not.toThrow();
    expect(() => assertPuedeAplicar(remota, { apply: true, confirmHost: null })).toThrow(/--confirm-host=db\.prod\.example\.com/);
    expect(() => assertPuedeAplicar(remota, { apply: true, confirmHost: "otro.host.com" })).toThrow(/no coincide/);
    expect(() => assertPuedeAplicar(remota, { apply: true, confirmHost: "DB.PROD.EXAMPLE.COM" })).not.toThrow();
  });

  it("parsea banderas y rechaza las desconocidas", () => {
    expect(parseSeedArgs([])).toEqual({ apply: false, confirmHost: null, ownerEmail: null, help: false, demo: false });
    expect(parseSeedArgs(["--apply", "--confirm-host=h", "--owner-email=a@b.co"])).toEqual({ apply: true, confirmHost: "h", ownerEmail: "a@b.co", help: false, demo: false });
    expect(() => parseSeedArgs(["--force"])).toThrow(/desconocido/);
  });
});

// ---- Evals del agente vs. el motor real de pedidos ---------------------------------------------------
type EvalCaso = {
  id: string;
  contexto: { dia: string; sucursal_contexto: string };
  esperado: { comanda?: { tipo: string; sucursal: string; total_mxn?: number | null; items: Array<{ producto: string; piezas: number }> } };
};

function seedRepoDesdePlan() {
  const plan = buildPmSeedPlan(data, agent);
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: plan.organization.slug, name: plan.organization.name });
  const categoryIds = new Map<string, string>();
  for (const c of plan.categories) {
    const id = randomUUID();
    categoryIds.set(c.slug, id);
    repo.seedCategory({ id, organizationId, name: c.name, slug: c.slug, displayOrder: c.displayOrder });
  }
  const productIds = new Map<string, string>();
  for (const p of plan.products) {
    const id = randomUUID();
    productIds.set(p.name, id);
    repo.seedProduct({ id, organizationId, categoryId: categoryIds.get(p.categorySlug)!, name: p.name, description: p.description, searchKeywords: [], price: p.price, isPopular: p.isPopular, displayOrder: p.displayOrder });
    if (p.noDomicilio) repo.seedNoDomicilio({ productIds: [id] });
  }
  const propertyBySlug = new Map<string, string>();
  for (const b of plan.branches) {
    const propertyId = randomUUID();
    propertyBySlug.set(b.slug, propertyId);
    repo.seedBranch({ propertyId, organizationId, name: b.name, slug: b.slug, status: b.status, phone: b.phone, address: b.address, lat: b.lat, lng: b.lng });
    if (!b.menu) continue;
    for (const p of plan.products) {
      if (b.menu === "grande" || p.scope === "todas") repo.seedBranchProduct({ propertyId, productId: productIds.get(p.name)!, price: p.price, isAvailable: true });
    }
    repo.seedBranchPolicy(propertyId, { pedidoMinimoDomicilio: plan.policy.pedidoMinimoDomicilio, propinaPolitica: "solo_tarjeta" });
  }
  return { plan, repo, organizationId, propertyBySlug, productIds };
}

describe("evals del agente vs. el motor real de pedidos (menu sembrado + 2x1 del lunes)", () => {
  afterEach(() => vi.useRealTimers());

  it("el seed deja el menu consultable por sucursal: el menu chico no tiene comida regional", async () => {
    const { repo, propertyBySlug } = seedRepoDesdePlan();
    const chico = await repo.listAvailableProductsForBranch(propertyBySlug.get("fco-montejo")!);
    const grande = await repo.listAvailableProductsForBranch(propertyBySlug.get("altabrisa")!);
    expect(chico.some((p) => p.name === "Sopa de Lima")).toBe(false);
    expect(grande.some((p) => p.name === "Sopa de Lima")).toBe(true);
    expect(await repo.listAvailableProductsForBranch(propertyBySlug.get("t4-pendiente")!)).toEqual([]);
  });

  it("cada comanda esperada por las evals existe en el menu y su total coincide con el motor de pedidos", async () => {
    const casos = (agent.evals as { casos: EvalCaso[] }).casos.filter((c) => c.esperado.comanda?.items?.length);
    expect(casos.length).toBeGreaterThan(20);
    const idPorBranch = new Map(data.sucursales.map((b) => [b.id, b.slug]));
    const diasJs: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, "miércoles": 3, jueves: 4, viernes: 5, sabado: 6, "sábado": 6 };
    const discrepancias: string[] = [];

    for (const caso of casos) {
      const comanda = caso.esperado.comanda!;
      const { repo, organizationId, plan } = seedRepoDesdePlan();
      await repo.createPromotion(organizationId, {
        code: "LUNES2X1PM",
        name: plan.promotions[0]!.name,
        type: "bogo",
        value: 1,
        daysOfWeek: plan.promotions[0]!.daysOfWeek,
        channels: ["recoger"],
        productIds: [...(await repo.listProducts(organizationId))].filter((p) => p.name === "Taco Al Pastor (individual)").map((p) => p.id),
      });
      const slug = idPorBranch.get(comanda.sucursal)!;
      const esLunesRecoger = caso.contexto.dia.toLowerCase() === "lunes" && comanda.tipo === "recoger";
      const pastor = comanda.items.find((i) => i.producto === "Taco Al Pastor (individual)");
      const aplicaPromo = esLunesRecoger && !!pastor && pastor.piezas >= 2;
      // Hora fija: lunes 14:00 en Merida para los casos de lunes; martes para el resto no importa (sin promo).
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 28, 20, 0, 0) + ((((diasJs[caso.contexto.dia.toLowerCase()] ?? 1) - 1 + 7) % 7) * 24 * 3600 * 1000)));
      const products = await repo.listProducts(organizationId);
      const items = [];
      let faltante = false;
      for (const it of comanda.items) {
        const product = products.find((p) => p.name === it.producto);
        if (!product) {
          discrepancias.push(`${caso.id}: el producto "${it.producto}" no existe en el menu sembrado`);
          faltante = true;
          continue;
        }
        items.push({ productId: product.id, requestedQuantity: it.piezas, ...(/^Tacos? /i.test(it.producto) ? { tortilla: "maiz" as const } : {}) });
      }
      if (faltante) continue;
      try {
        const order = await createOrder(repo, {
          organizationId,
          branchSlug: slug,
          customerName: "Cliente Eval",
          customerPhone: "9995550101",
          customerAddress: comanda.tipo === "domicilio" ? "Calle 7 #210 x 4 y 6, Vista Alegre" : undefined,
          canal: comanda.tipo === "recoger" ? "recoger" : "domicilio",
          items,
          source: "web",
          ...(aplicaPromo ? { promoCode: "LUNES2X1PM" } : {}),
        });
        if (typeof comanda.total_mxn === "number" && Math.abs(order.total - comanda.total_mxn) > 0.01) {
          discrepancias.push(`${caso.id}: total esperado ${comanda.total_mxn}, el motor calcula ${order.total}`);
        }
      } catch (err) {
        if (err instanceof PromotionError) discrepancias.push(`${caso.id}: ${err.message}`);
        else discrepancias.push(`${caso.id}: el motor rechazo la comanda esperada -> ${(err as Error).message}`);
      }
      vi.useRealTimers();
    }
    // HALLAZGO REAL de este seed: en 11 casos las evals del experto usan `piezas` como numero de ORDENES
    // para productos que se venden por orden de N (gringas/mestizas de 2, alambres/suizos de 5) mientras que
    // para los tacos de bistec (orden de 3) lo usan como PIEZAS (L05: 6 piezas = 2 ordenes = $388). El motor de
    // pedidos es consistente (siempre piezas), asi que esos casos no pueden coincidir hasta que el experto
    // unifique la semantica. Se fija la lista exacta: si el motor o el menu cambian y aparece OTRA
    // discrepancia, este test falla; si el experto corrige las evals, falla pidiendo vaciar la lista.
    const SEMANTICA_PIEZAS_AMBIGUA_EN_EVALS = ["C04", "C08", "C09", "C11", "C13", "C20", "L03", "L17", "L22", "L25", "L46"];
    expect(discrepancias.map((d) => d.split(":")[0]).sort()).toEqual(SEMANTICA_PIEZAS_AMBIGUA_EN_EVALS);
    // Todos los demas casos (incluidos los 2x1 del lunes: L02, L30, C06) cuadran al centavo con el motor real.
    expect(casos.length - discrepancias.length).toBeGreaterThanOrEqual(20);
  });
});
