// El SQL del catalogo de citas de "Chatea con tus datos" se ejecuta contra Postgres REAL en
// scripts/verify-data-chat-citas/assertions.sql. Este guard exige que los textos sean IDENTICOS (modulo espacios en
// blanco) para que el verify nunca pruebe una consulta distinta a la que corre en produccion, y fija propiedades de
// seguridad del SQL que un cambio descuidado podria romper.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_CITAS_DATA_CHAT_SQL } from "../../src/data-chat/sql.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const assertions = readFileSync(path.resolve(here, "../../../../scripts/verify-data-chat-citas/assertions.sql"), "utf8");
const migration = readFileSync(path.resolve(here, "../../migrations/027_citas_data_chat_recordatorios.sql"), "utf8");
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const all = Object.entries(ALL_CITAS_DATA_CHAT_SQL);
const scoped = all.filter(([n]) => n !== "SQL_VISIBLE_BRANCHES" && n !== "SQL_REMINDER_DELIVERY");

describe("SQL de chat con datos (citas): identico al que verifica scripts/verify-data-chat-citas", () => {
  for (const [name, sql] of all) {
    it(`${name} aparece tal cual en assertions.sql`, () => {
      expect(norm(assertions)).toContain(norm(sql));
    });
  }
});

describe("SQL de chat con datos (citas): propiedades de seguridad", () => {
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

  it("nunca selecciona datos de clientes (nombre, telefono, correo, notas) ni ids de cita/cliente", () => {
    for (const [name, sql] of all) {
      const selected = sql.replace(/\bfrom citas\.customers\b/gi, "FROM_CUSTOMERS");
      expect(selected, name).not.toMatch(/FROM_CUSTOMERS|full_name|\bphone\b|\bemail\b|\bnotes\b|customer_phone|dedupe_fingerprint|idempotency_key|payload/i);
    }
    // el id del cliente solo se usa para contar (nunca sale a la lista de columnas finales)
    expect(ALL_CITAS_DATA_CHAT_SQL["SQL_CUSTOMERS"]).toMatch(/select count\(\*\) as customers/);
  });

  it("toda consulta acota por organizacion y por sucursales permitidas, y tiene tope de filas", () => {
    for (const [name, sql] of scoped) {
      expect(sql, name).toMatch(/\b[a-z]{1,2}\.organization_id = \$1/);
      expect(sql, name).toMatch(/\$2::uuid\[\] is null or [a-z]{1,2}\.property_id = any\(\$2::uuid\[\]\)/);
    }
    expect(ALL_CITAS_DATA_CHAT_SQL["SQL_VISIBLE_BRANCHES"]).toMatch(/p\.organization_id = \$1 and p\.vertical = 'citas'/);
    for (const [name, sql] of all) expect(sql, name).toMatch(/limit (\$\d|\d+)/);
  });

  it("el filtro de sucursales EXCLUYE las citas sin sucursal para un usuario acotado (no hay 'or property_id is null')", () => {
    for (const [name, sql] of all) expect(sql, name).not.toMatch(/\$2::uuid\[\] is null or [a-z]{1,2}\.property_id is null/i);
    // los profesionales (policy de lectura publica) repiten la cobertura de la membresia dentro de la consulta
    for (const name of ["SQL_OCCUPANCY_BY_PROVIDER", "SQL_OCCUPANCY_BY_BRANCH", "SQL_FREE_SLOTS"]) {
      expect(ALL_CITAS_DATA_CHAT_SQL[name], name).toMatch(/exists \(\s*select 1 from core\.membership m\s+where m\.organization_id = pr\.organization_id and m\.user_id = auth\.uid\(\)/);
    }
  });

  it("los servicios se unen SIEMPRE por la misma organizacion de la cita (nunca un precio de otra clinica)", () => {
    for (const name of ["SQL_REVENUE_BY_PERIOD", "SQL_REVENUE_BY_SERVICE"]) expect(ALL_CITAS_DATA_CHAT_SQL[name], name).toMatch(/join citas\.services s on s\.id = a\.service_id and s\.organization_id = a\.organization_id/);
    expect(ALL_CITAS_DATA_CHAT_SQL["SQL_ATTENDANCE_BY_PROVIDER"]).toMatch(/join citas\.providers pv on pv\.id = a\.provider_id and pv\.organization_id = a\.organization_id/);
  });

  it("estados: ingresos solo de citas COMPLETADAS; ocupacion, huecos y clientes solo de citas vivas (nunca canceladas ni no-show)", () => {
    for (const name of ["SQL_REVENUE_BY_PERIOD", "SQL_REVENUE_BY_SERVICE"]) expect(ALL_CITAS_DATA_CHAT_SQL[name], name).toMatch(/a\.status = 'completed'/);
    for (const name of ["SQL_OCCUPANCY_BY_PROVIDER", "SQL_OCCUPANCY_BY_BRANCH", "SQL_FREE_SLOTS"]) expect(ALL_CITAS_DATA_CHAT_SQL[name], name).toMatch(/a\.status in \('pending', 'confirmed', 'completed'\)/);
    expect(ALL_CITAS_DATA_CHAT_SQL["SQL_CUSTOMERS"]).toMatch(/a\.status in \('pending', 'confirmed', 'completed'\)/);
    expect(ALL_CITAS_DATA_CHAT_SQL["SQL_PENDING_REMINDERS"]).toMatch(/a\.status in \('pending', 'confirmed'\) and a\.reminder_24h_sent_at is null/);
  });

  it("dias y horas en la zona del negocio: la zona es un parametro y los dias se generan por entero (no dependen de la zona de la sesion)", () => {
    for (const name of ["SQL_APPOINTMENTS_BY_PERIOD", "SQL_REVENUE_BY_PERIOD"]) expect(ALL_CITAS_DATA_CHAT_SQL[name], name).toMatch(/a\.starts_at at time zone \$5::text/);
    for (const name of ["SQL_OCCUPANCY_BY_PROVIDER", "SQL_OCCUPANCY_BY_BRANCH", "SQL_FREE_SLOTS"]) {
      const sql = ALL_CITAS_DATA_CHAT_SQL[name]!;
      expect(sql, name).toMatch(/generate_series\(0, \$4::date - \$3::date\)/);
      expect(sql, name).toMatch(/at time zone \$5::text/);
    }
  });

  it("el estado de entrega solo se lee por la funcion de la migracion 027 (nunca la tabla del outbox)", () => {
    const sql = ALL_CITAS_DATA_CHAT_SQL["SQL_REMINDER_DELIVERY"]!;
    expect(sql).toMatch(/from citas\.data_chat_reminder_delivery\(/);
    for (const [name, other] of all) expect(other, name).not.toMatch(/citas\.messaging_outbox/);
  });
});

describe("migracion 027: la funcion que lee el outbox", () => {
  it("security definer con search_path fijo, solo EXECUTE para authenticated y exige sesion + owner/admin", () => {
    expect(migration).toMatch(/security definer\s+set search_path = citas, core, pg_temp/);
    expect(migration).toMatch(/revoke all on function citas\.data_chat_reminder_delivery\(uuid, uuid\[\], timestamptz, timestamptz\) from public, anon;/);
    expect(migration).toMatch(/grant execute on function citas\.data_chat_reminder_delivery\(uuid, uuid\[\], timestamptz, timestamptz\) to authenticated;/);
    expect(migration).not.toMatch(/to [a-z_, ]*(anon|public)\b[^;]*;\s*$/m);
    expect(migration).toMatch(/where auth\.uid\(\) is not null/);
    expect(migration).toMatch(/m\.vertical_role in \('owner', 'admin'\)/);
    expect(migration).toMatch(/citas\.membership_covers_property\(a\.organization_id, a\.property_id\)/);
  });

  it("solo devuelve conteos: nunca el payload, el destinatario ni el error", () => {
    expect(migration).toMatch(/returns table \(channel text, status text, total bigint\)/);
    expect(migration).not.toMatch(/o\.payload|last_error|\bto_jsonb\b/);
  });

  it("es de solo lectura (language sql stable, sin DML)", () => {
    expect(migration).toMatch(/language sql\s+stable/);
    expect(migration).not.toMatch(/\b(insert into|update citas|delete from)\b/i);
  });
});
