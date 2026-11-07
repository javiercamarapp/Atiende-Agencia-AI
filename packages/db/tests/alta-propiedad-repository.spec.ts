// Alta de sucursal/propiedad (0071): piezas puras del lado TypeScript -- slug, tope de una sola fuente y traduccion del rechazo de
// activacion (55000) con sus pasos pendientes. Lo que hace cumplir la base esta en scripts/verify-alta-sucursal/.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AltaPropiedadError,
  InMemoryAltaPropiedadRepository,
  recortarGuiones,
  slugSucursal,
  TOPE_PROPIEDADES_POR_ORGANIZACION,
  topePropiedadesPorOrganizacion,
  traducirErrorAltaPropiedad,
} from "../src/alta-propiedad-repository.ts";

const MIGRACION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations/0071_alta_sucursal_propiedad.sql");

function capturar(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("se esperaba un error");
}

describe("slugSucursal", () => {
  it("nunca termina en '-' aunque el corte a 60 caiga justo en un guion", () => {
    const slug = slugSucursal(`${"a".repeat(59)} b`);
    expect(slug).toBe("a".repeat(59));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("nunca empieza ni termina en '-' con signos al inicio o al final; quita acentos", () => {
    expect(slugSucursal("¡¡Sucursal Centro Histórico!!")).toBe("sucursal-centro-historico");
    expect(slugSucursal("  --Norte--  ")).toBe("norte");
  });

  it("recortarGuiones quita los '-' de las orillas en tiempo lineal, sin regex (CodeQL js/polynomial-redos)", () => {
    expect(recortarGuiones("--a-b--")).toBe("a-b");
    expect(recortarGuiones("----")).toBe("");
    expect(recortarGuiones("")).toBe("");
    expect(recortarGuiones("abc")).toBe("abc");
    // Peor caso de la regex /^-+|-+$/: muchos '-' seguidos de algo que no es '-'. Lineal: 200k guiones se recortan al instante.
    const muchos = `${"-".repeat(200_000)}x${"-".repeat(200_000)}`;
    const inicio = performance.now();
    expect(recortarGuiones(muchos)).toBe("x");
    expect(performance.now() - inicio).toBeLessThan(500);
  });

  it("slugSucursal con miles de signos sigue siendo rapido y valido", () => {
    const inicio = performance.now();
    expect(slugSucursal(`${"!-".repeat(100_000)}Centro${"-!".repeat(100_000)}`)).toBe("centro");
    expect(performance.now() - inicio).toBeLessThan(500);
  });

  it("sin letras ni numeros cae a 'sucursal'", () => {
    expect(slugSucursal("¡¿?!")).toBe("sucursal");
  });

  it("propiedad: para cualquier nombre, el slug cumple ^[a-z0-9](...[a-z0-9])?$ y mide <= 60", () => {
    const nombres = ["-x-", `${"ñ".repeat(70)}`, `${"ab ".repeat(30)}`, "Taquería #1 (Altabrisa)", `${"z".repeat(60)}-`, `-${"z".repeat(61)}`];
    for (const n of nombres) {
      const s = slugSucursal(n);
      expect(s.length).toBeLessThanOrEqual(60);
      expect(s).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe("tope de sucursales/propiedades (tope temporal hasta ligarlo al plan)", () => {
  it("licitaciones 1, demas verticales 50", () => {
    expect(topePropiedadesPorOrganizacion("licitaciones")).toBe(1);
    expect(topePropiedadesPorOrganizacion("restaurantes")).toBe(50);
    expect(topePropiedadesPorOrganizacion("hoteles")).toBe(TOPE_PROPIEDADES_POR_ORGANIZACION.porOmision);
  });

  it("la constante TS es espejo exacto de core.propiedad_tope_por_organizacion y la base no repite el numero en otro lado", () => {
    const sql = readFileSync(MIGRACION, "utf8");
    expect(sql).toContain(
      `select case p_vertical when 'licitaciones' then ${TOPE_PROPIEDADES_POR_ORGANIZACION.licitaciones} else ${TOPE_PROPIEDADES_POR_ORGANIZACION.porOmision} end;`,
    );
    expect(sql).toContain("v_tope := core.propiedad_tope_por_organizacion(v_org.vertical);");
    // El numero vive en un solo lugar del SQL (la funcion del tope), no repetido en el cuerpo del alta.
    expect(sql.match(/then 1 else 50/g)).toHaveLength(1);
  });

  it("el doble en memoria usa el mismo tope", async () => {
    const repo = new InMemoryAltaPropiedadRepository();
    repo.seedOrganizacion({ id: "o1", slug: "lici", vertical: "licitaciones" });
    repo.seedGestor("o1", "u1");
    await repo.crearComoDueno("u1", { orgSlug: "lici", vertical: "licitaciones", nombre: "Empresa", zonaHoraria: null });
    await expect(repo.crearComoDueno("u1", { orgSlug: "lici", vertical: "licitaciones", nombre: "Otra", zonaHoraria: null })).rejects.toMatchObject({ codigo: "tope" });
  });
});

describe("traducirErrorAltaPropiedad", () => {
  it("55000 -> incompleta con los pasos del DETAIL, sin el prefijo de la funcion", () => {
    const err = capturar(() =>
      traducirErrorAltaPropiedad({
        code: "55000",
        message: "activar_propiedad_organizacion: faltan pasos obligatorios antes de activar: Menú; Horario de la sucursal",
        detail: "menu,horario",
      }),
    );
    expect(err).toBeInstanceOf(AltaPropiedadError);
    expect(err).toMatchObject({ codigo: "incompleta", faltantes: ["menu", "horario"] });
    expect((err as Error).message).toBe("faltan pasos obligatorios antes de activar: Menú; Horario de la sucursal");
  });

  it("un DETAIL ausente o con basura no inventa pasos", () => {
    expect(capturar(() => traducirErrorAltaPropiedad({ code: "55000", message: "x: y" }))).toMatchObject({ faltantes: [] });
    expect(capturar(() => traducirErrorAltaPropiedad({ code: "55000", message: "x: y", detail: "menu,<script>,DROP" }))).toMatchObject({ faltantes: ["menu"] });
  });
});

describe("la sucursal nace inactiva", () => {
  it("crearComoDueno devuelve status inactive y el doble la guarda inactiva", async () => {
    const repo = new InMemoryAltaPropiedadRepository();
    repo.seedOrganizacion({ id: "o1", slug: "resto", vertical: "restaurantes" });
    repo.seedGestor("o1", "u1");
    const creada = await repo.crearComoDueno("u1", { orgSlug: "resto", vertical: "restaurantes", nombre: "Centro", zonaHoraria: null });
    expect(creada.status).toBe("inactive");
    expect(repo.propiedadesDe("o1")).toEqual([{ id: creada.propertyId, nombre: "Centro", status: "inactive" }]);
  });
});
