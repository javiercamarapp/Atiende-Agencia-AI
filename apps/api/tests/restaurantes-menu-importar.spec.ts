// Importador de menu (alta autoservicio) de punta a punta contra el doble en memoria y un gateway falso (sin red): extraer (CSV, PDF y
// foto por bytes magicos; nunca escribe) -> guardar lo aprobado (categorias + productos + precio en la sucursal, sin duplicar).
import { beforeEach, describe, expect, it } from "vitest";
import { KillSwitchEngagedError, type LlmGateway } from "@atiende/agent-core";
import { resetDefaultRateLimiterForTests } from "@atiende/core-ratelimit";
import { buildApp } from "../src/app.ts";
import { tipoPorBytes } from "../src/routes/verticals/restaurantes/admin-menu-importar.ts";
import { authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n%%EOF").toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
const EXE = Buffer.from("MZ\x90\x00 esto no es un menu").toString("base64");

interface Llamada {
  role: string;
  request: { messages: Array<{ archivos?: Array<{ kind: string; mimeType: string }> }>; responseFormat?: { name: string } };
}

function gatewayFalso(respuesta: unknown | Error) {
  const llamadas: Llamada[] = [];
  const gateway = {
    complete: async (opts: Llamada) => {
      llamadas.push(opts);
      if (respuesta instanceof Error) throw respuesta;
      return { text: JSON.stringify(respuesta), model: "google/gemini-3.5-flash-lite" };
    },
  } as unknown as LlmGateway;
  return { gateway, llamadas };
}

const EXTRACCION = {
  productos: [
    { nombre: "Taco de pastor", categoria: "Tacos", descripcion: null, precio: 25, esPaquete: false, incluye: [] },
    { nombre: "Gringa", categoria: "Tacos", descripcion: null, precio: null, esPaquete: false, incluye: [] },
    { nombre: "Combo 2", categoria: "", descripcion: null, precio: 150, esPaquete: true, incluye: ["2 tacos", "refresco"] },
  ],
};

async function setup(gateway?: LlmGateway) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp({ ...ctx.deps, llmGateway: gateway });
  const url = (accion: "extraer" | "guardar") => `/v1/restaurantes/${ctx.propertyIdA}/admin/menu/importar/${accion}`;
  return { ctx, app, url };
}

beforeEach(() => resetDefaultRateLimiterForTests());

describe("POST …/admin/menu/importar/extraer", () => {
  it("PDF: llama al rol restaurantes:extraccion_menu con el archivo como parte pdf y esquema estricto; devuelve borrador con dudas; no escribe", async () => {
    const g = gatewayFalso(EXTRACCION);
    const t = await setup(g.gateway);
    const antes = (await t.ctx.restaurantesRepo.listProducts(t.ctx.organizationId)).length;
    const res = await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.owner.token, { archivo: { nombre: "menu.pdf", base64: PDF } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fuente: string; borrador: { productos: Array<{ nombre: string; precio: number | null; dudas: string[]; categoria: string }> } };
    expect(body.fuente).toBe("vision");
    expect(body.borrador.productos.map((p) => [p.nombre, p.precio, p.dudas, p.categoria])).toEqual([
      ["Taco de pastor", 25, [], "Tacos"],
      ["Gringa", null, ["sin_precio"], "Tacos"],
      ["Combo 2", 150, [], "Paquetes"],
    ]);
    expect(g.llamadas[0]!.role).toBe("restaurantes:extraccion_menu");
    expect(g.llamadas[0]!.request.messages[0]!.archivos).toEqual([expect.objectContaining({ kind: "pdf", mimeType: "application/pdf" })]);
    expect(g.llamadas[0]!.request.responseFormat?.name).toBe("menu_restaurante");
    expect((await t.ctx.restaurantesRepo.listProducts(t.ctx.organizationId)).length).toBe(antes);
  });

  it("foto PNG: parte imagen; el tipo sale de los bytes, no del nombre", async () => {
    const g = gatewayFalso(EXTRACCION);
    const t = await setup(g.gateway);
    const res = await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.owner.token, { archivo: { nombre: "menu.pdf", base64: PNG } }));
    expect(res.status).toBe(200);
    expect(g.llamadas[0]!.request.messages[0]!.archivos![0]).toMatchObject({ kind: "imagen", mimeType: "image/png" });
  });

  it("CSV: sin modelo (funciona aunque no haya gateway)", async () => {
    const t = await setup(undefined);
    const res = await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.owner.token, { csv: "nombre,categoria,precio\nSope,Antojitos,40\n" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { fuente: string }).fuente).toBe("csv");
  });

  it("rechazos: formato no soportado 400, CSV sin columnas 400, sin gateway 503, interruptor apagado 503, staff 403, otra organizacion 403", async () => {
    const t = await setup(gatewayFalso(EXTRACCION).gateway);
    expect((await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.owner.token, { archivo: { base64: EXE } }))).status).toBe(400);
    expect((await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.owner.token, { csv: "a,b\n1,2" }))).status).toBe(400);
    expect((await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.staffSucursalA.token, { csv: "nombre,precio\nSope,40" }))).status).toBe(403);
    expect((await t.app.request(`/v1/restaurantes/${t.ctx.otherPropertyId}/admin/menu/importar/extraer`, authedJson(t.ctx.staff.owner.token, { csv: "nombre,precio\nSope,40" }))).status).toBe(403);
    const sinGateway = await setup(undefined);
    expect((await sinGateway.app.request(sinGateway.url("extraer"), authedJson(sinGateway.ctx.staff.owner.token, { archivo: { base64: PDF } }))).status).toBe(503);
    const apagado = await setup(gatewayFalso(new KillSwitchEngagedError("agente", "restaurantes:extraccion_menu")).gateway);
    expect((await apagado.app.request(apagado.url("extraer"), authedJson(apagado.ctx.staff.owner.token, { archivo: { base64: PDF } }))).status).toBe(503);
  });

  it("tope de 20 lecturas por hora por organizacion -> 429", async () => {
    const t = await setup(gatewayFalso(EXTRACCION).gateway);
    for (let i = 0; i < 20; i++) expect((await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.owner.token, { archivo: { base64: PDF } }))).status).toBe(200);
    expect((await t.app.request(t.url("extraer"), authedJson(t.ctx.staff.owner.token, { archivo: { base64: PDF } }))).status).toBe(429);
  });
});

