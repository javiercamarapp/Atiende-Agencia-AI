// Lectura de notificaciones contra la base SIN la migracion 0039: las funciones v2 no existen (42883) y el
// repositorio cae a las de 0013. La sesion es AbortAwareFakeSession (reproduce 25P02): el respaldo solo
// funciona si el intento v2 corrio dentro de un SAVEPOINT.
import { describe, expect, it } from "vitest";
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const STAFF = "00000000-0000-0000-0000-00000000c001";

function noExiste(nombre: string): Error & { code: string } {
  const err = new Error(`function ${nombre}(uuid) does not exist`) as Error & { code: string };
  err.code = "42883";
  return err;
}

const fila = (id: string, createdAt: string, readAt: string | null) => ({ id, vertical: "hoteles", titulo: id, cuerpo: null, entidad_tipo: null, entidad_id: null, created_at: createdAt, read_at: readAt });

describe("PostgresCoreRepository -- notificaciones contra la base sin migrar", () => {
  it("la lista cae a core.list_notifications_for_staff, con campos del productor en null/info, y la sesion sigue usable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /list_notifications_v2_for_staff/, respond: () => noExiste("core.list_notifications_v2_for_staff") },
      { match: /list_notifications_for_staff/, respond: () => [fila("a", "2026-10-01T10:00:00.000Z", null)] },
    ]);
    const rows = await new PostgresCoreRepository(session).listNotificationsForStaff(STAFF);
    expect(rows).toEqual([
      expect.objectContaining({ id: "a", organizationId: null, tipo: null, categoria: null, severidad: "info", enlace: null, readAt: null }),
    ]);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("el respaldo respeta los filtros: solo no leidas, antes de una fecha y limite; una categoria no devuelve nada (0013 no tiene)", async () => {
    const filas = [fila("nueva", "2026-10-01T12:00:00.000Z", null), fila("leida", "2026-10-01T11:00:00.000Z", "2026-10-01T11:30:00.000Z"), fila("vieja", "2026-10-01T10:00:00.000Z", null)];
    const sesion = () =>
      new AbortAwareFakeSession([
        { match: /list_notifications_v2_for_staff/, respond: () => noExiste("core.list_notifications_v2_for_staff") },
        { match: /list_notifications_for_staff/, respond: () => filas },
      ]);
    const ids = async (o: Parameters<PostgresCoreRepository["listNotificationsForStaff"]>[1]) => (await new PostgresCoreRepository(sesion()).listNotificationsForStaff(STAFF, o)).map((r) => r.id);
    expect(await ids({ soloNoLeidas: true })).toEqual(["nueva", "vieja"]);
    expect(await ids({ before: "2026-10-01T11:30:00.000Z" })).toEqual(["leida", "vieja"]);
    expect(await ids({ limit: 1 })).toEqual(["nueva"]);
    expect(await ids({ categoria: "operacion" })).toEqual([]);
  });

  it("el contador cae a core.count_unread_notifications_for_staff", async () => {
    const session = new AbortAwareFakeSession([
      { match: /count_unread_notifications_v2_for_staff/, respond: () => noExiste("core.count_unread_notifications_v2_for_staff") },
      { match: /count_unread_notifications_for_staff/, respond: () => [{ count_unread_notifications_for_staff: 4 }] },
    ]);
    expect(await new PostgresCoreRepository(session).countUnreadNotificationsForStaff(STAFF)).toBe(4);
  });

  it("con la migracion aplicada usa las v2 (sin respaldo)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /list_notifications_v2_for_staff/, respond: () => [{ ...fila("a", "2026-10-01T10:00:00.000Z", null), organization_id: "o1", tipo: "hoteles.ticket.sla_vencido", categoria: "operacion", severidad: "atencion", enlace: "/hoteles/x/tickets" }] },
      { match: /count_unread_notifications_v2_for_staff/, respond: () => [{ count_unread_notifications_v2_for_staff: 1 }] },
    ]);
    const repo = new PostgresCoreRepository(session);
    expect(await repo.listNotificationsForStaff(STAFF, { categoria: "operacion" })).toEqual([
      expect.objectContaining({ organizationId: "o1", tipo: "hoteles.ticket.sla_vencido", categoria: "operacion", severidad: "atencion", enlace: "/hoteles/x/tickets" }),
    ]);
    expect(await repo.countUnreadNotificationsForStaff(STAFF)).toBe(1);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara con el respaldo)", async () => {
    const err = Object.assign(new Error("permission denied"), { code: "42501" });
    const session = new AbortAwareFakeSession([{ match: /list_notifications_v2_for_staff/, respond: () => err }]);
    await expect(new PostgresCoreRepository(session).listNotificationsForStaff(STAFF)).rejects.toBe(err);
  });
});
