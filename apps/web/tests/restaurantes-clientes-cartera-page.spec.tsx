// @vitest-environment jsdom
//
// Clientes por nivel: filtros resueltos en el servidor (nivel, frecuencia, dias sin pedir, sucursal), KPIs de cartera con el cliente mas
// frecuente enmascarado, "Importar clientes" real (CSV -> mapeo -> vista previa -> importar) y los estados honestos de la base sin migrar.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { ClientesListPage } from "../src/verticals/restaurantes/pages/Clientes.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, valorDe, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const BASE = "https://api.test/v1/restaurantes/prop-1/admin/customers";

const CLIENTES = [
  { id: "c1", name: "Ana Torres", phone: "9991230001", orderCount: 5, tier: "BLACK", lastOrderAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
  { id: "c2", name: null, phone: "9991230002", orderCount: 0, tier: null, lastOrderAt: null },
];
const KPIS = { disponible: true, total: 11, recurrentes: 4, ticketPromedio: 250.5, masFrecuente: { nombre: "Ana Torres", telefonoEnmascarado: "******0001", pedidos: 5, diasDesdeUltimoPedido: 2 } };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

function stub(opts: { lista?: unknown; kpis?: unknown; branches?: unknown } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/admin/customers/kpis")) return json(opts.kpis ?? KPIS);
    if (url === "https://api.test/v1/restaurantes/demo/admin/branches") return json(opts.branches ?? { branches: [{ propertyId: "prop-1", name: "Centro", slug: "c" }, { propertyId: "prop-2", name: "Norte", slug: "n" }] });
    if (url.endsWith("/customers/import/preview") && method === "POST") return json({ total: 3, validos: 2, duplicadosEnArchivo: 0, totalErrores: 1, errores: [{ renglon: 3, motivo: "Telefono invalido: se esperan 10 digitos (se acepta +52 o 521 al inicio)." }], muestra: [{ nombre: "Ana", telefonoEnmascarado: "******0001", direccion: null, notas: null }] });
    if (url.endsWith("/customers/import") && method === "POST") return json({ resultado: { yaImportado: false, total: 3, creados: 2, actualizados: 0, sinCambios: 0, rechazados: 1, errores: [] } });
    if (url.startsWith(BASE) && method === "GET") return json(opts.lista ?? { customers: CLIENTES, nextCursor: null, filtrosDisponibles: true });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const listados = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(BASE) && !u.includes("/kpis") && !u.includes("/import"));
const q = (sel: string) => rendered!.container.querySelector<HTMLElement>(sel);
const montar = (ctx: RestaurantesShellContext = CTX) => {
  rendered = renderComponent(
    <MemoryRouter>
      <ClientesListPage {...ctx} />
    </MemoryRouter>,
  );
};

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ClientesListPage -- cartera por nivel", () => {
  it("muestra los KPIs reales de la cartera con el cliente mas frecuente enmascarado", async () => {
    stub();
    montar();
    await esperar();
    const kpis = q("[data-testid='cartera-kpis']")!.textContent!;
    expect(kpis).toContain("11");
    expect(kpis).toContain("4");
    expect(kpis).toContain("$250.50");
    expect(kpis).toContain("5 pedidos");
    expect(kpis).toContain("******0001");
    expect(kpis).toContain("último pedido hace 2 d");
  });

  it("cada cliente trae su nivel y cuanto hace que pidio", async () => {
    stub();
    montar();
    await esperar();
    const texto = rendered!.container.textContent!;
    expect(texto).toContain("Black");
    expect(texto).toContain("Último pedido hace 2 d");
    expect(texto).toContain("Aún no ha pedido");
  });

  it("los filtros viajan al servidor: nivel, frecuencia, dias sin pedir y sucursal", async () => {
    stub();
    montar();
    await esperar();
    elegirValor(q("#restaurantes-clientes-nivel"), "GOLD");
    await esperar();
    elegirValor(q("#restaurantes-clientes-frecuencia"), "recurrentes");
    await esperar();
    elegirValor(q("#restaurantes-clientes-inactivo"), "30");
    await esperar();
    elegirValor(q("#restaurantes-clientes-sucursal"), "prop-2");
    await esperar();
    const url = new URL(listados().at(-1)!);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ nivel: "GOLD", frecuencia: "recurrentes", inactivoDias: "30", branchId: "prop-2", limit: "50" });
  });

  it("sin coincidencias dice que ningun cliente coincide con los filtros", async () => {
    stub({ lista: { customers: [], nextCursor: null, filtrosDisponibles: true } });
    montar();
    await esperar();
    elegirValor(q("#restaurantes-clientes-nivel"), "BLUE");
    await esperar();
    expect(rendered!.container.textContent).toContain("Ningún cliente coincide con estos filtros.");
  });

  it("'Ver mas clientes' pide la siguiente pagina con el cursor y suma sin repetir", async () => {
    stub({ lista: { customers: [CLIENTES[0]], nextCursor: "c1", filtrosDisponibles: true } });
    montar();
    await esperar();
    const boton = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Ver más clientes"))!;
    click(boton);
    await esperar();
    expect(new URL(listados().at(-1)!).searchParams.get("cursor")).toBe("c1");
  });

  it("base sin la migracion 054: avisa que los filtros y el resumen aun no estan disponibles (sin KPIs inventados)", async () => {
    stub({ lista: { customers: [], nextCursor: null, filtrosDisponibles: false }, kpis: { disponible: false } });
    montar();
    await esperar();
    expect(q("[data-testid='clientes-filtros-sin-migracion']")!.textContent).toContain("migración 054");
    expect(q("[data-testid='cartera-kpis-sin-migracion']")).not.toBeNull();
    expect(q("[data-testid='cartera-kpis']")).toBeNull();
    expect(rendered!.container.textContent).not.toContain("Ningún cliente coincide");
  });

  it("si el servidor falla muestra el error", async () => {
    fetchMock = vi.fn(async (url: string) => (url.includes("/kpis") ? json({}, 500) : json({ error: "boom" }, 500)));
    vi.stubGlobal("fetch", fetchMock);
    montar();
    await esperar();
    expect(rendered!.container.textContent).toMatch(/No se pudo|boom/);
  });
});