describe("POST …/admin/menu/importar/guardar", () => {
  it("crea categorias y productos con precio y disponibilidad EN ESTA sucursal; repetir no duplica", async () => {
    const t = await setup(undefined);
    const productos = [
      { nombre: "Taco de pastor", categoria: "Tacos al carbón", precio: 25 },
      { nombre: "Combo 2", categoria: "Paquetes", descripcion: "Incluye: 2 tacos, refresco.", precio: 150 },
    ];
    const res = await t.app.request(t.url("guardar"), authedJson(t.ctx.staff.owner.token, { productos }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ creados: 2, omitidos: 0, categoriasCreadas: 2 });
    const repo = t.ctx.restaurantesRepo;
    const taco = (await repo.listProducts(t.ctx.organizationId)).find((p) => p.name === "Taco de pastor")!;
    expect(await repo.getBranchProductState(t.ctx.propertyIdA, taco.id)).toMatchObject({ price: 25, isAvailable: true });
    expect((await repo.listCategories(t.ctx.organizationId)).some((c) => c.slug === "tacos-al-carbon")).toBe(true);

    const otra = await t.app.request(t.url("guardar"), authedJson(t.ctx.staff.owner.token, { productos }));
    expect(await otra.json()).toEqual({ creados: 0, omitidos: 2, categoriasCreadas: 0 });
  });

  it("fila sin precio -> 400 con el nombre de la fila; staff -> 403", async () => {
    const t = await setup(undefined);
    const res = await t.app.request(t.url("guardar"), authedJson(t.ctx.staff.owner.token, { productos: [{ nombre: "Gringa", categoria: "Tacos", precio: null }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("Gringa");
    expect((await t.app.request(t.url("guardar"), authedJson(t.ctx.staff.staffSucursalA.token, { productos: [{ nombre: "Sope", precio: 40 }] }))).status).toBe(403);
  });
});

describe("tipoPorBytes", () => {
  it("reconoce PDF, PNG, JPEG y WebP; rechaza lo demas", () => {
    expect(tipoPorBytes(Buffer.from(PDF, "base64"))).toBe("pdf");
    expect(tipoPorBytes(Buffer.from(PNG, "base64"))).toBe("png");
    expect(tipoPorBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(tipoPorBytes(new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]))).toBe("webp");
    expect(tipoPorBytes(Buffer.from(EXE, "base64"))).toBeNull();
  });
});
