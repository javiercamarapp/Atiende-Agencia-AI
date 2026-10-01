// El SQL del catalogo de rentas de "Chatea con tus datos" se ejecuta contra Postgres REAL en
// scripts/verify-data-chat-rentas/assertions.sql. Este guard exige que los textos sean IDENTICOS (modulo
// espacios en blanco) para que el verify nunca pruebe una consulta distinta a la que corre en produccion, y
// fija propiedades de seguridad del SQL que un cambio descuidado podria romper.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_RENTAS_DATA_CHAT_SQL } from "../../src/data-chat/sql.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const assertions = readFileSync(path.resolve(here, "../../../../scripts/verify-data-chat-rentas/assertions.sql"), "utf8");
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const all = Object.entries(ALL_RENTAS_DATA_CHAT_SQL);

describe("SQL de chat con datos (rentas): identico al que verifica scripts/verify-data-chat-rentas", () => {
  for (const [name, sql] of all) {
    it(`${name} aparece tal cual en assertions.sql`, () => {
      expect(norm(assertions)).toContain(norm(sql));
    });
  }
});

describe("SQL de chat con datos (rentas): propiedades de seguridad", () => {
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

  it("nunca selecciona datos de huespedes ni contacto de propietarios (solo el nombre como etiqueta de agrupacion)", () => {
    for (const [name, sql] of all) {
      expect(sql, name).not.toMatch(/guest_minimo|huesped_minimo|\bcontacto\b|\bemail\b|\btelefono\b|\bphone\b|external_id|referencia_externa|\bnota\b/i);
    }
  });

  it("toda consulta acota por organizacion, por propiedades permitidas, joinea core.property (RLS) y tiene tope de filas", () => {
    for (const [name, sql] of all.filter(([n]) => n !== "SQL_VISIBLE_PROPERTIES")) {
      expect(sql, name).toMatch(/\b[a-z]{1,2}\.organization_id = \$1/);
      expect(sql, name).toMatch(/\$2::uuid\[\] is null or [a-z]{1,2}\.property_id = any\(\$2::uuid\[\]\)/);
      expect(sql, name).toMatch(/join core\.property p on p\.id = [a-z]{1,2}\.property_id/);
    }
    expect(ALL_RENTAS_DATA_CHAT_SQL["SQL_VISIBLE_PROPERTIES"]).toMatch(/p\.organization_id = \$1/);
    for (const [name, sql] of all) expect(sql, name).toMatch(/limit (\$\d|\d+)/);
  });

  it("solo noches de reservas CONFIRMADAS cuentan como ocupadas; bloqueos de propietario/mantenimiento (no el buffer de limpieza) restan disponibilidad", () => {
    const sql = ALL_RENTAS_DATA_CHAT_SQL["SQL_OCCUPANCY_BY_UNIT"]!;
    expect(sql).toMatch(/o\.capa = 'reserva' and o\.estado = 'confirmado'/);
    expect(sql).toMatch(/o\.razon in \('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO'\) and o\.estado <> 'cancelado'/);
    expect(sql).not.toMatch(/BUFFER_LIMPIEZA/);
    // la noche se evalua UNA vez por (unidad, dia) con EXISTS: un traslape nunca cuenta doble
    expect([...sql.matchAll(/exists \(select 1 from rentas\.ocupacion/g)]).toHaveLength(2);
  });

  it("finanzas: solo reservas confirmadas, solo MXN se suma, y reserva_financiero (1:1) nunca se une con sus lineas", () => {
    for (const name of ["SQL_INCOME_BY_CHANNEL", "SQL_INCOME_BY_OWNER"]) {
      const sql = ALL_RENTAS_DATA_CHAT_SQL[name]!;
      expect(sql, name).toMatch(/o\.capa = 'reserva' and o\.estado = 'confirmado'/);
      expect(sql, name).toMatch(/filter \(where rf\.moneda = 'MXN'\)/);
      expect(sql, name).toMatch(/lower\(o\.rango\) between \$3::date and \$4::date/);
      expect(sql, name).not.toMatch(/linea_gasto|linea_impuesto|reserva_financiero_id/);
    }
  });

  it("liquidaciones: solo la ultima version (distinct on ... version desc)", () => {
    const sql = ALL_RENTAS_DATA_CHAT_SQL["SQL_OWNER_STATEMENTS"]!;
    expect(sql).toMatch(/select distinct on \(os\.owner_id, os\.property_id, os\.periodo_inicio, os\.periodo_fin\)/);
    expect(sql).toMatch(/order by os\.owner_id, os\.property_id, os\.periodo_inicio, os\.periodo_fin, os\.version desc/);
  });

  it("pagos de canal: cabecera y lineas se agregan en CTE separados (unir pago x lineas repetiria el monto)", () => {
    const sql = ALL_RENTAS_DATA_CHAT_SQL["SQL_CHANNEL_PAYOUTS"]!;
    expect(sql).toMatch(/with pay as[\s\S]*lines as[\s\S]*group by pl\.payout_id/);
    expect(sql).toMatch(/left join lines l on l\.payout_id = pay\.id/);
  });

  it("conflictos y tareas excluyen lo cerrado (resueltos, completadas, canceladas)", () => {
    expect(ALL_RENTAS_DATA_CHAT_SQL["SQL_OPEN_CALENDAR_CONFLICTS"]).toMatch(/cc\.resuelto_en is null/);
    expect(ALL_RENTAS_DATA_CHAT_SQL["SQL_PENDING_TASKS"]).toMatch(/t\.estado in \('pendiente', 'asignada', 'en_progreso', 'bloqueada'\)/);
  });
});
