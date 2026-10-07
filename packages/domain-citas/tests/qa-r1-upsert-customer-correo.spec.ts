// QA R1 citas seguridad 06 -- el correo de una reserva publica (telefono sin verificar) no se asigna a un expediente que ya existe.
// Postgres con una sesion guionada (solo se mira que SQL corre) y el doble en memoria (misma regla de coalesce que Postgres).
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";

const ORG = "00000000-0000-0000-0000-00000000aa01";
const existente = { id: "c1", organization_id: ORG, full_name: "Paciente Real", phone: "9992223344", email: null };

function sesionConClienteExistente() {
  const sqls: string[] = [];
  const session = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("select id, organization_id, full_name, phone, email from citas.customers")) return { rows: [existente] };
      if (sql.includes("update citas.customers set email")) return { rows: [{ ...existente, email: "tercero@example.com" }] };
      return { rows: [] };
    },
    exec: async () => undefined,
  } as unknown as TenantDbSession;
  return { session, sqls };
}

describe("upsertCustomer con emailOnlyIfNew", () => {
  it("Postgres: sobre un cliente existente sin correo NO ejecuta ningun UPDATE del correo y devuelve el expediente tal cual", async () => {
    const { session, sqls } = sesionConClienteExistente();
    const repo = new PostgresCitasRepository(session);
    const cliente = await repo.upsertCustomer(ORG, "9992223344", "Otra persona", "tercero@example.com", { emailOnlyIfNew: true });
    expect(cliente.email).toBeNull();
    expect(sqls.some((q) => q.includes("update citas.customers"))).toBe(false);
  });

  it("Postgres: sin la bandera (canal con titular identificado) un cliente existente sin correo SI lo recibe", async () => {
    const { session, sqls } = sesionConClienteExistente();
    const repo = new PostgresCitasRepository(session);
    const cliente = await repo.upsertCustomer(ORG, "9992223344", "Paciente Real", "paciente@example.com");
    expect(sqls.some((q) => q.includes("update citas.customers"))).toBe(true);
    expect(cliente.email).toBe("tercero@example.com"); // lo que devolvio el UPDATE guionado
  });

  it("en memoria: con la bandera el correo no se asigna a un existente, un cliente nuevo si lo guarda, y un correo ya guardado nunca se pisa", async () => {
    const repo = new InMemoryCitasRepository();
    const sinCorreo = await repo.upsertCustomer(ORG, "9992223344", "Paciente Real", null);
    expect((await repo.upsertCustomer(ORG, "9992223344", "Otra", "tercero@example.com", { emailOnlyIfNew: true })).email).toBeNull();
    expect((await repo.findCustomerByPhone(ORG, "9992223344"))?.email ?? null).toBeNull();

    const nuevo = await repo.upsertCustomer(ORG, "9993334455", "Nuevo", "nuevo@example.com", { emailOnlyIfNew: true });
    expect(nuevo.email).toBe("nuevo@example.com");

    expect(sinCorreo.id).not.toBe(nuevo.id);
    await repo.upsertCustomer(ORG, "9993334455", "Nuevo", "otro@example.com");
    expect((await repo.findCustomerByPhone(ORG, "9993334455"))?.email).toBe("nuevo@example.com");
  });
});
