// El SQL del catalogo de hoteles de "Chatea con tus datos" se ejecuta contra Postgres REAL en
// scripts/verify-data-chat-hoteles/assertions.sql. Este guard exige que los textos sean IDENTICOS (modulo
// espacios en blanco) para que el verify nunca pruebe una consulta distinta a la que corre en produccion, y
// fija propiedades de seguridad del SQL que un cambio descuidado podria romper.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_HOTELES_DATA_CHAT_SQL } from "../../src/data-chat/sql.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const assertions = readFileSync(path.resolve(here, "../../../../scripts/verify-data-chat-hoteles/assertions.sql"), "utf8");
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const all = Object.entries(ALL_HOTELES_DATA_CHAT_SQL);

describe("SQL de chat con datos (hoteles): identico al que verifica scripts/verify-data-chat-hoteles", () => {
  for (const [name, sql] of all) {
    it(`${name} aparece tal cual en assertions.sql`, () => {
      expect(norm(assertions)).toContain(norm(sql));
    });
  }
});

describe("SQL de chat con datos (hoteles): propiedades de seguridad", () => {
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

  it("nunca selecciona datos de huespedes ni texto libre (mensajes, notas, nombres, correos, telefonos)", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toMatch(/guest_message|resolution_note|full_name|\bemail\b|\bphone\b|notes\b|inspection_note|identity_vault|guest_id/i);
    }
  });

  it("toda consulta acota por organizacion, por hoteles permitidos, joinea core.property (RLS) y tiene tope de filas", () => {
    for (const [name, sql] of all.filter(([n]) => n !== "SQL_VISIBLE_HOTELS")) {
      expect(sql, name).toMatch(/\b[a-z]\.organization_id = \$1/);
      expect(sql, name).toMatch(/\$2::uuid\[\] is null or [a-z]\.property_id = any\(\$2::uuid\[\]\)/);
      expect(sql, name).toMatch(/join core\.property p on p\.id = [a-z]\.property_id/);
    }
    expect(ALL_HOTELES_DATA_CHAT_SQL["SQL_VISIBLE_HOTELS"]).toMatch(/p\.organization_id = \$1/);
    for (const [name, sql] of all) expect(sql, name).toMatch(/limit (\$\d|\d+)/);
  });

  it("ocupacion: cargos e inventario se agregan en CTE separados y se unen despues (nunca un JOIN que multiplique filas)", () => {
    const sql = ALL_HOTELES_DATA_CHAT_SQL["SQL_OCCUPANCY_ADR_REVPAR"]!;
    expect(sql).toMatch(/with ocupadas as[\s\S]*group by c\.stay_date[\s\S]*disponibles as[\s\S]*group by a\.date/);
    expect(sql).toMatch(/from ocupadas o\s+full join disponibles d on d\.day = o\.day/);
    expect(sql).toMatch(/c\.concept = 'hospedaje' and c\.reversed_by is null/);
  });

  it("ingresos: la propina no es ingreso y el reverso se resuelve al cargo original", () => {
    const sql = ALL_HOTELES_DATA_CHAT_SQL["SQL_REVENUE_BY_PERIOD"]!;
    expect(sql).toMatch(/coalesce\(orig\.concept, c\.concept\) <> 'propina'/);
    expect(sql).toMatch(/left join hoteles\.charge orig on orig\.id = c\.reverses_charge_id/);
  });

  it("llegadas/salidas y cancelaciones solo cuentan reservas vigentes (nunca cotizadas, canceladas ni no-show)", () => {
    const mov = ALL_HOTELES_DATA_CHAT_SQL["SQL_ARRIVALS_DEPARTURES"]!;
    expect([...mov.matchAll(/r\.status in \('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada'\)/g)]).toHaveLength(2);
    expect(ALL_HOTELES_DATA_CHAT_SQL["SQL_CANCELLATIONS"]).toMatch(/r\.status = 'cancelada'/);
  });
});
