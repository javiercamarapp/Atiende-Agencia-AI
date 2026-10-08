// R-17: exportar Historial y Clientes (CSV compatible con Excel y PDF). Cada caso afirma el EFECTO: el contenido del archivo (BOM, escapes,
// zona horaria de la sucursal, dinero plano, formulas neutralizadas), que respete los filtros y el aislamiento por organizacion/sucursal, que solo
// owner/admin descarguen, el tope de filas y la bitacora (sin PII). El PDF se abre con pdf-lib y se lee su texto (paginas, pie con fecha y alcance).
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { EXPORTAR_MAX_FILAS_PDF } from "../src/routes/verticals/restaurantes/exportaciones.ts";
import { authedGet, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";
import { textoDelPdf } from "./support/pdf-text.ts";

afterEach(() => vi.useRealTimers());
function ahora(iso = "2026-10-04T18:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const base = (propertyId = ctx.propertyIdA) => `/v1/restaurantes/${propertyId}/admin/exportar`;
  return { ctx, app, base };
}

const lineas = (csv: string) => csv.replace(/^\uFEFF/, "").split("\r\n").filter((l) => l !== "");

describe("GET .../admin/exportar/historial", () => {
  it("CSV: BOM UTF-8, encabezados, fechas en la zona de CADA sucursal, dinero plano y escapes; descarga con nombre de archivo", async () => {
    ahora();
    const { ctx, app, base } = await construir();
    await ctx.restaurantesRepo.upsertBranchZonaHoraria(ctx.propertyIdB, "Pacific/Auckland");
    const fila = { organizationId: ctx.organizationId };
    // 05:30Z del 4: en Mexico (sucursal A) es 23:30 del dia 3; en Auckland (sucursal B, +13) ya es 18:30 del dia 4.
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...fila, propertyId: ctx.propertyIdA, branch: "Francisco de Montejo", customerName: "Pech, Marisol", customerPhone: "9991234567", total: 150.5, status: "entregado", source: "whatsapp", paymentMethod: "efectivo", createdAt: "2026-10-04T05:30:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...fila, propertyId: ctx.propertyIdB, branch: "Centro", customerName: 'Luis "El Güero" Uc', customerPhone: "+52 999 765 4321", total: 99, status: "pending", source: "web", paymentMethod: null, createdAt: "2026-10-04T05:30:00Z" }));
    const res = await app.request(`${base()}/historial?formato=csv`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="atiende-historial-2026-10-04.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM
    const l = lineas(new TextDecoder().decode(bytes));
    expect(l[0]).toBe("Pedido,Fecha,Sucursal,Cliente,Teléfono,Canal,Estado,Pago,Total");
    const mx = l.find((x) => x.includes("Francisco de Montejo"))!;
    expect(mx).toContain(',2026-10-03 23:30,Francisco de Montejo,"Pech, Marisol",9991234567,WhatsApp,Entregado,Efectivo,150.50');
    const nz = l.find((x) => x.includes("Centro"))!;
    expect(nz).toContain(',2026-10-04 18:30,Centro,"Luis ""El Güero"" Uc",+52 999 765 4321,Pedido en línea (histórico),Recibido,,99.00');
    expect(l).toHaveLength(3);
  });

  it("respeta los filtros: estado, rango de fechas y sucursal; NUNCA incluye pedidos de otra organizacion", async () => {
    ahora();
    const { ctx, app, base } = await construir();
    const org = { organizationId: ctx.organizationId };
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...org, propertyId: ctx.propertyIdA, customerName: "A entregado", status: "entregado", createdAt: "2026-10-02T12:00:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...org, propertyId: ctx.propertyIdA, customerName: "A cancelado", status: "cancelado", createdAt: "2026-10-03T12:00:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...org, propertyId: ctx.propertyIdB, customerName: "B entregado", status: "entregado", createdAt: "2026-10-03T12:00:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.otherOrganizationId, propertyId: ctx.otherPropertyId, customerName: "AJENO", status: "entregado", createdAt: "2026-10-03T12:00:00Z" }));
    const pedir = async (qs: string) => lineas(await (await app.request(`${base()}/historial?formato=csv&${qs}`, authedGet(ctx.staff.owner.token))).text()).slice(1).join("|");
    expect(await pedir("")).not.toContain("AJENO");
    expect(await pedir("status=entregado")).toMatch(/A entregado.*B entregado|B entregado.*A entregado/);
    expect(await pedir("status=entregado")).not.toContain("A cancelado");
    expect(await pedir("dateFrom=2026-10-03T00:00:00Z")).not.toContain("A entregado");
    expect(await pedir("dateFrom=2026-10-03T00:00:00Z&dateTo=2026-10-04T00:00:00Z")).toContain("A cancelado");
    const soloA = await pedir(`branchId=${ctx.propertyIdA}`);
    expect(soloA).toContain("A entregado");
    expect(soloA).not.toContain("B entregado");
  });

  it("un cliente que escribe una formula como nombre sale neutralizado (apostrofo) y el archivo conserva el resto de la fila", async () => {
    const { ctx, app, base } = await construir();
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, customerName: "=HYPERLINK(\"http://x\")", total: 10 }));
    const csv = await (await app.request(`${base()}/historial?formato=csv`, authedGet(ctx.staff.owner.token))).text();
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it("PDF: abre con pdf-lib, trae titulo, contexto con filtros y, en CADA pagina, pie con fecha, alcance y numero de pagina", async () => {
    ahora();
    const { ctx, app, base } = await construir();
    for (let i = 0; i < 90; i++) {
      ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, customerName: `Cliente ${i}`, total: 100 + i, status: "entregado", createdAt: "2026-10-03T15:00:00Z" }));
    }
    const res = await app.request(`${base()}/historial?formato=pdf&status=entregado`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="atiende-historial-2026-10-04.pdf"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1); // 90 filas no caben en una hoja
    const t = textoDelPdf(bytes);
    expect(t).toContain("Historial de pedidos");
    expect(t).toContain("90 pedidos");
    expect(t).toContain("Estado: Entregado");
    expect(t.split("Generado 2026-10-04 12:00 (America/Mexico_City)").length - 1).toBe(doc.getPageCount()); // pie en cada pagina
    expect(t.split("Alcance: todas las sucursales a las que tienes acceso").length - 1).toBe(doc.getPageCount());
    expect(t).toContain(`Página ${doc.getPageCount()} de ${doc.getPageCount()}`);
    expect(t.split("Teléfono").length - 1).toBe(doc.getPageCount()); // encabezado repetido en cada pagina
  });

  it("PDF sin pedidos: mensaje honesto, una pagina, sin tabla vacia", async () => {
    const { ctx, app, base } = await construir();
    const bytes = new Uint8Array(await (await app.request(`${base()}/historial?formato=pdf`, authedGet(ctx.staff.owner.token))).arrayBuffer());
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(textoDelPdf(bytes)).toContain("No hay pedidos con estos filtros.");
  });

  it("CSV sin pedidos: solo el encabezado (con BOM)", async () => {
    const { ctx, app, base } = await construir();
    const csv = await (await app.request(`${base()}/historial?formato=csv`, authedGet(ctx.staff.owner.token))).text();
    expect(lineas(csv)).toEqual(["Pedido,Fecha,Sucursal,Cliente,Teléfono,Canal,Estado,Pago,Total"]);
  });

  it("el PDF rechaza (413) pasar del tope de filas en vez de truncar en silencio", async () => {
    const { ctx, app, base } = await construir();
    for (let i = 0; i < EXPORTAR_MAX_FILAS_PDF + 1; i++) ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, customerName: `C${i}` }));
    const res = await app.request(`${base()}/historial?formato=pdf`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(413);
    expect(JSON.stringify(await res.json())).toContain("Acota el rango");
    // El CSV del mismo conjunto SI cabe (tope mayor).
    expect((await app.request(`${base()}/historial?formato=csv`, authedGet(ctx.staff.owner.token))).status).toBe(200);
  }, 60_000);

  it.each([["formato=xlsx"], ["formato="], [""], ["formato=csv&status=inventado"], ["formato=csv&dateFrom=mañana"], ["formato=csv&dateTo=32-13-2026"]])("parametros invalidos (%s) -> 400", async (qs) => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base()}/historial?${qs}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
  });

  it("admin tambien exporta; staff de piso, repartidor y owner de otra organizacion -> 403; sin sesion -> 401", async () => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base()}/historial?formato=csv`, authedGet(ctx.staff.admin.token))).status).toBe(200);
    for (const t of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(`${base()}/historial?formato=csv`, authedGet(t))).status).toBe(403);
    }
    expect((await app.request(`${base()}/historial?formato=csv`)).status).toBe(401);
  });

  it("deja rastro en la bitacora (tipo exportacion): formato y filas, SIN nombres ni telefonos", async () => {
    const { ctx, app, base } = await construir();
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, customerName: "Marisol Pech", customerPhone: "9991234567", status: "entregado" }));
    await app.request(`${base()}/historial?formato=csv&status=entregado`, authedGet(ctx.staff.owner.token));
    const fila = (await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 10 } as never)).items.find((i) => i.action === "historial.exportado");
    expect(fila).toMatchObject({ entityType: "exportacion", campo: "formato=csv", despues: "1 filas; estado=entregado" });
    expect(JSON.stringify(fila)).not.toMatch(/Marisol|9991234567/);
  });
});

describe("GET .../admin/exportar/clientes", () => {
  async function conClientes() {
    const t = await construir();
    const nuevo = (id: string, name: string | null, phone: string, orderCount: number) => ({ id, organizationId: t.ctx.organizationId, phone, name, orderCount });
    // Los clientes viven en el repo en memoria: se siembran por su metodo real.
    const repo = t.ctx.restaurantesRepo as unknown as { seedCustomer(c: ReturnType<typeof nuevo>): void };
    repo.seedCustomer(nuevo("c1", "Ñandú, José", "9991112233", 4));
    repo.seedCustomer(nuevo("c2", null, "+52 999 000 0000", 1));
    repo.seedCustomer({ ...nuevo("c3", "AJENO", "9990001111", 9), organizationId: t.ctx.otherOrganizationId });
    return t;
  }

  it("CSV: nombre, telefono COMPLETO y pedidos, con BOM; solo la organizacion del usuario; busqueda filtra", async () => {
    const { ctx, app, base } = await conClientes();
    const res = await app.request(`${base()}/clientes?formato=csv`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="atiende-clientes-\d{4}-\d{2}-\d{2}\.csv"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM (res.text() lo descartaria)
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(lineas(csv)).toEqual(['Nombre,Teléfono,Pedidos', '"Ñandú, José",9991112233,4', ",+52 999 000 0000,1"]);
    expect(csv).not.toContain("AJENO");
    const filtrado = lineas(await (await app.request(`${base()}/clientes?formato=csv&search=9991112233`, authedGet(ctx.staff.owner.token))).text());
    expect(filtrado).toEqual(['Nombre,Teléfono,Pedidos', '"Ñandú, José",9991112233,4']);
  });

  it("PDF: se abre, lista a los clientes y lleva pie con fecha y alcance", async () => {
    ahora();
    const { ctx, app, base } = await conClientes();
    const bytes = new Uint8Array(await (await app.request(`${base()}/clientes?formato=pdf`, authedGet(ctx.staff.owner.token))).arrayBuffer());
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    const t = textoDelPdf(bytes);
    expect(t).toContain("Clientes");
    expect(t).toContain("2 clientes");
    expect(t).toContain("Generado 2026-10-04 12:00 (America/Mexico_City)");
    expect(t).toContain("Alcance: clientes de toda la organización");
    expect(t).toContain("9991112233");
    expect(t).not.toContain("AJENO");
  });

  it("solo owner/admin; invalidos -> 400; busqueda demasiado larga -> 400; bitacora sin el texto buscado", async () => {
    const { ctx, app, base } = await conClientes();
    for (const t of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(`${base()}/clientes?formato=csv`, authedGet(t))).status).toBe(403);
    }
    expect((await app.request(`${base()}/clientes?formato=json`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base()}/clientes?formato=csv&search=${"x".repeat(161)}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    await app.request(`${base()}/clientes?formato=csv&search=9991112233`, authedGet(ctx.staff.admin.token));
    const fila = (await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 10 } as never)).items.find((i) => i.action === "clientes.exportado");
    expect(fila).toMatchObject({ entityType: "exportacion", despues: "1 filas; con búsqueda" });
    expect(JSON.stringify(fila)).not.toContain("9991112233");
  });
});
