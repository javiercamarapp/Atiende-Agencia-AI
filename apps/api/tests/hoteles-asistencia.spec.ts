// Fase 8 hoteles (REQ-BO-024, P0/GOB, LFT art.132 fr.XXXIV) — checador de asistencia
// inalterable + cruce contra el horario programado, exportable a la STPS.
// Integración HTTP real (fixtures en memoria, mismo patrón que
// hoteles-housekeeping.spec.ts/hoteles-night-audit.spec.ts) cubriendo las
// propiedades adversariales de REQ-BO-024:
//  (a) sin ruta HTTP de edición/borrado -- append-only real a nivel de aplicación. La
//      inmutabilidad de bajo nivel (cadena de hash por empleado + triggers BEFORE
//      UPDATE/DELETE que bloquean incluso al cliente admin/service_role) vive en
//      packages/domain-hoteles/migrations/010_checador_asistencia.sql; no se ejercita
//      aquí porque esta suite corre contra repos en memoria, no Postgres real -- mismo
//      criterio que el resto de domain-hoteles en esta fase de atiende-fusion (ver
//      packages/domain-hoteles/tests/attendance.spec.ts para el cruce puro).
//  (b) autoservicio: nadie ficha a nombre de otro empleado, ni inyectando un
//      staffUserId ajeno en el body.
//  (c) aislamiento: property ajena, y un rol sin administración no puede consultar el
//      historial de OTRO empleado, ni programar horarios, ni exportar el CSV.
//  (d) cruce y alerta: horas extra SIN autorización se marcan; dentro del margen
//      autorizado, no.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword, InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface EventBody {
  id: string;
  staffUserId: string;
  eventType: string;
  recordedAt: string;
}

function seedEvento(ctx_: HotelesTestContext, staffUserId: string, eventType: "entrada" | "salida", recordedAt: string): void {
  ctx_.hotelesRepo.seedAttendanceEvent({
    id: randomUUID(),
    organizationId: ctx_.organizationId,
    propertyId: ctx_.propertyId,
    staffUserId,
    eventType,
    recordedAt,
    source: "app",
    note: null,
    createdAt: recordedAt,
  });
}

