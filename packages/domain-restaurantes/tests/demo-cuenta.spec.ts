// Cuenta demo FICTICIA «El Tizon Norteño»: forma de los datos (6 sucursales, 289 productos, ids unicos, precios validos, horarios coherentes),
// validaciones del plan y SQL idempotente. Todo puro: ninguna prueba abre una conexion ni lee SEED_DATABASE_URL.
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/seed/demo-cuenta/args.ts";
import { DEMO_CUENTA } from "../src/seed/demo-cuenta/definicion.ts";
import { construirPlanDemoCuenta, DemoCuentaError, normalizar, precioEnSucursal, SLUG_DEMO_VIEJA } from "../src/seed/demo-cuenta/plan.ts";
import { renderDemoCuentaDoBlock, renderDemoCuentaPlpgsql, renderEsquemaRequeridoDemoCuenta } from "../src/seed/demo-cuenta/sql.ts";
import type { DemoCuentaDef, ProductoDef } from "../src/seed/demo-cuenta/tipos.ts";
import { assertPuedeAplicar, describirObjetivo, SeedTargetError } from "../src/seed/target-safety.ts";

const plan = construirPlanDemoCuenta(DEMO_CUENTA);
const conProductos = (productos: readonly ProductoDef[]): DemoCuentaDef => ({ ...DEMO_CUENTA, productos });

describe("definicion: forma de los datos", () => {
  it("tiene 6 sucursales en al menos 3 ciudades y 289 productos", () => {
    expect(DEMO_CUENTA.sucursales).toHaveLength(6);
    expect(new Set(DEMO_CUENTA.sucursales.map((b) => b.ciudad)).size).toBeGreaterThanOrEqual(3);
    expect(DEMO_CUENTA.productos).toHaveLength(289);
    expect(plan.summary).toMatchObject({ branches: 6, products: 289 });
  });

  it("ids, slugs, nombres y telefonos de sucursal son unicos", () => {
    for (const campo of ["id", "slug", "nombre", "telefono"] as const) {
      const valores = DEMO_CUENTA.sucursales.map((b) => b[campo]);
      expect(new Set(valores).size, campo).toBe(valores.length);
    }
  });

  it("los nombres de producto son unicos (tambien sin acentos ni mayusculas) y cada uno tiene categoria declarada", () => {
    const claves = DEMO_CUENTA.productos.map((x) => normalizar(x.nombre));
    expect(new Set(claves).size).toBe(claves.length);
    const categorias = new Set(DEMO_CUENTA.categorias);
    expect(categorias.size).toBe(DEMO_CUENTA.categorias.length);
    for (const prod of DEMO_CUENTA.productos) expect(categorias.has(prod.categoria), prod.nombre).toBe(true);
    for (const cat of DEMO_CUENTA.categorias) expect(DEMO_CUENTA.productos.some((x) => x.categoria === cat), cat).toBe(true);
  });

  it("todo precio por sucursal es un numero positivo, acotado y sin centavos (salvo medio peso en fracciones de kilo)", () => {
    let vistos = 0;
    for (const prod of DEMO_CUENTA.productos) {
      for (const b of DEMO_CUENTA.sucursales) {
        const precio = precioEnSucursal(DEMO_CUENTA, prod, b.id);
        if (precio === null) continue;
        vistos += 1;
        expect(Number.isFinite(precio) && precio > 0 && precio <= 20_000, `${prod.nombre} @ ${b.id}: ${precio}`).toBe(true);
        expect((precio * 2) % 1, `${prod.nombre} @ ${b.id}: ${precio}`).toBe(0);
        if (!prod.fraccionKg) expect(precio % 1, `${prod.nombre} @ ${b.id}: ${precio}`).toBe(0);
      }
    }
    expect(vistos).toBe(plan.summary.branchProducts);
  });

  it("cada sucursal vende al menos 200 productos y nada se vende en cero sucursales", () => {
    for (const b of DEMO_CUENTA.sucursales) expect(plan.summary.productsByBranch[b.id]).toBeGreaterThanOrEqual(200);
    for (const prod of plan.products) expect(Object.keys(prod.branchPrices).length, prod.name).toBeGreaterThan(0);
  });

  it("el alcohol vive solo en Cervezas / Licores y Cocktails y queda marcado no_domicilio", () => {
    const alcohol = plan.products.filter((x) => x.noDomicilio);
    expect(alcohol.length).toBe(plan.summary.alcoholProducts);
    expect(alcohol.length).toBeGreaterThan(0);
    for (const prod of alcohol) expect(["cervezas", "licores-y-cocktails"]).toContain(prod.categorySlug);
  });

  it("los agotados solo existen donde el producto se vende", () => {
    for (const prod of plan.products) for (const id of prod.unavailableIn) expect(prod.branchPrices[id], `${prod.name} @ ${id}`).toBeDefined();
    expect(plan.summary.unavailableBranchProducts).toBe(plan.products.reduce((n, x) => n + x.unavailableIn.length, 0));
  });
});

