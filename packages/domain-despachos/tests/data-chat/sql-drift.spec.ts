// El SQL del catalogo de despachos se ejecuta contra Postgres REAL en
// scripts/verify-data-chat-despachos-licitaciones/assertions.sql. Este guard exige que los textos sean
// IDENTICOS (modulo espacios en blanco) para que el verify nunca pruebe una consulta distinta a la que
// corre en produccion, y fija propiedades de seguridad del SQL que un cambio descuidado podria romper.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_DATA_CHAT_SQL } from "../../src/data-chat/sql.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const assertions = readFileSync(path.resolve(here, "../../../../scripts/verify-data-chat-despachos-licitaciones/assertions.sql"), "utf8");
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("SQL de chat con datos (despachos): identico al que verifica scripts/verify-data-chat-despachos-licitaciones", () => {
  for (const [name, sql] of Object.entries(ALL_DATA_CHAT_SQL)) {
    it(`${name} aparece tal cual en assertions.sql`, () => {
      expect(norm(assertions)).toContain(norm(sql));
    });
  }
});

describe("SQL de chat con datos (despachos): propiedades de seguridad", () => {
  const all = Object.entries(ALL_DATA_CHAT_SQL);
  const scoped = all.filter(([n]) => !n.startsWith("SQL_EFOS"));

  it("solo lectura: ninguna sentencia escribe ni hace DDL", () => {
    for (const [name, sql] of all) {
      expect(sql, name).toMatch(/^\s*(select|with)\b/i);
      expect(sql, name).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate|grant|copy)\b/i);
    }
  });

  it("parametrizado: sin interpolacion ni concatenacion de valores", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toContain("${");
      expect(sql, name).not.toMatch(/\|\|/);
    }
  });

  it("todo parametro declarado hasta el mayor $n se usa (Postgres rechaza parametros sin referenciar)", () => {
    for (const [name, sql] of all) {
      const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      if (used.size === 0) continue; // efos_estado no recibe parametros
      for (let i = 1; i <= Math.max(...used); i += 1) expect(used.has(i), `${name} no usa $${i}`).toBe(true);
    }
  });

  it("toda consulta acotada acota por organizacion ($1), exige vertical despachos y filtra los clientes permitidos ($2)", () => {
    for (const [name, sql] of scoped) {
      expect(sql, name).toMatch(/organization_id = \$1/);
      expect(sql, name).toMatch(/p\.vertical = 'despachos'/);
      expect(sql, name).toMatch(/\$2::uuid\[\] is null or \w+\.(property_id|id) = any\(\$2::uuid\[\]\)/);
      expect(sql, name).toMatch(/join core\.property p|from core\.property p/);
    }
  });

  it("toda consulta que devuelve filas tiene tope (limit) salvo la antiguedad (maximo 5 filas) y el estado de la lista", () => {
    for (const [name, sql] of all) {
      if (name === "SQL_COBRANZA_ANTIGUEDAD" || name === "SQL_EFOS_ESTADO" || name === "SQL_EFOS_AFECTADOS") continue; // las funciones EFOS ya topan en la base (limit 500 / 1 fila)
      expect(sql, name).toMatch(/limit (\$\d|\d+)/);
    }
  });

  it("la lista 69-B SOLO se lee por las funciones security definer (nunca por las tablas efos_*)", () => {
    for (const [name, sql] of all) expect(sql, name).not.toMatch(/efos_contribuyente|efos_ingesta/);
    expect(ALL_DATA_CHAT_SQL["SQL_EFOS_AFECTADOS"]).toMatch(/despachos\.efos_invoices_afectados\(\$1::uuid\)/);
    expect(ALL_DATA_CHAT_SQL["SQL_EFOS_ESTADO"]).toMatch(/despachos\.efos_estado\(\)/);
  });

  it("nunca selecciona correos, telefonos ni contenido del CFDI (solo agregados y datos de negocio)", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toMatch(/\b(email|correo|telefono|phone|issues|warnings|diot|comprobante_url|decision_note)\b/i);
    }
  });

  it("la cartera cuenta solo cuentas SIN pagar (pagado_en is null)", () => {
    for (const n of ["SQL_CARTERA_POR_CLIENTE", "SQL_COBRANZA_ANTIGUEDAD"]) expect(ALL_DATA_CHAT_SQL[n], n).toMatch(/pagado_en is null/);
  });

  it("el IVA acreditable solo suma CFDI tipo I validos", () => {
    expect(ALL_DATA_CHAT_SQL["SQL_IVA_ACREDITABLE"]).toMatch(/i\.tipo = 'I' and i\.valido/);
  });
});
