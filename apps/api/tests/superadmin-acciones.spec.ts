// Back office de plataforma -- "Acciones sugeridas con confirmación +
// automatizaciones". Recorre las rutas contra los repos en memoria: 403
// explícito para un staff normal, y el camino feliz con datos reales
// sembrados en `InMemorySuperadminAccionesRepository`/`InMemoryCoreRepository`
// -- mismo criterio que `superadmin-salud.spec.ts`/`superadmin-resumen.spec.ts`
// (la autorización/máquina de estados REAL vive en las funciones SQL,
// probada aparte en `scripts/verify-superadmin-acciones/`; aquí se verifica
// el comportamiento equivalente en memoria y el contrato HTTP).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository, InMemorySuperadminAccionesRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

async function makeSuperadmin(base: Awaited<ReturnType<typeof buildTestDeps>>, email = "superadmin@example.com"): Promise<{ token: string; superadminId: string }> {
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const accionesRepo = base.deps.accionesRepo as InMemorySuperadminAccionesRepository;
  const superadminId = randomUUID();
  coreRepo.addStaff({ id: superadminId, email, passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addPlatformSuperadmin(superadminId);
  accionesRepo.addPlatformSuperadmin(superadminId);
  const token = await signAccessToken({ sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email }, base.deps.env.jwtSecret, base.deps.env.accessTokenTtlSeconds);
  return { token, superadminId };
}

async function staffToken(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<string> {
  return signAccessToken({ sub: randomUUID(), org_id: base.organizationId, vertical: "restaurantes", property_ids: null, email: base.ownerEmail }, base.deps.env.jwtSecret, base.deps.env.accessTokenTtlSeconds);
}

describe("GET /superadmin/acciones/catalogo", () => {
  it("un staff normal (no superadmin) recibe 403 explícito", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/catalogo", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/catalogo");
    expect(res.status).toBe(401);
  });

  it("un superadmin real ve el catálogo completo (incluidas las acciones no disponibles)", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/catalogo", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catalogo: Array<{ tipo: string; disponible: boolean }> };
    expect(body.catalogo.some((a) => a.tipo === "reencolar_mensaje_muerto" && a.disponible)).toBe(true);
    expect(body.catalogo.some((a) => a.tipo === "ajustar_tope_gasto_llm" && !a.disponible)).toBe(true);
  });
});

describe("GET /superadmin/acciones/sugerencias", () => {
  it("sin datos -> arreglo vacío, nunca un error", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/sugerencias", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sugerencias: unknown[] };
    expect(body.sugerencias).toEqual([]);
  });

  it("un mensaje muerto sembrado aparece como sugerencia con el payload precargado", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const accionesRepo = base.deps.accionesRepo as InMemorySuperadminAccionesRepository;
    accionesRepo.seedOutboxDeadMessage({
      queueName: "hoteles",
      id: "m1",
      organizationId: base.organizationId,
      organizationName: "Los Taquitos de PM",
      channel: "whatsapp",
      eventType: "confirmacion",
      payload: { to: "+525599990000" },
      error: "permanent_failure",
      createdAt: new Date().toISOString(),
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/sugerencias", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { sugerencias: Array<{ tipoAccion: string; payloadSugerido: Record<string, unknown> }> };
    expect(body.sugerencias).toHaveLength(1);
    expect(body.sugerencias[0]).toMatchObject({ tipoAccion: "reencolar_mensaje_muerto", payloadSugerido: { queue: "hoteles", mensajeId: "m1" } });
  });
});

