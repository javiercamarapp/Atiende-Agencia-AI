// CFO-05 · prueba OPT-IN contra Postgres REAL (migraciones 081/082/083 aplicadas, rol `authenticated`, RLS y auth.uid() reales).
// Se omite sin CFO_REAL_PG=1; la corre scripts/verify-restaurantes-cfo-repos/run.sh con un Postgres efímero en un puerto propio (nunca el 5432).
// Cada caso es una transacción que termina en ROLLBACK: la base queda intacta. Los ids de organización, sucursales y personas son los de los fixtures
// de la API, así que la ruta HTTP (membresía en memoria) y la base (membresía real) hablan de las mismas personas.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCfoRepository } from "@atiende/domain-restaurantes/cfo/postgres";
import { CfoParametroInvalidoError, CfoSinAccesoError, ServicioCfo } from "@atiende/domain-restaurantes/cfo";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, type RestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const habilitado = process.env["CFO_REAL_PG"] === "1";
const DIA = "2026-03-10";
const R = { desde: DIA, hasta: DIA };
const q = `desde=${DIA}&hasta=${DIA}`;

describe.skipIf(!habilitado)("CFO contra Postgres real (rol authenticated)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client();
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  const sesion = { query: async <T,>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }), exec: async (sql: string) => void (await client.query(sql)) };

  async function como(userId: string | null): Promise<void> {
    await client.query("reset role");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
  }

  /** Siembra (como superusuario, dentro de la transacción) la organización, sucursales, personas y pedidos del fixture de la API. */
  async function sembrar(ctx: RestaurantesKpiTestContext): Promise<void> {
    const O = ctx.organizationId;
    const A = ctx.propertyIdA;
    const B = ctx.propertyIdB;
    await client.query("reset role");
    await client.query(`insert into core.organization (id, vertical, name, slug) values ($1, 'restaurantes', 'CFO real', $2), ($3, 'restaurantes', 'Otra', $4)`, [O, `cfo-real-${O.slice(0, 8)}`, ctx.otherOrganizationId, `otra-${O.slice(0, 8)}`]);
    await client.query(`insert into core.property (id, organization_id, name) values ($1, $2, 'A'), ($3, $2, 'B'), ($4, $5, 'Ajena')`, [A, O, B, ctx.otherPropertyId, ctx.otherOrganizationId]);
    await client.query(`insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values ($1, $2, $3, null), ($4, $2, $5, null), ($6, $7, $8, null)`, [A, O, `a-${A.slice(0, 6)}`, B, `b-${B.slice(0, 6)}`, ctx.otherPropertyId, ctx.otherOrganizationId, `x-${A.slice(0, 6)}`]);
    await client.query(`insert into restaurantes.branch_policy (property_id, organization_id, horario) values ($1, $2, '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]')`, [A, O]);
    const s = ctx.staff;
    for (const [p, rol, plat] of [[s.owner, "owner", "owner"], [s.admin, "admin", "admin"], [s.adminSucursalA, "admin", "admin"], [s.staffSucursalA, "staff", "member"], [s.repartidor, "repartidor", "member"]] as const) {
      await client.query(`insert into core.staff_user (id, email, full_name, created_via) values ($1, $2, $3, 'seed')`, [p.id, p.email, rol]);
      await client.query(`insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ($1, $2, $3, $4, $5)`, [p.id, O, p === s.adminSucursalA ? [A] : p === s.staffSucursalA ? [A] : null, plat, rol]);
    }
    await client.query(`insert into restaurantes.categories (id, organization_id, name, slug) values ('00000000-0000-0000-0000-0000000f0001', $1, 'Tacos', 'tacos-real')`, [O]);
    await client.query(`insert into restaurantes.products (id, organization_id, category_id, name, price) values ('00000000-0000-0000-0000-0000000f00c1', $1, '00000000-0000-0000-0000-0000000f0001', 'Taco al pastor', 50.00)`, [O]);
    await client.query(`insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f00e1', $1, '+52 5511119001', 'Cliente Uno'), ('00000000-0000-0000-0000-0000000f00e2', $1, '+52 5511119002', 'Cliente Dos')`, [O]);
    const item = (cant: number) => JSON.stringify([{ id: "00000000-0000-0000-0000-0000000f00c1", name: "Taco", price: 50, quantity: cant }]);
    const orden = (n: number, prop: string, cust: string | null, total: number, status: string, items: string, source: string, notes: string | null, pago: string | null, propina: number | null, creado: string, entregado: string | null) =>
      client.query(
        `insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, notes, payment_method, propina, created_at, delivered_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)`,
        [`00000000-0000-0000-0000-00000f4f${String(n).padStart(4, "0")}`, O, prop, cust, `Cliente ${n}`, `+52 55000090${String(n).padStart(2, "0")}`, total, status, items, source, notes, pago, propina, creado, entregado],
      );
    // Sucursal A, dia 10 (corte 01:00): a1, a2 (PROMO10), a3, a4 (00:30 local = dia anterior? 06:30Z = 00:30 del dia 11 -> cuenta en el 10), a6 (GRACIAS-); a5 01:05 y cancelado/no recogido fuera.
    await orden(1, A, "00000000-0000-0000-0000-0000000f00e1", 100, "entregado", item(2), "whatsapp", null, "tarjeta", 10, "2026-03-10 18:00+00", "2026-03-10 18:30+00");
    await orden(2, A, "00000000-0000-0000-0000-0000000f00e2", 81, "pending", JSON.stringify([{ id: "00000000-0000-0000-0000-0000000f00c1", name: "Taco", price: 50, quantity: 2 }]), "voice", "Promoción aplicada: PROMO10 (-$19.00).", "efectivo", null, "2026-03-10 19:00+00", null);
    await orden(3, A, "00000000-0000-0000-0000-0000000f00e1", 50, "entregado", item(1), "whatsapp", null, "efectivo", null, "2026-03-10 20:00+00", "2026-03-10 21:00+00");
    await orden(4, A, null, 50, "pending", item(1), "whatsapp", null, null, null, "2026-03-11 06:30+00", null);
    await orden(5, A, null, 50, "pending", item(1), "whatsapp", null, null, null, "2026-03-11 07:05+00", null);
    await orden(6, A, null, 70, "pending", item(2), "whatsapp", "Promoción aplicada: GRACIAS-ABCD (-$30.00).", null, null, "2026-03-10 21:00+00", null);
    await orden(7, A, null, 80, "cancelado", item(1), "whatsapp", null, null, null, "2026-03-10 22:00+00", null);
    // Sucursal B, dia 10.
    await orden(21, B, null, 200, "pending", item(4), "voice", null, "efectivo", null, "2026-03-10 18:00+00", null);
    await orden(22, B, null, 50, "pending", item(1), "whatsapp", null, null, null, "2026-03-10 19:00+00", null);
    // Otra organización (nunca debe aparecer).
    await client.query(
      `insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values ('00000000-0000-0000-0000-00000f4f0041', $1, $2, 'Ajeno', '+52 5500009041', 555, 'pending', '[]'::jsonb, 'whatsapp', '2026-03-10 18:00+00')`,
      [ctx.otherOrganizationId, ctx.otherPropertyId],
    );
  }

  /** Corre `f` en una transacción que siempre termina en rollback. */
  async function enTransaccion<T>(f: (ctx: RestaurantesKpiTestContext) => Promise<T>): Promise<T> {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await client.query("begin");
    try {
      await sembrar(ctx);
      return await f(ctx);
    } finally {
      await client.query("rollback");
    }
  }

  const params = (ctx: RestaurantesKpiTestContext, props: readonly string[] | null) => ({ organizationId: ctx.organizationId, propertyIds: props });

  it("owner: ventas diarias con números (no strings), el día de negocio del corte y el consolidado de las dos sucursales", async () => {
    await enTransaccion(async (ctx) => {
      await como(ctx.staff.owner.id);
      const repo = new PostgresCfoRepository(sesion);
      const l = await repo.ventasDiarias(params(ctx, null), R, 50);
      expect(l.disponible).toBe(true);
      const a = l.filas.filter((f) => f.propertyId === ctx.propertyIdA);
      const b = l.filas.filter((f) => f.propertyId === ctx.propertyIdB);
      for (const f of l.filas) for (const [k, v] of Object.entries(f)) if (["pedidos", "brutaCentavos", "netaCentavos", "entregaMinSuma"].includes(k)) expect(typeof v, k).toBe("number");
      // A: a1 (100) + a2 (81) + a3 (50) + a4 (50, 00:30 local) + a6 (70) = 5 pedidos, 35100 centavos; a5 (01:05) cuenta el día siguiente.
      expect(a.reduce((s, f) => s + f.pedidos, 0)).toBe(5);
      expect(a.reduce((s, f) => s + f.netaCentavos, 0)).toBe(35100);
      expect(a.reduce((s, f) => s + f.cancelados, 0)).toBe(1);
      expect(a.reduce((s, f) => s + f.canceladosCentavos, 0)).toBe(8000);
      expect(a.reduce((s, f) => s + f.propinaCentavos, 0)).toBe(1000);
      expect(b.reduce((s, f) => s + f.netaCentavos, 0)).toBe(25000);
      expect(l.filas.some((f) => f.propertyId === ctx.otherPropertyId)).toBe(false);
      expect(a.reduce((s, f) => s + f.entregaMinSuma, 0)).toBe(90); // 30 + 60 minutos
    });
  });

  it("roles y alcance con la base real: admin acotado ve solo A; staff, repartidor y sucursal ajena -> CfoSinAccesoError; otra organización también", async () => {
    await enTransaccion(async (ctx) => {
      const repo = new PostgresCfoRepository(sesion);
      await como(ctx.staff.adminSucursalA.id);
      const propio = await repo.ventasDiarias(params(ctx, null), R, 50);
      expect(new Set(propio.filas.map((f) => f.propertyId))).toEqual(new Set([ctx.propertyIdA]));
      await expect(repo.ventasDiarias(params(ctx, [ctx.propertyIdB]), R, 50)).rejects.toBeInstanceOf(CfoSinAccesoError);
      await expect(repo.ventasDiarias(params(ctx, [ctx.otherPropertyId]), R, 50)).rejects.toBeInstanceOf(CfoSinAccesoError);
      // La sesión sigue viva después del error (SAVEPOINT): la siguiente consulta funciona.
      expect((await repo.ventasDiarias(params(ctx, [ctx.propertyIdA]), R, 50)).filas.length).toBeGreaterThan(0);
      for (const quien of [ctx.staff.staffSucursalA, ctx.staff.repartidor]) {
        await como(quien.id);
        await expect(repo.ventasDiarias(params(ctx, null), R, 50)).rejects.toBeInstanceOf(CfoSinAccesoError);
      }
      await como(ctx.staff.otroOrgOwner.id);
      await expect(repo.ventasDiarias(params(ctx, null), R, 50)).rejects.toBeInstanceOf(CfoSinAccesoError);
    });
  });

  it("22023: rango de más de 400 días y lista de sucursales vacía -> CfoParametroInvalidoError, y la transacción sigue utilizable", async () => {
    await enTransaccion(async (ctx) => {
      await como(ctx.staff.owner.id);
      const repo = new PostgresCfoRepository(sesion);
      await expect(repo.ventasDiarias(params(ctx, null), { desde: "2025-01-01", hasta: "2026-03-10" }, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
      await expect(repo.ventasDiarias(params(ctx, []), R, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
      await expect(repo.colonias(params(ctx, null), R, 4)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
      expect((await repo.ventasDiarias(params(ctx, null), R, 50)).disponible).toBe(true);
    });
  });

  it("clientes, agente, operación y agotados: todas las lecturas de 082 responden con tipos correctos (sin strings numéricos)", async () => {
    await enTransaccion(async (ctx) => {
      await como(ctx.staff.owner.id);
      const repo = new PostgresCfoRepository(sesion);
      const p = params(ctx, null);
      const u = { frecuenteN: 3, frecuenteDias: 90, activoDias: 60, perdidoDias: 120 };
      const res = await repo.clientesResumen(p, R, u);
      expect(res.disponible).toBe(true);
      const conjunto = res.filas.find((f) => f.alcance === "conjunto")!;
      expect(typeof conjunto.clientesConPedido).toBe("number");
      expect(conjunto.clientesConPedido).toBe(2);
      expect(conjunto.pedidosConCliente + conjunto.pedidosSinCliente).toBeGreaterThan(0);
      for (const ll of [await repo.clientesCohortes(p, 6), await repo.clientesAltas(p, R), await repo.clientesSegmentoHora(p, R, u), await repo.agenteDiario(p, R), await repo.escalacionesHora(p, R), await repo.entregas(p, R, 50), await repo.repartidores(p, R, 50), await repo.colonias(p, R, 5), await repo.comandasPos(p, R), await repo.agotados(p), await repo.cobertura(p), await repo.productos(p, R), await repo.cortesias(p, R), await repo.ventasHora(p, R)]) {
        expect(ll.disponible).toBe(true);
        expect(JSON.stringify(ll.filas)).not.toMatch(/"-?\d+(\.\d+)?"/); // ningún bigint/numeric quedó como string
      }
      const perc = await repo.entregasPercentiles(p, R);
      expect(perc.filas.find((f) => f.alcance === "conjunto")!.entregados).toBe(2);
      expect(typeof perc.filas.find((f) => f.alcance === "conjunto")!.p90Min).toBe("number");
      // La sucursal sin entregas tiene percentil NULL (sin dato), no 0.
      expect(perc.filas.find((f) => f.propertyId === ctx.propertyIdB)?.p90Min ?? null).toBeNull();
      const canasta = await repo.canastaPares(p, R, 50);
      expect(canasta.disponible).toBe(true);
      const det = await repo.pedidosDetalle(p, R, { es_venta: true }, 3, null, 50);
      expect(det.filas).toHaveLength(3);
      expect(det.cursorSiguiente).toMatch(/^2026-03-1\d\|\d+$/);
      expect(JSON.stringify(det.filas)).not.toMatch(/\+52|Cliente \d|phone|telefono/i);
      expect(det.filas[0]!.clienteAlias === null || /^[0-9a-f]{8}$/.test(det.filas[0]!.clienteAlias!)).toBe(true);
    });
  });

  it("configuración: defaults, guardado por owner, 22023 fuera de rango, admin acotado y staff sin permiso", async () => {
    await enTransaccion(async (ctx) => {
      const repo = new PostgresCfoRepository(sesion);
      await como(ctx.staff.owner.id);
      const antes = await repo.configLeer(ctx.organizationId);
      expect(antes).toMatchObject({ disponible: true, configurada: false });
      expect(antes.config).toMatchObject({ ivaPct: 16, activoDias: 60, perdidoDias: 120, srCuadreVerdeCentavos: 5000, comisionTerminalPct: null });
      await repo.configGuardar(ctx.organizationId, { iva_pct: 8, comision_terminal_pct: 2.5 });
      const despues = await repo.configLeer(ctx.organizationId);
      expect(despues.configurada).toBe(true);
      expect(despues.config).toMatchObject({ ivaPct: 8, comisionTerminalPct: 2.5 });
      await expect(repo.configGuardar(ctx.organizationId, { iva_pct: 31 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
      await expect(repo.configGuardar(ctx.organizationId, { activo_dias: 300 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
      await como(ctx.staff.adminSucursalA.id);
      expect((await repo.configLeer(ctx.organizationId)).configurada).toBe(true); // lectura permitida
      await expect(repo.configGuardar(ctx.organizationId, { iva_pct: 10 })).rejects.toBeInstanceOf(CfoSinAccesoError);
      await como(ctx.staff.staffSucursalA.id);
      await expect(repo.configLeer(ctx.organizationId)).rejects.toBeInstanceOf(CfoSinAccesoError);
    });
  });

  it("costos capturados: versiones, historial y alcance (la organización exige organización completa)", async () => {
    await enTransaccion(async (ctx) => {
      const repo = new PostgresCfoRepository(sesion);
      await como(ctx.staff.owner.id);
      const base = { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, mes: "2026-03-01", concepto: "nomina" as const, montoCentavos: 5_000_000, pct: null, nota: null };
      await repo.costoGuardar(base);
      await repo.costoGuardar({ ...base, montoCentavos: 5_200_000, nota: "ajuste" });
      await repo.costoGuardar({ ...base, propertyId: null, concepto: "renta", montoCentavos: 9_000_000 });
      const leidos = await repo.costosLeer(params(ctx, null), "2026-03-01", "2026-03-01");
      expect(leidos.filas.filter((c) => c.concepto === "nomina")).toHaveLength(1);
      expect(leidos.filas.find((c) => c.concepto === "nomina")).toMatchObject({ montoCentavos: 5_200_000, nota: "ajuste", propertyId: ctx.propertyIdA });
      expect(typeof leidos.filas[0]!.montoCentavos).toBe("number");
      expect(leidos.filas.some((c) => c.propertyId === null)).toBe(true);
      const h = await repo.costoHistorial(ctx.organizationId, ctx.propertyIdA, "2026-03-01", "nomina");
      expect(h.filas.map((x) => [x.version, x.montoCentavos, x.vigente])).toEqual([[1, 5_000_000, false], [2, 5_200_000, true]]);
      await como(ctx.staff.adminSucursalA.id);
      await expect(repo.costoGuardar({ ...base, propertyId: null })).rejects.toBeInstanceOf(CfoSinAccesoError);
      await expect(repo.costoGuardar({ ...base, propertyId: ctx.propertyIdB })).rejects.toBeInstanceOf(CfoSinAccesoError);
      const acotado = await repo.costosLeer(params(ctx, null), "2026-03-01", "2026-03-01");
      expect(acotado.filas.every((c) => c.propertyId === ctx.propertyIdA)).toBe(true);
      await expect(repo.costoGuardar({ ...base, montoCentavos: -1 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    });
  });

  it("SoftRestaurant: importación idempotente por huella, llaves de cliente rechazadas completas, lectura numérica y bitácora", async () => {
    await enTransaccion(async (ctx) => {
      const repo = new PostgresCfoRepository(sesion);
      await como(ctx.staff.owner.id);
      const renglones = [
        { dia_negocio: DIA, tipo_servicio: "domicilio", tickets: 20, bruta_centavos: 300_000, descuento_centavos: 20_000, neta_centavos: 280_000 },
        { dia_negocio: DIA, tipo_servicio: "comedor", tickets: 30, bruta_centavos: 600_000, neta_centavos: 600_000 },
      ];
      const e = { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, huella: "a".repeat(64), tipo: "resumen_servicio" as const, nombreArchivo: "ventas.csv", renglones };
      const a = await repo.srImportar(e);
      expect(a).toMatchObject({ creado: true, aceptados: 2, rechazados: 0 });
      const b = await repo.srImportar(e);
      expect(b).toMatchObject({ creado: false, loteId: a.loteId });
      await expect(repo.srImportar({ ...e, huella: "b".repeat(64), renglones: [{ ...renglones[0]!, telefono: "9990000000" }] })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
      const sr = await repo.srResumenLeer(params(ctx, [ctx.propertyIdA]), R);
      expect(sr.filas.reduce((s, f) => s + f.netaCentavos, 0)).toBe(880_000);
      expect(sr.filas.every((f) => typeof f.netaCentavos === "number" && typeof f.tickets === "number")).toBe(true);
      expect((await repo.srLotes(params(ctx, null), 10)).filas).toHaveLength(1);
      const cob = await repo.srCobertura(params(ctx, null));
      expect(cob.filas.find((c) => c.propertyId === ctx.propertyIdA)).toMatchObject({ diasConDato: 1, diaMin: DIA, dias: [DIA] });
      const bitacora = await client.query(`select count(*)::int as n from restaurantes.audit_log where organization_id = $1 and action = 'cfo.sr_importado'`, [ctx.organizationId]);
      expect(bitacora.rows[0].n).toBe(1);
      await como(ctx.staff.adminSucursalA.id);
      await expect(repo.srImportar({ ...e, propertyId: ctx.propertyIdB, huella: "c".repeat(64) })).rejects.toBeInstanceOf(CfoSinAccesoError);
      await como(ctx.staff.staffSucursalA.id);
      await expect(repo.srImportar({ ...e, huella: "d".repeat(64) })).rejects.toBeInstanceOf(CfoSinAccesoError);
    });
  });

  it("exportaciones: la bitácora registra vista, formato y rango; formato inválido -> 22023", async () => {
    await enTransaccion(async (ctx) => {
      const repo = new PostgresCfoRepository(sesion);
      await como(ctx.staff.owner.id);
      const id = await repo.registrarExportacion({ organizationId: ctx.organizationId, propertyIds: null, vista: "resumen", formato: "pdf", desde: R.desde, hasta: R.hasta });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await expect(repo.registrarExportacion({ organizationId: ctx.organizationId, propertyIds: null, vista: "resumen", formato: "csv" as never, desde: R.desde, hasta: R.hasta })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    });
  });

  it("base SIN migrar: si la función no existe (42883) la lectura devuelve disponible=false, la escritura CfoNoDisponibleError y la sesión sigue viva", async () => {
    await enTransaccion(async (ctx) => {
      await client.query("reset role");
      await client.query("drop function restaurantes.cfo_ventas_diarias(uuid, uuid[], date, date, integer)");
      await client.query("drop function restaurantes.cfo_config_guardar(uuid, jsonb)");
      await como(ctx.staff.owner.id);
      const repo = new PostgresCfoRepository(sesion);
      expect(await repo.ventasDiarias(params(ctx, null), R, 50)).toEqual({ disponible: false, filas: [] });
      await expect(repo.configGuardar(ctx.organizationId, { iva_pct: 8 })).rejects.toThrow(/todavía no está disponible/);
      expect((await repo.cortesias(params(ctx, null), R)).disponible).toBe(true);
    });
  });

  it("HTTP de punta a punta: /resumen con la sesión real; consolidado = Σ, admin acotado sin «No asignado», staff 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await client.query("begin");
    try {
      await sembrar(ctx);
      const deps: AppDeps = { ...ctx.deps, cfoRestaurantesRepo: () => new PostgresCfoRepository(sesion) };
      const app = buildApp(deps);
      const ver = async (quien: { id: string; token: string }, ruta = "resumen", extra = "") => {
        await como(quien.id);
        const r = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/cfo/${ruta}?${q}${extra}`, authedGet(quien.token));
        return { status: r.status, json: (await r.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
      };
      const dueno = await ver(ctx.staff.owner);
      expect(dueno.status).toBe(200);
      expect(dueno.json["kpis"].total.sumas.netaCentavos).toBe(60100); // 35100 (A) + 25000 (B)
      expect(dueno.json["kpis"].total.sumas.pedidos).toBe(7);
      expect(dueno.json["kpis"].porSucursal.reduce((s: number, c: { sumas: { netaCentavos: number } }) => s + c.sumas.netaCentavos, 0)).toBe(60100);
      expect(dueno.json["kpis"].noAsignado === null || typeof dueno.json["kpis"].noAsignado === "object").toBe(true);
      expect(dueno.json["bloques"]).toEqual({ ventas: true, clientes: true, captura: true });
      const acotado = await ver(ctx.staff.adminSucursalA);
      expect(acotado.status).toBe(200);
      expect(acotado.json["kpis"].total.sumas.netaCentavos).toBe(35100);
      expect(acotado.json["kpis"].noAsignado).toBeNull();
      expect((await ver(ctx.staff.staffSucursalA)).status).toBe(403);
      const ajena = await ver(ctx.staff.adminSucursalA, "resumen", `&sucursales=${ctx.propertyIdB}`);
      expect(ajena.status).toBe(403);
      for (const ruta of ["ventas", "sucursales", "estado-resultados", "clientes", "productos", "patrones", "operacion", "pedidos", "softrestaurant/cuadre"]) {
        const r = await ver(ctx.staff.owner, ruta);
        expect(r.status, ruta).toBe(200);
        expect(r.json["bloques"], ruta).toEqual({ ventas: true, clientes: true, captura: true });
      }
      await como(ctx.staff.owner.id);
      const put = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/cfo/config`, authedJson(ctx.staff.owner.token, { ivaPct: 8 }, "PUT"));
      expect(put.status).toBe(200);
      expect(((await put.json()) as { config: { ivaPct: number } }).config.ivaPct).toBe(8);
    } finally {
      await client.query("rollback");
    }
  });

  it("sucursal INACTIVA con historia y un cliente que compró en A, B y la inactiva: /resumen, /clientes y /patrones responden 200 y el total coincide con la SQL", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const C = "cccccccc-0000-4000-8000-0000000000c3";
    await client.query("begin");
    try {
      await sembrar(ctx);
      await client.query("reset role");
      await client.query(`insert into core.property (id, organization_id, name) values ($1, $2, 'Cerrada')`, [C, ctx.organizationId]);
      await client.query(`insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values ($1, $2, $3, null)`, [C, ctx.organizationId, `c-${C.slice(0, 6)}`]);
      await client.query(`update core.property set status = 'inactive' where id = $1`, [C]);
      const cliente = "00000000-0000-0000-0000-0000000f00e1"; // ya compró en A (a1, a3); ahora también en B y en la inactiva
      await client.query(
        `insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values
          ('00000000-0000-0000-0000-00000f4f0061', $1, $2, $4, 'Cliente 61', '+52 5500009061', 70, 'pending', '[]'::jsonb, 'whatsapp', '2026-03-10 18:00+00'),
          ('00000000-0000-0000-0000-00000f4f0062', $1, $3, $4, 'Cliente 62', '+52 5500009062', 30, 'pending', '[]'::jsonb, 'whatsapp', '2026-03-10 19:00+00')`,
        [ctx.organizationId, ctx.propertyIdB, C, cliente],
      );
      ctx.restaurantesRepo.seedBranch({ propertyId: C, organizationId: ctx.organizationId, name: "Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: null, lng: null });
      const app = buildApp({ ...ctx.deps, cfoRestaurantesRepo: () => new PostgresCfoRepository(sesion) });
      const ver = async (ruta: string) => {
        await como(ctx.staff.owner.id);
        const r = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/cfo/${ruta}?${q}`, authedGet(ctx.staff.owner.token));
        return { status: r.status, json: (await r.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
      };
      const resumen = await ver("resumen");
      expect(resumen.status).toBe(200);
      // 60100 (A y B de la siembra) + 7000 + 3000 (B y la inactiva): la venta histórica de la inactiva SÍ cuenta, igual que en la SQL directa.
      await como(ctx.staff.owner.id);
      const sql = await client.query(`select coalesce(sum(neta_centavos), 0)::int as n from restaurantes.cfo_ventas_diarias($1, null, $2::date, $2::date)`, [ctx.organizationId, DIA]);
      expect(resumen.json["kpis"].total.sumas.netaCentavos).toBe(sql.rows[0].n);
      expect(resumen.json["kpis"].porSucursal.map((c: { propertyId: string }) => c.propertyId)).toContain(C);
      expect(resumen.json["sucursales"].find((x: { propertyId: string }) => x.propertyId === C).activa).toBe(false);
      const clientes = await ver("clientes");
      expect(clientes.status).toBe(200);
      expect(clientes.json["total"].resumen.clientesConPedido).toBe(2); // el conjunto cuenta al cliente UNA vez
      expect(clientes.json["multiSucursal"].clientes).toBeGreaterThanOrEqual(1);
      expect((await ver("patrones")).status).toBe(200);
      expect((await ver("ventas")).json["ventas"].total.sumas.netaCentavos).toBe(sql.rows[0].n);
    } finally {
      await client.query("rollback");
    }
  });

  it("ServicioCfo con la base real: los avisos y fuentes salen del estado real (sin SR, Meta no medido) y el consolidado cuadra", async () => {
    await enTransaccion(async (ctx) => {
      await como(ctx.staff.owner.id);
      const repo = new PostgresCfoRepository(sesion);
      const sucursales = [{ propertyId: ctx.propertyIdA, nombre: "A", slug: "a" }, { propertyId: ctx.propertyIdB, nombre: "B", slug: "b" }];
      const servicio = new ServicioCfo({ repo, organizationId: ctx.organizationId, alcance: { propertyIds: [ctx.propertyIdA, ctx.propertyIdB], todas: true, organizacionCompleta: true }, propertyIdsSql: null, sucursales, ahora: new Date("2026-03-11T15:00:00Z") });
      const v = await servicio.ventasVista({ ...R, comparar: "periodo_anterior", granularidad: "dia" });
      expect(v.ventas.total.sumas.netaCentavos).toBe(60100);
      expect(v.ventas.porSucursal.reduce((s, c) => s + c.sumas.netaCentavos, 0)).toBe(60100);
      expect(v.ventas.total.cascada.descuadreCentavos).toBe(0);
      expect(v.avisos).toContain("Sin datos de mostrador de SoftRestaurant: suba el reporte de ventas por tipo de servicio o el listado de cuentas.");
      expect(v.titular.origen).toBe("agente");
    });
  });
});
