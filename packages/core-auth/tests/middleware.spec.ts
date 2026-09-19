import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import {
  ApiError,
  authMiddleware,
  assertVerticalRole,
  dbSession,
  requestId,
  requirePropertyMembership,
  signAccessToken,
} from "../src/index.ts";
import type { CoreAuthHonoEnv } from "../src/types.ts";

const SECRET = "test-secret";

/**
 * Motor de tenancy en memoria: no habla con Postgres real (eso es responsabilidad de
 * `packages/db`, fuera de este paquete) — simula el MISMO contrato (`withAppSession`
 * abre "sesión" con los claims, `query` responde según lo que el test configuró) para
 * poder probar la LÓGICA del middleware (qué hace con lo que la sesión devuelve, qué
 * errores lanza, qué escribe en el contexto) sin levantar una base real.
 */
function fakeEngine(rowsForQuery: readonly unknown[]): TenancyEngine {
  return {
    async withAppSession(_claims, fn) {
      const session: TenantDbSession = {
        query: async () => ({ rows: rowsForQuery as never[] }),
        exec: async () => undefined,
      };
      return fn(session);
    },
  };
}

function buildApp(engine: TenancyEngine, allowedRoles?: readonly ("owner" | "admin" | "member" | "viewer")[]) {
  const app = new Hono<CoreAuthHonoEnv>();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403);
    }
    return c.json({ code: "internal_error", message: "error interno" }, 500);
  });
  app.use(requestId());
  app.use(authMiddleware({ jwtSecret: SECRET }));
  app.use(dbSession(engine));
  app.get("/properties/:propertyId/ping", requirePropertyMembership("propertyId", allowedRoles), (c) => {
    return c.json({
      ok: true,
      organizationId: c.get("organizationId"),
      propertyIds: c.get("propertyIds"),
      platformRole: c.get("platformRole"),
      verticalRole: c.get("verticalRole"),
    });
  });
  app.get("/properties/:propertyId/vertical-only", requirePropertyMembership("propertyId"), (c) => {
    assertVerticalRole(c, ["frontdesk"]);
    return c.json({ ok: true });
  });
  return app;
}

async function validToken(): Promise<string> {
  return signAccessToken(
    { sub: "user-1", org_id: "org-claim-obsoleto", vertical: "hoteles", property_ids: null, email: "a@b.com" },
    SECRET,
    60,
  );
}

/**
 * A diferencia de `fakeEngine` (arriba, sin semántica de commit/rollback — solo sirve
 * para probar el resto del middleware chain), este motor SÍ modela el mismo contrato
 * que `ManagedPostgresEngine.withAppSession` (`packages/db/src/managed-postgres-
 * engine.ts`): éxito → commit, throw → rollback + re-throw. Existe para reproducir el
 * bug real (ver hallazgo raíz #7 de la auditoría final de 20 rubros: "las
 * transacciones no son transaccionales contra Postgres real") sin levantar Postgres —
 * la causa es una interacción de `dbSession` con `Hono#compose` que no depende de qué
 * motor esté detrás, así que un fake que solo trackea las dos banderas es suficiente
 * para probarla end-to-end contra la app Hono real.
 */
function trackingEngine(): TenancyEngine & { committed: boolean; rolledBack: boolean } {
  let committed = false;
  let rolledBack = false;
  return {
    // Getters sobre las variables de closure (nunca un `...spread` de sus valores
    // actuales) — un spread copia el `false` inicial una sola vez; el test leería
    // para siempre esa copia obsoleta en vez de la mutación real de abajo.
    get committed() {
      return committed;
    },
    get rolledBack() {
      return rolledBack;
    },
    async withAppSession(_claims, fn) {
      // Fila de membership válida (mismo shape que usan los tests de
      // `requirePropertyMembership` más abajo) para que las rutas de estos tests
      // lleguen realmente al handler en vez de cortar antes con un 403 propio.
      const session: TenantDbSession = {
        query: async () => ({ rows: [{ organization_id: "org-real", platform_role: "owner", vertical_role: "gm" }] as never[] }),
        exec: async () => undefined,
      };
      try {
        const result = await fn(session);
        committed = true;
        return result;
      } catch (err) {
        rolledBack = true;
        throw err;
      }
    },
  };
}