describe("POST /superadmin/acciones/intents -- reencolar_mensaje_muerto", () => {
  it("crea el intent con el resumen legible (canal, organización, destinatario enmascarado, error) SIN reencolar nada todavía", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const accionesRepo = base.deps.accionesRepo as InMemorySuperadminAccionesRepository;
    accionesRepo.seedOutboxDeadMessage({
      queueName: "hoteles",
      id: "m1",
      organizationId: base.organizationId,
      organizationName: "Los Taquitos de PM",
      channel: "whatsapp",
      eventType: "confirmacion",
      payload: { to: "+525599990000" },
      error: "permanent_failure",
      createdAt: new Date().toISOString(),
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "reencolar_mensaje_muerto", payload: { queue: "hoteles", mensajeId: "m1" } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { intent: { id: string; estado: string; resumen: string; venceEn: string } };
    expect(body.intent.estado).toBe("pending");
    expect(body.intent.resumen).toContain("envío real por whatsapp");
    expect(body.intent.resumen).toContain("permanent_failure");
    expect(body.intent.resumen).not.toContain("+525599990000");

    // Todavía NO se reencoló -- sigue en la lista de muertos.
    const resMuertos = await app.request("/superadmin/acciones/mensajes-muertos", { headers: { authorization: `Bearer ${token}` } });
    const bodyMuertos = (await resMuertos.json()) as { mensajes: unknown[] };
    expect(bodyMuertos.mensajes).toHaveLength(1);
  });

  it("un tipo fuera del catálogo -- 400", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "ajustar_tope_gasto_llm", payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("un mensajeId que no existe/no está dead -- 404, nunca crea el intent", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "reencolar_mensaje_muerto", payload: { queue: "hoteles", mensajeId: "no-existe" } }),
    });
    expect(res.status).toBe(404);
  });

  it("confirmar -- SÍ reencola (el mensaje sale de la lista de muertos, estado queda executed)", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const accionesRepo = base.deps.accionesRepo as InMemorySuperadminAccionesRepository;
    accionesRepo.seedOutboxDeadMessage({
      queueName: "hoteles",
      id: "m1",
      organizationId: base.organizationId,
      organizationName: "Los Taquitos de PM",
      channel: "whatsapp",
      eventType: "confirmacion",
      payload: { to: "+525599990000" },
      error: "permanent_failure",
      createdAt: new Date().toISOString(),
    });
    const app = buildApp(base.deps);

    const resCrear = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "reencolar_mensaje_muerto", payload: { queue: "hoteles", mensajeId: "m1" } }),
    });
    const { intent } = (await resCrear.json()) as { intent: { id: string } };

    const resConfirmar = await app.request(`/superadmin/acciones/intents/${intent.id}/confirmar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(resConfirmar.status).toBe(200);
    const bodyConfirmar = (await resConfirmar.json()) as { intent: { estado: string; resultado: unknown } };
    expect(bodyConfirmar.intent.estado).toBe("executed");
    expect(bodyConfirmar.intent.resultado).toMatchObject({ reencolado: true, queue: "hoteles", mensajeId: "m1" });

    const resMuertos = await app.request("/superadmin/acciones/mensajes-muertos", { headers: { authorization: `Bearer ${token}` } });
    const bodyMuertos = (await resMuertos.json()) as { mensajes: unknown[] };
    expect(bodyMuertos.mensajes).toHaveLength(0);
  });
});

describe("POST /superadmin/acciones/intents -- cerrar_prospecto", () => {
  it("crea + confirma de punta a punta -- el prospecto SÍ queda perdido (reutiliza core.update_prospecto_for_superadmin)", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const prospecto = await coreRepo.createProspectoForSuperadmin(superadminId, { empresa: "Acme", vertical: "hoteles", ciudad: null, contactoNombre: null, telefono: null, correo: null, fuente: null, notas: null });

    const app = buildApp(base.deps);
    const resCrear = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "cerrar_prospecto", payload: { prospectoId: prospecto.id, estado: "perdido" } }),
    });
    expect(resCrear.status).toBe(201);
    const bodyCrear = (await resCrear.json()) as { intent: { id: string; resumen: string } };
    expect(bodyCrear.intent.resumen).toContain("Acme");
    expect(bodyCrear.intent.resumen).toContain('"perdido"');

    const resConfirmar = await app.request(`/superadmin/acciones/intents/${bodyCrear.intent.id}/confirmar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(resConfirmar.status).toBe(200);
    const bodyConfirmar = (await resConfirmar.json()) as { intent: { estado: string } };
    expect(bodyConfirmar.intent.estado).toBe("executed");

    const prospectos = await coreRepo.listProspectosForSuperadmin(superadminId);
    expect(prospectos.find((p) => p.id === prospecto.id)?.estado).toBe("perdido");
  });

  it("un estado destino inválido -- 400, nunca crea el intent", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const prospecto = await coreRepo.createProspectoForSuperadmin(superadminId, { empresa: "Acme", vertical: "hoteles", ciudad: null, contactoNombre: null, telefono: null, correo: null, fuente: null, notas: null });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "cerrar_prospecto", payload: { prospectoId: prospecto.id, estado: "ganado" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /superadmin/acciones/intents/:id/confirmar -- máquina de estados", () => {
  it("otro superadmin NO puede confirmar el intent ajeno -- 404 (nunca 200, nunca ejecuta)", async () => {
    const base = await buildTestDeps();
    const { token: tokenA, superadminId: idA } = await makeSuperadmin(base, "superadmin-a@example.com");
    const { token: tokenB } = await makeSuperadmin(base, "superadmin-b@example.com");
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const prospecto = await coreRepo.createProspectoForSuperadmin(idA, { empresa: "Acme", vertical: "hoteles", ciudad: null, contactoNombre: null, telefono: null, correo: null, fuente: null, notas: null });

    const app = buildApp(base.deps);
    const resCrear = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "cerrar_prospecto", payload: { prospectoId: prospecto.id, estado: "perdido" } }),
    });
    const { intent } = (await resCrear.json()) as { intent: { id: string } };

    const resConfirmar = await app.request(`/superadmin/acciones/intents/${intent.id}/confirmar`, { method: "POST", headers: { authorization: `Bearer ${tokenB}` } });
    expect(resConfirmar.status).toBe(404);

    const prospectos = await coreRepo.listProspectosForSuperadmin(idA);
    expect(prospectos.find((p) => p.id === prospecto.id)?.estado).toBe("nuevo");
  });

  it("cancelar un intent pending -- confirmarlo después ya no hace nada (404, el creador ya no lo encuentra pending)", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const prospecto = await coreRepo.createProspectoForSuperadmin(superadminId, { empresa: "Acme", vertical: "hoteles", ciudad: null, contactoNombre: null, telefono: null, correo: null, fuente: null, notas: null });

    const app = buildApp(base.deps);
    const resCrear = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "cerrar_prospecto", payload: { prospectoId: prospecto.id, estado: "perdido" } }),
    });
    const { intent } = (await resCrear.json()) as { intent: { id: string } };

    const resCancelar = await app.request(`/superadmin/acciones/intents/${intent.id}/cancelar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(resCancelar.status).toBe(200);
    const bodyCancelar = (await resCancelar.json()) as { intent: { estado: string } };
    expect(bodyCancelar.intent.estado).toBe("cancelled");

    const resConfirmar = await app.request(`/superadmin/acciones/intents/${intent.id}/confirmar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(resConfirmar.status).toBe(409);

    const prospectos = await coreRepo.listProspectosForSuperadmin(superadminId);
    expect(prospectos.find((p) => p.id === prospecto.id)?.estado).toBe("nuevo");
  });

  it("una segunda confirmación del MISMO intent ya ejecutado no ejecuta dos veces", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const prospecto = await coreRepo.createProspectoForSuperadmin(superadminId, { empresa: "Acme", vertical: "hoteles", ciudad: null, contactoNombre: null, telefono: null, correo: null, fuente: null, notas: null });

    const app = buildApp(base.deps);
    const resCrear = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "cerrar_prospecto", payload: { prospectoId: prospecto.id, estado: "perdido" } }),
    });
    const { intent } = (await resCrear.json()) as { intent: { id: string } };

    const res1 = await app.request(`/superadmin/acciones/intents/${intent.id}/confirmar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(res1.status).toBe(200);
    const res2 = await app.request(`/superadmin/acciones/intents/${intent.id}/confirmar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { intent: { estado: string } };
    expect(body2.intent.estado).toBe("executed");
  });
});