describe("definicion: horarios coherentes", () => {
  const aMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

  it("cada horario pasa validarHorario (via el plan), usa zona horaria IANA valida y abre al menos un dia", () => {
    for (const b of plan.branches) {
      expect(b.horario.length, b.name).toBeGreaterThan(0);
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: b.zonaHoraria }), b.name).not.toThrow();
    }
  });

  it("los turnos de una sucursal no se traslapan (incluido lo que se pasa de la medianoche al dia siguiente)", () => {
    for (const b of DEMO_CUENTA.sucursales) {
      const porDia: [number, number][][] = Array.from({ length: 7 }, () => []);
      for (const t of b.horario) {
        const abre = aMin(t.abre);
        const cierra = aMin(t.cierra);
        for (const dia of t.dias) {
          if (cierra > abre) porDia[dia]!.push([abre, cierra]);
          else {
            porDia[dia]!.push([abre, 1440]);
            if (cierra > 0) porDia[(dia + 1) % 7]!.push([0, cierra]);
          }
        }
      }
      for (const [dia, tramos] of porDia.entries()) {
        const ordenados = [...tramos].sort((x, y) => x[0] - y[0]);
        for (let i = 1; i < ordenados.length; i++) expect(ordenados[i]![0], `${b.nombre} dia ${dia}`).toBeGreaterThanOrEqual(ordenados[i - 1]![1]);
      }
    }
  });

  it("los dias de domicilio caen en dias en que la sucursal abre, y el texto de horario coincide con los dias cerrados", () => {
    for (const b of DEMO_CUENTA.sucursales) {
      const abre = new Set(b.horario.flatMap((t) => t.dias));
      for (const dia of b.diasDomicilio ?? []) expect(abre.has(dia), `${b.nombre} reparte el dia ${dia} pero no abre`).toBe(true);
      expect(b.horarioTexto.trim().length).toBeGreaterThan(10);
      if (!abre.has(1)) expect(b.horarioTexto.toLowerCase()).toContain("lunes");
    }
    const cumbres = DEMO_CUENTA.sucursales.find((b) => b.id === "MTY2")!;
    expect(cumbres.horario.flatMap((t) => t.dias)).not.toContain(1);
  });

  it("las promociones del agente y de la cuenta no se contradicen con los dias abiertos de ninguna sucursal que las ofrece", () => {
    for (const promo of plan.promotions) {
      const ids = promo.branchIds ?? plan.branches.map((b) => b.id);
      for (const dia of promo.daysOfWeek ?? []) {
        const algunaAbre = ids.some((id) => DEMO_CUENTA.sucursales.find((b) => b.id === id)!.horario.some((t) => t.dias.includes(dia)));
        expect(algunaAbre, `${promo.code} el dia ${dia}`).toBe(true);
      }
    }
  });
});