describe("dbSession", () => {
  // Reproduce el hallazgo raíz #7 de la auditoría final (fable-5.1, 20 rubros): con
  // `app.onError` registrado globalmente (como en `apps/api/src/app.ts`), Hono atrapa
  // el throw del handler de la ruta EN EL NIVEL DE DISPATCH MÁS PROFUNDO donde ocurrió
  // (ver `hono/dist/compose.js`: cada `dispatch(i)` tiene su propio try/catch que
  // llama a `onError` y devuelve su respuesta SIN relanzar) — la excepción nunca llega
  // a propagarse de vuelta hasta el `await next()` de `dbSession`, así que sin el fix
  // (`if (c.error) throw c.error`) `withAppSession` nunca se entera del error y
  // confirma (commit) escrituras parciales de un handler que en realidad falló.
  it("hace ROLLBACK, nunca commit, cuando el handler de la ruta lanza un ApiError bajo onError global", async () => {
    const engine = trackingEngine();
    const app = buildApp(engine);
    app.get("/properties/:propertyId/falla", requirePropertyMembership("propertyId"), () => {
      throw new ApiError(409, "conflict", "escritura simulada que debió revertirse");
    });
    const token = await validToken();
    const res = await app.request("/properties/p1/falla", {
      headers: { authorization: `Bearer ${token}`, "x-property-id": "p1" },
    });
    expect(res.status).toBe(409);
    expect(engine.rolledBack).toBe(true);
    expect(engine.committed).toBe(false);
  });

  it("hace COMMIT cuando el handler de la ruta responde normalmente", async () => {
    const engine = trackingEngine();
    const app = buildApp(engine);
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", {
      headers: { authorization: `Bearer ${token}`, "x-property-id": "p1" },
    });
    expect(res.status).toBe(200);
    expect(engine.committed).toBe(true);
    expect(engine.rolledBack).toBe(false);
  });
});