describe("POST /superadmin/acciones/intents -- ejecutar_mantenimiento_ahora", () => {
  it("crea + confirma -- estado queda executed, con resultado de las dos automatizaciones", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);

    const resCrear = await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "ejecutar_mantenimiento_ahora", payload: {} }),
    });
    expect(resCrear.status).toBe(201);
    const { intent } = (await resCrear.json()) as { intent: { id: string; resumen: string } };
    expect(intent.resumen).toContain("No envía nada");

    const resConfirmar = await app.request(`/superadmin/acciones/intents/${intent.id}/confirmar`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(resConfirmar.status).toBe(200);
    const bodyConfirmar = (await resConfirmar.json()) as { intent: { estado: string; resultado: { outbox: unknown[]; prospectos: unknown[] } } };
    expect(bodyConfirmar.intent.estado).toBe("executed");
    expect(bodyConfirmar.intent.resultado.outbox.length).toBeGreaterThan(0);
  });
});

describe("bitácoras", () => {
  it("GET /superadmin/acciones/intents lista los intents del equipo (visible a CUALQUIER superadmin, no solo al creador)", async () => {
    const base = await buildTestDeps();
    const { token: tokenA, superadminId: idA } = await makeSuperadmin(base, "superadmin-a@example.com");
    const { token: tokenB } = await makeSuperadmin(base, "superadmin-b@example.com");
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const prospecto = await coreRepo.createProspectoForSuperadmin(idA, { empresa: "Acme", vertical: "hoteles", ciudad: null, contactoNombre: null, telefono: null, correo: null, fuente: null, notas: null });

    const app = buildApp(base.deps);
    await app.request("/superadmin/acciones/intents", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "cerrar_prospecto", payload: { prospectoId: prospecto.id, estado: "perdido" } }),
    });

    const res = await app.request("/superadmin/acciones/intents", { headers: { authorization: `Bearer ${tokenB}` } });
    const body = (await res.json()) as { intents: unknown[] };
    expect(body.intents).toHaveLength(1);
  });

  it("GET /superadmin/acciones/automatizaciones -- staff normal recibe 403", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/acciones/automatizaciones", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });
});