describe("plan", () => {
  it("es determinista y no usa el slug de la demo vieja", () => {
    expect(construirPlanDemoCuenta(DEMO_CUENTA)).toEqual(plan);
    expect(plan.organization.slug).not.toBe(SLUG_DEMO_VIEJA);
    expect(() => construirPlanDemoCuenta({ ...DEMO_CUENTA, organizacion: { ...DEMO_CUENTA.organizacion, slug: SLUG_DEMO_VIEJA } })).toThrow(DemoCuentaError);
  });

  it("cada colonia cae dentro del radio de su sucursal mas cercana y cada sucursal tiene al menos 10", () => {
    for (const c of DEMO_CUENTA.colonias) {
      const suc = DEMO_CUENTA.sucursales.find((b) => b.id === c.sucursales[0])!;
      expect(c.km, c.nombre).toBeLessThanOrEqual(suc.radioRepartoKm);
    }
    for (const b of DEMO_CUENTA.sucursales) expect(DEMO_CUENTA.colonias.filter((c) => c.sucursales[0] === b.id).length, b.nombre).toBeGreaterThanOrEqual(10);
  });

  it("rechaza datos rotos: producto duplicado, precio imposible, categoria desconocida", () => {
    const [primero] = DEMO_CUENTA.productos;
    expect(() => construirPlanDemoCuenta(conProductos([...DEMO_CUENTA.productos, { ...primero!, nombre: primero!.nombre.toUpperCase() }]))).toThrow(/duplicado/i);
    expect(() => construirPlanDemoCuenta(conProductos([{ ...primero!, precio: -5 }, ...DEMO_CUENTA.productos.slice(1)]))).toThrow(DemoCuentaError);
    expect(() => construirPlanDemoCuenta(conProductos([{ ...primero!, categoria: "No existe" }, ...DEMO_CUENTA.productos.slice(1)]))).toThrow(/categoria/i);
  });

  it("rechaza menos de 5 sucursales, un horario con abre = cierra y un telefono fuera del bloque ficticio", () => {
    expect(() => construirPlanDemoCuenta({ ...DEMO_CUENTA, sucursales: DEMO_CUENTA.sucursales.slice(0, 4) })).toThrow(/sucursales/);
    const [b0, ...resto] = DEMO_CUENTA.sucursales;
    expect(() => construirPlanDemoCuenta({ ...DEMO_CUENTA, sucursales: [{ ...b0!, horario: [{ dias: [1], abre: "10:00", cierra: "10:00" }] }, ...resto] })).toThrow(/horario/i);
    expect(() => construirPlanDemoCuenta({ ...DEMO_CUENTA, sucursales: [{ ...b0!, telefono: "81 2345 6789" }, ...resto] })).toThrow(/ficticio/);
  });
});

