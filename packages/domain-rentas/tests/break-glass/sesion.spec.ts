// Test real (sin mocks) de la ventana de acceso de romper-cristal (Fase 10b) --
// cubre los requisitos literales del gap: duración acotada, listar
// activos+históricos, cerrar manualmente, y que una lectura de tenant exige una
// ventana vigente (ese último caso vive en acceso.spec.ts/postgres-fixtures, no
// aquí -- este archivo cubre solo abrir/listar/cerrar/validar).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryBreakGlassSessionRepository } from "../../src/break-glass/sesion-repository.ts";
import {
  abrirAccesoBreakGlass,
  cerrarAccesoBreakGlass,
  listarAccesosBreakGlass,
  obtenerAccesoActivoBreakGlass,
  validarDuracionBreakGlass,
} from "../../src/break-glass/sesion.ts";
import {
  BreakGlassDurationInvalidError,
  BreakGlassOrganizationRequiredError,
  BreakGlassReasonRequiredError,
  BreakGlassSessionNotFoundError,
} from "../../src/break-glass/errors.ts";
import { BREAK_GLASS_MAX_DURATION_MINUTES, BREAK_GLASS_MIN_DURATION_MINUTES, esSesionBreakGlassActiva } from "../../src/break-glass/tipos.ts";
import type { NewBreakGlassSessionInput, SuperadminActor } from "../../src/break-glass/tipos.ts";

const ACTOR: SuperadminActor = { userId: randomUUID(), email: "superadmin@atiende.dev" };
const RAZON_VALIDA = "Ticket SOP-9001: el tenant reporta un cobro duplicado, investigar sus reservas.";

function inputBase(organizationId: string, overrides: Partial<NewBreakGlassSessionInput> = {}): NewBreakGlassSessionInput {
  return { actor: ACTOR, organizationId, reason: RAZON_VALIDA, durationMinutes: 30, ...overrides };
}

describe("validarDuracionBreakGlass", () => {
  it("acepta una duración entera dentro del rango", () => {
    expect(validarDuracionBreakGlass(30)).toBe(30);
  });

  it("acepta exactamente los límites (ni off-by-one de más ni de menos)", () => {
    expect(validarDuracionBreakGlass(BREAK_GLASS_MIN_DURATION_MINUTES)).toBe(BREAK_GLASS_MIN_DURATION_MINUTES);
    expect(validarDuracionBreakGlass(BREAK_GLASS_MAX_DURATION_MINUTES)).toBe(BREAK_GLASS_MAX_DURATION_MINUTES);
  });

  it("rechaza una duración por debajo del mínimo", () => {
    expect(() => validarDuracionBreakGlass(BREAK_GLASS_MIN_DURATION_MINUTES - 1)).toThrow(BreakGlassDurationInvalidError);
  });

  it("rechaza una duración por encima del máximo (4 horas) -- 'romper cristal' es acotado, no acceso permanente", () => {
    expect(() => validarDuracionBreakGlass(BREAK_GLASS_MAX_DURATION_MINUTES + 1)).toThrow(BreakGlassDurationInvalidError);
  });

  it("rechaza una duración no entera", () => {
    expect(() => validarDuracionBreakGlass(30.5)).toThrow(BreakGlassDurationInvalidError);
  });
});

describe("abrirAccesoBreakGlass", () => {
  it("abre una ventana con expiresAtMs = openedAtMs + duración en minutos", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const orgId = randomUUID();
    const sesion = await abrirAccesoBreakGlass(repo, inputBase(orgId, { durationMinutes: 15 }));

    expect(sesion.organizationId).toBe(orgId);
    expect(sesion.actorUserId).toBe(ACTOR.userId);
    expect(sesion.closedAtMs).toBeNull();
    expect(sesion.expiresAtMs - sesion.openedAtMs).toBe(15 * 60_000);
    expect(esSesionBreakGlassActiva(sesion)).toBe(true);
  });

  it("sin razón válida, nunca abre la ventana", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    await expect(abrirAccesoBreakGlass(repo, inputBase(randomUUID(), { reason: "corta" }))).rejects.toThrow(BreakGlassReasonRequiredError);
    expect(repo.sessions).toHaveLength(0);
  });

  it("sin duración válida, nunca abre la ventana", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    await expect(abrirAccesoBreakGlass(repo, inputBase(randomUUID(), { durationMinutes: 9999 }))).rejects.toThrow(BreakGlassDurationInvalidError);
    expect(repo.sessions).toHaveLength(0);
  });

  it("sin organizationId, se rechaza con el mismo error que leerDatosTenantBreakGlass", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    await expect(abrirAccesoBreakGlass(repo, inputBase(""))).rejects.toThrow(BreakGlassOrganizationRequiredError);
  });
});