describe("ClientesListPage -- importar clientes", () => {
  it("el repartidor/rol sin gestion no ve el boton; owner y staff si", async () => {
    stub();
    montar({ ...CTX, role: "repartidor" });
    await esperar();
    expect([...rendered!.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Importar clientes"))).toBe(false);
    rendered!.unmount();
    stub();
    montar({ ...CTX, role: "staff" });
    await esperar();
    expect([...rendered!.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Importar clientes"))).toBe(true);
  });

  it("flujo completo: CSV -> mapeo sugerido -> vista previa con errores por renglon -> importar -> resultado y refresco", async () => {
    stub();
    montar();
    await esperar();
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Importar clientes"))!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    expect(dialogo.textContent).toContain("no crea pedidos ni manda mensajes");
    const archivo = dialogo.querySelector<HTMLInputElement>("#clientes-import-archivo")!;
    const file = new File(["Nombre,Teléfono\nAna,9991230001\nBruno,+52 999 123 0002\nMal,123\n"], "cartera.csv", { type: "text/csv" });
    Object.defineProperty(archivo, "files", { value: [file], configurable: true });
    await act(async () => {
      archivo.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 20; i++) await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(dialogo.textContent).toContain("3 renglones de datos");
    expect(valorDe(dialogo.querySelector("#clientes-import-telefono"))).toBe("1");
    expect(valorDe(dialogo.querySelector("#clientes-import-nombre"))).toBe("0");

    const revisar = [...dialogo.querySelectorAll("button")].find((b) => b.textContent?.includes("Revisar vista previa"))!;
    click(revisar);
    await esperar();
    expect(document.body.querySelector("[data-testid='importar-vista-previa']")!.textContent).toContain("Renglón 3: Telefono invalido");
    const previa = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/import/preview"))!;
    const cuerpoPrevia = JSON.parse(String((previa[1] as RequestInit).body)) as { huella: string; filas: Array<{ telefono: string; nombre: string }> };
    expect(cuerpoPrevia.huella).toMatch(/^[0-9a-f]{64}$/);
    expect(cuerpoPrevia.filas).toHaveLength(3);
    expect(cuerpoPrevia.filas[1]).toMatchObject({ telefono: "+52 999 123 0002", nombre: "Bruno" });

    const importar = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes("Importar 2 clientes"))!;
    click(importar);
    await esperar();
    expect(document.body.querySelector("[data-testid='importar-resultado']")!.textContent).toContain("Clientes nuevos");
    const aplicar = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/customers/import") && (c[1] as RequestInit).method === "POST")!;
    expect(JSON.parse(String((aplicar[1] as RequestInit).body)).huella).toBe(cuerpoPrevia.huella);
    // refresco de lista y KPIs tras importar
    expect(listados().length).toBeGreaterThanOrEqual(2);
  });

  it("un archivo con formato no admitido muestra el error y no llama al servidor", async () => {
    stub();
    montar();
    await esperar();
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Importar clientes"))!);
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    const archivo = dialogo.querySelector<HTMLInputElement>("#clientes-import-archivo")!;
    Object.defineProperty(archivo, "files", { value: [new File(["x"], "clientes.pdf", { type: "application/pdf" })], configurable: true });
    await act(async () => {
      archivo.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 20; i++) await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(dialogo.textContent).toContain("Formato no admitido");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/import"))).toBe(false);
  });
});