describe("datos ficticios", () => {
  it("correos en dominio reservado .example y telefonos en el bloque ficticio 555 01xx", () => {
    expect(DEMO_CUENTA.marca.dominio).toMatch(/\.example$/);
    for (const correo of Object.values(DEMO_CUENTA.marca.correos)) expect(correo).toMatch(/@eltizonnorteno\.example$/);
    for (const b of DEMO_CUENTA.sucursales) expect(b.telefono).toMatch(/^(\d{2} 5555 01\d{2}|\d{3} 555 01\d{2})$/);
    expect(DEMO_CUENTA.marca.telefonoOficina).toMatch(/5555 01\d{2}$/);
    for (const b of DEMO_CUENTA.sucursales) expect(b.direccion).toContain("ficticio");
  });

  it("ningun texto de la definicion parece un secreto o una URL con credenciales", () => {
    const todo = JSON.stringify(DEMO_CUENTA);
    expect(todo).not.toMatch(/(sk-[a-z0-9]{10,}|eyJ[a-zA-Z0-9_-]{20,}|postgres(ql)?:\/\/[^"\s]*@|api[_-]?key|secret|password|contrase)/i);
  });
});

describe("sql: idempotencia e inocuidad", () => {
  const cuerpo = renderDemoCuentaPlpgsql(plan);

  it("es determinista: renderizar dos veces da el mismo texto", () => {
    expect(renderDemoCuentaPlpgsql(plan)).toBe(cuerpo);
    expect(renderDemoCuentaDoBlock(plan)).toBe(`do $seed_dc$\n${cuerpo}\n$seed_dc$;`);
  });

  it("el JSON embebido es valido y trae 6 sucursales y 289 productos", () => {
    const m = /\$dc\$(.*)\$dc\$::jsonb/s.exec(cuerpo);
    expect(m).not.toBeNull();
    const doc = JSON.parse(m![1]!) as { branches: unknown[]; products: unknown[]; organization: { slug: string } };
    expect(doc.branches).toHaveLength(6);
    expect(doc.products).toHaveLength(289);
    expect(doc.organization.slug).toBe(plan.organization.slug);
  });

  it("todo insert de una tabla con identidad natural es un upsert o va protegido por not exists", () => {
    const inserts = cuerpo.split(/\n {2}insert into /).slice(1);
    expect(inserts.length).toBeGreaterThanOrEqual(12);
    for (const bloque of inserts) {
      const sentencia = bloque.split(";")[0]!;
      expect(/on conflict|not exists/i.test(sentencia), `insert sin guarda: ${sentencia.slice(0, 80)}`).toBe(true);
    }
  });

  it("aborta si el slug es de otra vertical, y solo borra branch_products acotado a la organizacion", () => {
    expect(cuerpo).toContain("ya existe en otra vertical");
    const borrados = [...cuerpo.matchAll(/delete from ([a-z_.]+)/g)].map((x) => x[1]);
    expect(borrados).toEqual(["restaurantes.branch_products"]);
    expect(cuerpo).toMatch(/pr\.organization_id = v_org/);
  });

  it("no crea usuarios, membresias ni credenciales, no habilita la voz y no toca la demo vieja", () => {
    expect(cuerpo).not.toMatch(/staff_user|membership|auth\./i);
    expect(cuerpo).not.toMatch(/drop |truncate |alter /i);
    expect(cuerpo).toMatch(/habilitado, voice_id\)\s+select p\.id, v_org, false, 'Kore'/);
    expect(cuerpo).not.toContain(SLUG_DEMO_VIEJA);
    expect(cuerpo).not.toMatch(/Taquer[ií]a Demo/i);
  });

  it("re-ejecutar no vuelve a prender un agotado ni pisa lo que el dueno edito (do nothing / solo precio)", () => {
    const upsertBranchProducts = /into restaurantes\.branch_products[\s\S]*?on conflict \(property_id, product_id\) do update set ([^;]*);/.exec(cuerpo);
    expect(upsertBranchProducts![1]).not.toContain("is_available");
    expect(cuerpo).toMatch(/branch_voice_config[\s\S]*?on conflict \(property_id\) do nothing/);
    expect(cuerpo).toMatch(/where not exists \(select 1 from restaurantes\.conocimiento_negocio/);
  });

  it("el preflight de esquema exige tambien la marca demo", () => {
    expect(renderEsquemaRequeridoDemoCuenta()).toContain("restaurantes.demo_organization.seed_version");
  });
});

describe("CLI: salvaguardas", () => {
  it("sin --apply es dry-run y los argumentos desconocidos se rechazan", () => {
    expect(parseArgs([])).toEqual({ apply: false, confirmHost: null, help: false, emitSql: null, ownerEmail: null });
    expect(parseArgs(["--", "--apply", "--confirm-host=db.example.com"])).toEqual({ apply: true, confirmHost: "db.example.com", help: false, emitSql: null, ownerEmail: null });
    expect(() => parseArgs(["--demo"])).toThrow(SeedTargetError);
  });

  it("sin SEED_DATABASE_URL no hay objetivo (a proposito no lee DATABASE_URL) y una base remota exige confirmar el host", () => {
    expect(() => describirObjetivo(undefined)).toThrow(/SEED_DATABASE_URL/);
    const remota = describirObjetivo("postgresql://u@db.ejemplo.test:5432/x");
    expect(() => assertPuedeAplicar(remota, { apply: true, confirmHost: null })).toThrow(SeedTargetError);
    expect(() => assertPuedeAplicar(remota, { apply: false, confirmHost: "db.ejemplo.test" })).toThrow(/dry-run/);
  });
});