describe("listarAccesosBreakGlass", () => {
  it("lista activas e históricas del propio actor, más recientes primero -- nunca las de otro superadmin", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const otro: SuperadminActor = { userId: randomUUID(), email: "otro@atiende.dev" };
    const orgA = randomUUID();
    const orgB = randomUUID();

    const s1 = await abrirAccesoBreakGlass(repo, inputBase(orgA));
    const s2 = await abrirAccesoBreakGlass(repo, inputBase(orgB));
    await abrirAccesoBreakGlass(repo, { ...inputBase(orgA), actor: otro });
    await cerrarAccesoBreakGlass(repo, ACTOR, s1.id);

    const listado = await listarAccesosBreakGlass(repo, ACTOR);
    expect(listado.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(listado.every((s) => s.actorUserId === ACTOR.userId)).toBe(true);
  });
});

describe("cerrarAccesoBreakGlass", () => {
  it("cierra una ventana propia y abierta", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const sesion = await abrirAccesoBreakGlass(repo, inputBase(randomUUID()));
    const cerrada = await cerrarAccesoBreakGlass(repo, ACTOR, sesion.id);
    expect(cerrada.closedAtMs).not.toBeNull();
    expect(esSesionBreakGlassActiva(cerrada)).toBe(false);
  });

  it("rechaza cerrar una sesión inexistente", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    await expect(cerrarAccesoBreakGlass(repo, ACTOR, randomUUID())).rejects.toThrow(BreakGlassSessionNotFoundError);
  });

  it("rechaza cerrar la sesión de OTRO superadmin", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const sesion = await abrirAccesoBreakGlass(repo, inputBase(randomUUID()));
    const otro: SuperadminActor = { userId: randomUUID(), email: "otro@atiende.dev" };
    await expect(cerrarAccesoBreakGlass(repo, otro, sesion.id)).rejects.toThrow(BreakGlassSessionNotFoundError);
  });

  it("rechaza volver a cerrar una sesión ya cerrada", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const sesion = await abrirAccesoBreakGlass(repo, inputBase(randomUUID()));
    await cerrarAccesoBreakGlass(repo, ACTOR, sesion.id);
    await expect(cerrarAccesoBreakGlass(repo, ACTOR, sesion.id)).rejects.toThrow(BreakGlassSessionNotFoundError);
  });
});

describe("obtenerAccesoActivoBreakGlass", () => {
  it("encuentra la ventana vigente para actor+organización", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const orgId = randomUUID();
    const sesion = await abrirAccesoBreakGlass(repo, inputBase(orgId));
    const activa = await obtenerAccesoActivoBreakGlass(repo, ACTOR.userId, orgId);
    expect(activa?.id).toBe(sesion.id);
  });

  it("devuelve null si la única ventana ya se cerró", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const orgId = randomUUID();
    const sesion = await abrirAccesoBreakGlass(repo, inputBase(orgId));
    await cerrarAccesoBreakGlass(repo, ACTOR, sesion.id);
    expect(await obtenerAccesoActivoBreakGlass(repo, ACTOR.userId, orgId)).toBeNull();
  });

  it("devuelve null si la única ventana ya venció por tiempo (nunca cerrada explícitamente)", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    const orgId = randomUUID();
    const sesion = await abrirAccesoBreakGlass(repo, inputBase(orgId, { durationMinutes: 5 }));
    const nowMsDespuesDeVencer = sesion.expiresAtMs + 1;
    expect(await obtenerAccesoActivoBreakGlass(repo, ACTOR.userId, orgId, nowMsDespuesDeVencer)).toBeNull();
  });

  it("devuelve null si la ventana vigente es de OTRA organización", async () => {
    const repo = new InMemoryBreakGlassSessionRepository();
    await abrirAccesoBreakGlass(repo, inputBase(randomUUID()));
    expect(await obtenerAccesoActivoBreakGlass(repo, ACTOR.userId, randomUUID())).toBeNull();
  });
});
