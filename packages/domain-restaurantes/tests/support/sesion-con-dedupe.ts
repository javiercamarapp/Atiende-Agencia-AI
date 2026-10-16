// Sesion falsa con la semantica de dedupe de core.emit_notification (misma clave de dedupe = 0 filas nuevas). Registra los parametros de cada emision:
// [0] organizationId, [2] evento, [4] severidad, [5] titulo, [6] cuerpo, [10] clave de dedupe completa.
import { AbortAwareFakeSession } from "./aborting-fake-session.ts";

export function sesionConDedupe(extra: ConstructorParameters<typeof AbortAwareFakeSession>[0] = []) {
  const vistas = new Set<string>();
  const emisiones: unknown[][] = [];
  const session = new AbortAwareFakeSession([{ match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] }, ...extra]);
  const original = session.query.bind(session);
  session.query = (async (sql: string, p?: unknown[]) => {
    if (/select core\.emit_notification/.test(sql)) {
      const clave = `${String((p ?? [])[0])}|${String((p ?? [])[10])}`;
      emisiones.push(p ?? []);
      if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
      vistas.add(clave);
    }
    return original(sql, p);
  }) as typeof session.query;
  return { session, emisiones };
}
