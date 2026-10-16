// El SQL del catalogo de "Chatea con tus datos" se ejecuta contra Postgres REAL en
// scripts/verify-data-chat/assertions.sql. Este guard exige que los textos sean IDENTICOS (modulo
// espacios en blanco) para que el verify nunca pruebe una consulta distinta a la que corre en
// produccion, y fija propiedades de seguridad del SQL que un cambio descuidado podria romper.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_DATA_CHAT_SQL } from "../../src/data-chat/sql.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const assertions = readFileSync(path.resolve(here, "../../../../scripts/verify-data-chat/assertions.sql"), "utf8");
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("SQL de chat con datos: identico al que verifica scripts/verify-data-chat", () => {
  for (const [name, sql] of Object.entries(ALL_DATA_CHAT_SQL)) {
    it(`${name} aparece tal cual en assertions.sql`, () => {
      expect(norm(assertions)).toContain(norm(sql));
    });
  }
});

describe("SQL de chat con datos: propiedades de seguridad", () => {
  const all = Object.entries(ALL_DATA_CHAT_SQL);

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
      expect(sql, name).toMatch(/\$1\b/);
    }
  });

  it("todo parametro declarado hasta el mayor $n se usa (Postgres rechaza parametros sin referenciar)", () => {
    for (const [name, sql] of all) {
      const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      const max = Math.max(...used);
      for (let i = 1; i <= max; i += 1) expect(used.has(i), `${name} no usa $${i}`).toBe(true);
    }
  });

  it("nunca selecciona nombre ni telefono de comensales (solo agregados); el telefono solo forma la llave interna de clientes", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toMatch(/customer_name|customer_address|call_transcript|call_recording/i);
      const phone = [...sql.matchAll(/customer_phone/gi)].length;
      if (phone > 0) {
        expect(name).toBe("SQL_RECURRING_CUSTOMERS");
      }
    }
    // la llave del cliente jamas aparece en la lista final de columnas
    const finalSelect = ALL_DATA_CHAT_SQL["SQL_RECURRING_CUSTOMERS"]!.split(/select count\(\*\) as customers/i)[1]!;
    expect(finalSelect).not.toMatch(/ckey\s+as|customer_phone/i);
  });

  it("todas las consultas de pedidos acotan por organizacion, por sucursales permitidas y por ventana", () => {
    for (const [name, sql] of all.filter(([n]) => n !== "SQL_VISIBLE_BRANCHES" && n !== "SQL_PROMOTIONS")) {
      expect(sql, name).toMatch(/o\.organization_id = \$1/);
      expect(sql, name).toMatch(/o\.property_id = any\(\$2::uuid\[\]\)/);
      expect(sql, name).toMatch(/join core\.property p on p\.id = o\.property_id/);
    }
    expect(ALL_DATA_CHAT_SQL["SQL_PROMOTIONS"]).toMatch(/pr\.organization_id = \$1/);
    expect(ALL_DATA_CHAT_SQL["SQL_VISIBLE_BRANCHES"]).toMatch(/p\.organization_id = \$1/);
  });

  it("ventas excluyen cancelados y toda consulta tiene tope de filas", () => {
    for (const [name, sql] of all) {
      expect(sql, name).toMatch(/limit (\$\d|\d+)/);
      if (name.startsWith("SQL_SALES") || name.startsWith("SQL_TOP") || name === "SQL_ORDERS_BY_CHANNEL" || name === "SQL_PEAK_HOURS") {
        expect(sql, name).toMatch(/o\.status not in \('cancelado', 'no_recogido', 'programado', 'por_aprobar'\)/);
      }
    }
  });
});