describe("POST /hoteles/:propertyId/asistencia/checar", () => {
  it("cualquier staff registra su propio fichaje", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/asistencia/checar`, authedJson(ctx.staff.housekeeping.token, { eventType: "entrada" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as EventBody;
    expect(body.staffUserId).toBe(ctx.staff.housekeeping.id);
    expect(body.eventType).toBe("entrada");
  });

  it("(b) autoservicio: un staffUserId ajeno inyectado en el body se ignora -- la fila queda a nombre de quien inició sesión", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/checar`,
      authedJson(ctx.staff.housekeeping.token, { eventType: "entrada", staffUserId: ctx.staff.gm.id }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as EventBody;
    expect(body.staffUserId).toBe(ctx.staff.housekeeping.id);
    expect(body.staffUserId).not.toBe(ctx.staff.gm.id);
  });

  it("rechaza un eventType inválido", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/asistencia/checar`, authedJson(ctx.staff.frontdesk.token, { eventType: "almuerzo" }));
    expect(res.status).toBe(400);
  });

  it("(c) aislamiento: un empleado no puede fichar en una property a la que no pertenece", async () => {
    const app = buildApp(ctx.deps);
    const propiedadAjena = randomUUID();
    const res = await app.request(`/hoteles/${propiedadAjena}/asistencia/checar`, authedJson(ctx.staff.frontdesk.token, { eventType: "entrada" }));
    expect(res.status).toBe(403);
  });
});

describe("(a) inmutabilidad: no existe ninguna ruta HTTP de edición/borrado", () => {
  it("PATCH/PUT/DELETE sobre un registro de asistencia siempre son 404", async () => {
    const app = buildApp(ctx.deps);
    const creado = await app.request(`/hoteles/${ctx.propertyId}/asistencia/checar`, authedJson(ctx.staff.frontdesk.token, { eventType: "entrada" }));
    const { id } = (await creado.json()) as EventBody;

    for (const method of ["PATCH", "PUT", "DELETE"]) {
      const res = await app.request(`/hoteles/${ctx.propertyId}/asistencia/${id}`, {
        method,
        headers: { authorization: `Bearer ${ctx.staff.frontdesk.token}` },
      });
      expect(res.status).toBe(404);
    }
  });
});

describe("GET /hoteles/:propertyId/asistencia (historial): propio o administración", () => {
  it("un rol sin administración SÍ puede consultar su propio historial", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/asistencia/checar`, authedJson(ctx.staff.housekeeping.token, { eventType: "entrada" }));

    const res = await app.request(`/hoteles/${ctx.propertyId}/asistencia`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as EventBody[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.staffUserId === ctx.staff.housekeeping.id)).toBe(true);
  });

  it("(c) un rol sin administración NO puede consultar el historial de OTRO empleado (403 explícito, no una lista vacía)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/asistencia?staffUserId=${ctx.staff.frontdesk.id}`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(403);
  });

  it("owner/gm SÍ pueden consultar el historial de cualquier empleado de su property", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/asistencia/checar`, authedJson(ctx.staff.frontdesk.token, { eventType: "entrada" }));
    const res = await app.request(`/hoteles/${ctx.propertyId}/asistencia?staffUserId=${ctx.staff.frontdesk.id}`, authedJson(ctx.staff.gm.token));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as EventBody[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("POST /hoteles/:propertyId/asistencia/horarios: solo administración", () => {
  it("(c) housekeeping NO puede programar horarios -- fuera de ATTENDANCE_ADMIN_ROLES", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/horarios`,
      authedJson(ctx.staff.housekeeping.token, {
        staffUserId: ctx.staff.frontdesk.id,
        workDate: "2026-10-05",
        scheduledStart: "2026-10-05T14:00:00Z",
        scheduledEnd: "2026-10-05T22:00:00Z",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("gm programa un horario con horas extra pre-autorizadas", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/horarios`,
      authedJson(ctx.staff.gm.token, {
        staffUserId: ctx.staff.frontdesk.id,
        workDate: "2026-10-05",
        scheduledStart: "2026-10-05T14:00:00Z",
        scheduledEnd: "2026-10-05T22:00:00Z",
        authorizedOvertimeMinutes: 30,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { authorizedOvertimeMinutes: number };
    expect(body.authorizedOvertimeMinutes).toBe(30);
  });

  it("rechaza un rango con scheduledEnd <= scheduledStart", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/horarios`,
      authedJson(ctx.staff.gm.token, {
        staffUserId: ctx.staff.frontdesk.id,
        workDate: "2026-10-05",
        scheduledStart: "2026-10-05T22:00:00Z",
        scheduledEnd: "2026-10-05T14:00:00Z",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /hoteles/:propertyId/asistencia/cruce y /exportar-stps (REQ-BO-024): solo administración", () => {
  it("(c) housekeeping NO puede consultar el cruce ni exportar el CSV para la STPS", async () => {
    const app = buildApp(ctx.deps);
    const cruce = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/cruce?staffUserId=${ctx.staff.frontdesk.id}&desde=2026-10-05&hasta=2026-10-05`,
      authedJson(ctx.staff.housekeeping.token),
    );
    expect(cruce.status).toBe(403);

    const csv = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/exportar-stps?staffUserId=${ctx.staff.frontdesk.id}&desde=2026-10-05&hasta=2026-10-05`,
      authedJson(ctx.staff.housekeeping.token),
    );
    expect(csv.status).toBe(403);
  });

  // Hallazgo de seguridad (revisión real de PR #149, Fase 3 caller-binding):
  // `staffUserId` llega por query param sin verificar que pertenezca a la
  // organización del admin autenticado -- un admin de la organización A podía
  // exportar (nombre/correo incluidos) el CSV de asistencia de un empleado de la
  // organización B. `assertStaffBelongsToOrg` (asistencia.ts) lo cierra.
  it("(c) un owner de esta organización pidiendo el cruce/CSV de un empleado de OTRA organización -> 404, sin filtrar su nombre ni correo", async () => {
    const app = buildApp(ctx.deps);
    const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;

    const otraOrgId = randomUUID();
    const outsiderId = randomUUID();
    const outsiderEmail = "outsider@otro-hotel.mx";
    coreRepo.addOrganization({ id: otraOrgId, slug: "otro-hotel", name: "Otro Hotel", vertical: "hoteles" });
    coreRepo.addStaff({
      id: outsiderId,
      email: outsiderEmail,
      fullName: "Empleado De Otro Hotel",
      passwordHash: await hashPassword("correcto-caballo-batería"),
      createdVia: "seed",
      emailVerifiedAt: new Date().toISOString(),
    });
    coreRepo.addMembership({ userId: outsiderId, organizationId: otraOrgId, platformRole: "member", verticalRole: "frontdesk", propertyIds: null });

    const cruce = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/cruce?staffUserId=${outsiderId}&desde=2026-10-05&hasta=2026-10-05`,
      authedJson(ctx.staff.owner.token),
    );
    expect(cruce.status).toBe(404);
    const cruceBody = await cruce.text();
    expect(cruceBody).not.toContain(outsiderEmail);
    expect(cruceBody).not.toContain("Empleado De Otro Hotel");

    const csv = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/exportar-stps?staffUserId=${outsiderId}&desde=2026-10-05&hasta=2026-10-05`,
      authedJson(ctx.staff.owner.token),
    );
    expect(csv.status).toBe(404);
    const csvBody = await csv.text();
    expect(csvBody).not.toContain(outsiderEmail);
    expect(csvBody).not.toContain("Empleado De Otro Hotel");
  });

  it("(d) horas extra dentro del margen autorizado no alertan; el excedente real sí, y solo por el excedente", async () => {
    const app = buildApp(ctx.deps);
    const workDate = "2026-10-06";

    const horarioRes = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/horarios`,
      authedJson(ctx.staff.gm.token, {
        staffUserId: ctx.staff.frontdesk.id,
        workDate,
        scheduledStart: `${workDate}T14:00:00Z`,
        scheduledEnd: `${workDate}T22:00:00Z`,
        authorizedOvertimeMinutes: 30,
      }),
    );
    expect(horarioRes.status).toBe(201);

    // El checador real registra timestamps del servidor (`now()`) -- se insertan los
    // DOS eventos directamente vía el repo en memoria como setup de fixture (mismo
    // criterio que el original: lo que se ejercita end-to-end por HTTP es la ruta de
    // LECTURA -- /cruce, /exportar-stps --, no la de escritura, ya cubierta arriba).
    seedEvento(ctx, ctx.staff.frontdesk.id, "entrada", `${workDate}T14:00:00.000Z`);
    seedEvento(ctx, ctx.staff.frontdesk.id, "salida", `${workDate}T23:30:00.000Z`); // +90 min sobre lo programado

    const cruceRes = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/cruce?staffUserId=${ctx.staff.frontdesk.id}&desde=${workDate}&hasta=${workDate}`,
      authedJson(ctx.staff.gm.token),
    );
    expect(cruceRes.status).toBe(200);
    const [entry] = (await cruceRes.json()) as {
      estado: string;
      horasProgramadas: number;
      horasTrabajadas: number;
      horasExtraAutorizadas: number;
      horasExtraNoAutorizadas: number;
      alerta: boolean;
    }[];
    expect(entry).toBeDefined();
    expect(entry!.estado).toBe("completo");
    expect(entry!.horasProgramadas).toBe(8);
    expect(entry!.horasTrabajadas).toBe(9.5);
    expect(entry!.horasExtraAutorizadas).toBe(0.5);
    // 90 min de excedente - 30 min autorizados = 60 min = 1h no autorizada.
    expect(entry!.horasExtraNoAutorizadas).toBe(1);
    expect(entry!.alerta).toBe(true);

    // El mismo cruce, en el CSV para la STPS: la fila existe y trae el mismo
    // excedente no autorizado.
    const csvRes = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/exportar-stps?staffUserId=${ctx.staff.frontdesk.id}&desde=${workDate}&hasta=${workDate}`,
      authedJson(ctx.staff.gm.token),
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csv = await csvRes.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("horas_extra_no_autorizadas");
    expect(lines[1]).toContain("HTP850101AB1"); // rfcEmisor sembrado en el fixture (seedHospedajeFiscalConfig)
    expect(lines[1]).toContain("1.00,completo");
  });

  it("(d) trabajar un día SIN ningún horario programado marca el 100% de lo trabajado como no autorizado", async () => {
    const app = buildApp(ctx.deps);
    const workDate = "2026-10-07";

    seedEvento(ctx, ctx.staff.accountant.id, "entrada", `${workDate}T09:00:00.000Z`);
    seedEvento(ctx, ctx.staff.accountant.id, "salida", `${workDate}T13:00:00.000Z`);

    const res = await app.request(
      `/hoteles/${ctx.propertyId}/asistencia/cruce?staffUserId=${ctx.staff.accountant.id}&desde=${workDate}&hasta=${workDate}`,
      authedJson(ctx.staff.gm.token),
    );
    const [entry] = (await res.json()) as { estado: string; horasExtraNoAutorizadas: number; alerta: boolean }[];
    expect(entry!.estado).toBe("sin_horario");
    expect(entry!.horasExtraNoAutorizadas).toBe(4);
    expect(entry!.alerta).toBe(true);
  });
});