describe("dbSession — postCommitTasks (arreglo de fondo, auditoría a2)", () => {
  // Fix hallazgo auditoría a2 ("el correo inline nunca sale de verdad desde
  // rutas de staff", parte 3 "arreglo de fondo"): dbSession ahora expone
  // `postCommitTasks` en el contexto y corre cada tarea encolada ahí DESPUÉS
  // de que la transacción de este request confirme (nunca si hubo rollback).

  function buildAppWithPostCommitRoute(engine: TenancyEngine, task: () => Promise<void>) {
    const app = new Hono<CoreAuthHonoEnv>();
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403);
      return c.json({ code: "internal_error", message: "error interno" }, 500);
    });
    app.use(requestId());
    app.use(authMiddleware({ jwtSecret: SECRET }));
    app.use(dbSession(engine));
    app.get("/properties/:propertyId/ping", requirePropertyMembership("propertyId"), async (c) => {
      c.get("postCommitTasks").push(task);
      return c.json({ ok: true });
    });
    app.get("/properties/:propertyId/falla", requirePropertyMembership("propertyId"), () => {
      throw new ApiError(409, "conflict", "escritura simulada que debió revertirse");
    });
    return app;
  }

  it("corre la tarea post-commit SOLO DESPUÉS de que la transacción confirmó", async () => {
    const engine = trackingEngine();
    let ranAfterCommit = false;
    const app = buildAppWithPostCommitRoute(engine, async () => {
      // Si esto corriera ANTES del commit real, `engine.committed` seguiría en
      // `false` en este instante (trackingEngine solo lo pone en `true` cuando
      // `withAppSession` ya resolvió) -- capturamos el valor exacto en el
      // momento en que la tarea corre para probar el orden, no solo el estado
      // final.
      ranAfterCommit = engine.committed;
    });
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}`, "x-property-id": "p1" } });
    expect(res.status).toBe(200);
    expect(ranAfterCommit).toBe(true);
  });

  it("NO corre la tarea post-commit cuando el handler lanza y la transacción hace rollback", async () => {
    const engine = trackingEngine();
    let ran = false;
    const app = new Hono<CoreAuthHonoEnv>();
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403);
      return c.json({ code: "internal_error", message: "error interno" }, 500);
    });
    app.use(requestId());
    app.use(authMiddleware({ jwtSecret: SECRET }));
    app.use(dbSession(engine));
    app.get("/properties/:propertyId/falla", requirePropertyMembership("propertyId"), (c) => {
      c.get("postCommitTasks").push(async () => {
        ran = true;
      });
      throw new ApiError(409, "conflict", "escritura simulada que debió revertirse");
    });
    const token = await validToken();
    const res = await app.request("/properties/p1/falla", { headers: { authorization: `Bearer ${token}`, "x-property-id": "p1" } });
    expect(res.status).toBe(409);
    expect(engine.rolledBack).toBe(true);
    expect(ran).toBe(false);
  });

  it("un fallo de la tarea post-commit NUNCA cambia la respuesta ya armada por el handler", async () => {
    const engine = trackingEngine();
    const app = buildAppWithPostCommitRoute(engine, async () => {
      throw new Error("drenado de correo caído -- best-effort, nunca debe tumbar el request");
    });
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}`, "x-property-id": "p1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(engine.committed).toBe(true);
  });

  it("un handler que nunca empuja nada no rompe -- postCommitTasks arranca vacío", async () => {
    const engine = trackingEngine();
    const app = buildApp(engine);
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}`, "x-property-id": "p1" } });
    expect(res.status).toBe(200);
  });
});

describe("authMiddleware", () => {
  it("401 sin header Authorization", async () => {
    const app = buildApp(fakeEngine([]));
    const res = await app.request("/properties/p1/ping");
    expect(res.status).toBe(401);
  });

  it("401 con un token con secreto incorrecto", async () => {
    const app = buildApp(fakeEngine([]));
    const badToken = await signAccessToken(
      { sub: "user-1", org_id: "org-1", vertical: "hoteles", property_ids: null, email: "a@b.com" },
      "otro-secreto",
      60,
    );
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${badToken}` } });
    expect(res.status).toBe(401);
  });
});

describe("requirePropertyMembership", () => {
  it("403 cuando la query de membership no devuelve filas (usuario ajeno a la property)", async () => {
    const app = buildApp(fakeEngine([]));
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("200 y REESCRIBE organizationId/propertyIds/platformRole con lo resuelto en vivo (nunca el claim del JWT)", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "admin", vertical_role: "gm" }]));
    const token = await validToken(); // claim trae org_id: "org-claim-obsoleto"
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizationId: string;
      propertyIds: string[];
      platformRole: string;
      verticalRole: string;
    };
    expect(body.organizationId).toBe("org-real"); // NO "org-claim-obsoleto"
    expect(body.propertyIds).toEqual(["p1"]);
    expect(body.platformRole).toBe("admin");
    expect(body.verticalRole).toBe("gm");
  });

  it("403 cuando el platformRole resuelto no está en allowedRoles", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "viewer", vertical_role: "frontdesk" }]), [
      "owner",
      "admin",
    ]);
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("403 cuando el header X-Property-Id no coincide con el parámetro de ruta", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "owner", vertical_role: "gm" }]));
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", {
      headers: { authorization: `Bearer ${token}`, "x-property-id": "p2-distinta" },
    });
    expect(res.status).toBe(403);
  });
});

describe("assertVerticalRole", () => {
  it("200 cuando el verticalRole resuelto está en la lista permitida", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "member", vertical_role: "frontdesk" }]));
    const token = await validToken();
    const res = await app.request("/properties/p1/vertical-only", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("403 cuando el verticalRole resuelto NO está en la lista permitida", async () => {
    const app = buildApp(
      fakeEngine([{ organization_id: "org-real", platform_role: "member", vertical_role: "housekeeping" }]),
    );
    const token = await validToken();
    const res = await app.request("/properties/p1/vertical-only", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});
