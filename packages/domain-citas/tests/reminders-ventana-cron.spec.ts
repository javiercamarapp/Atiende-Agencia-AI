// C-14 -- regresion del recordatorio de 24 h con reloj simulado: la ventana ya no es una franja de 1 h alrededor de las
// 24 h, asi que da igual si el cron corre una vez al dia (vercel.json de hoy) o cada 30 min (PR de crons): ninguna cita
// se queda sin aviso y ninguna recibe dos. El "reloj" es el argumento `now` de `runConfirmacionCitaCore` (el unico
// caller real lo llama con `new Date()`), nunca el reloj del host.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cancelAppointment, createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import type { ReminderCandidateRow } from "../src/repository.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { MENSAJES_CONFIG_POR_OMISION, horaLocal } from "../src/whatsapp/message-config.ts";
import { buildCitasFixture } from "./fixtures.ts";

const MIN = 60_000;
const HORA = 60 * MIN;

interface Negocio {
  readonly fixture: ReturnType<typeof buildCitasFixture>;
  readonly citas: { readonly id: string; readonly startsAt: Date; readonly timeZone: string }[];
}

/** Un negocio con un proveedor por zona y una cita por (zona, hora local) el martes 2026-09-15 (con reglas de 06 a 22 h
 * para poder agendar de madrugada y de noche). */
async function negocioConCitas(zonas: readonly { zona: string; horas: readonly string[] }[], repo?: InMemoryCitasRepository): Promise<Negocio> {
  const fixture = buildCitasFixture(repo);
  const citas: { id: string; startsAt: Date; timeZone: string }[] = [];
  let n = 0;
  for (const { zona, horas } of zonas) {
    const propertyId = randomUUID();
    const providerId = randomUUID();
    fixture.repo.seedPropertyTimezone(propertyId, zona);
    fixture.repo.seedProvider({ id: providerId, organizationId: fixture.organizationId, propertyId, displayName: `Profesional ${zona}`, roleLabel: "Dentista", isActive: true });
    fixture.repo.seedProviderService(providerId, fixture.serviceId);
    for (const dayOfWeek of [1, 2, 3, 4, 5]) fixture.repo.seedAvailabilityRule({ id: randomUUID(), providerId, dayOfWeek, startTime: "06:00", endTime: "22:00", isActive: true });
    for (const hora of horas) {
      const startsAt = zonedTimeToUtc("2026-09-15", hora, zona);
      const apt = await createAppointment(fixture.repo, {
        organizationId: fixture.organizationId,
        providerId,
        serviceId: fixture.serviceId,
        customerName: `Cliente ${n}`,
        customerPhone: `99988877${String(n).padStart(2, "0")}`,
        startsAt: startsAt.toISOString(),
        source: "web",
      });
      citas.push({ id: apt.id, startsAt, timeZone: zona });
      n += 1;
    }
  }
  return { fixture, citas };
}

/** Corre el cron en cada instante de `ticks` y devuelve, por cita, los instantes en que se encolo un recordatorio. */
async function simular(negocio: Negocio, ticks: readonly Date[]): Promise<Map<string, Date[]>> {
  const porCita = new Map<string, Date[]>(negocio.citas.map((c) => [c.id, []]));
  const vistos = new Set<string>();
  for (const now of ticks) {
    await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, now);
    for (const o of negocio.fixture.repo.getOutbox()) {
      if (o.channel !== "whatsapp" || vistos.has(o.id)) continue;
      vistos.add(o.id);
      const appointmentId = (o.dedupeKey as string).replace("reminder-24h:", "").split(":")[0]!;
      porCita.get(appointmentId)?.push(now);
    }
  }
  return porCita;
}

function ticksCada(desde: string, hasta: string, pasoMs: number): Date[] {
  const out: Date[] = [];
  for (let t = Date.parse(desde); t <= Date.parse(hasta); t += pasoMs) out.push(new Date(t));
  return out;
}

const ZONAS = [
  { zona: "America/Mexico_City", horas: ["06:00", "07:30", "10:00", "13:30", "16:00", "19:30", "21:30"] },
  { zona: "America/Tijuana", horas: ["06:30", "10:00", "17:00", "21:00"] },
  { zona: "America/Cancun", horas: ["07:00", "11:30", "20:30"] },
];

describe("recordatorio de 24 h: la cadencia del cron no deja citas sin aviso (C-14)", () => {
  it("cron DIARIO a las 14:00 UTC (el de hoy): cada cita de 'manana' recibe exactamente un aviso, a cualquier hora del dia y en cualquier zona", async () => {
    const negocio = await negocioConCitas(ZONAS);
    // Dos corridas diarias: el lunes 14 y el martes 15 a las 14:00 UTC. Las citas del martes (de 06:00 a 21:30 locales,
    // es decir entre 11:00 UTC del martes y 04:30 UTC del miercoles) caen todas a menos de 24 h de alguna de las dos.
    const ticks = [new Date("2026-09-14T14:00:00.000Z"), new Date("2026-09-15T14:00:00.000Z")];
    const porCita = await simular(negocio, ticks);

    for (const cita of negocio.citas) {
      const envios = porCita.get(cita.id)!;
      expect(envios, `cita ${cita.startsAt.toISOString()} (${cita.timeZone})`).toHaveLength(1);
      // Nunca despues de que empiece ni con mas de 24 h de anticipacion.
      expect(envios[0]!.getTime()).toBeLessThan(cita.startsAt.getTime());
      expect(cita.startsAt.getTime() - envios[0]!.getTime()).toBeLessThanOrEqual(24 * HORA);
    }
  });

  it("antes de C-14 solo recibia aviso la cita de la franja 13:30-14:30 UTC del dia siguiente: aqui las de las otras horas SI lo reciben", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["17:00", "21:30"] }]); // 23:00Z del martes y 03:30Z del miercoles
    const porCita = await simular(negocio, [new Date("2026-09-15T14:00:00.000Z")]); // 9 h y 13.5 h antes
    // Con la ventana vieja (24 h +- 30 min = 13:30-14:30Z del miercoles) ninguna de las dos recibia aviso.
    expect([...porCita.values()].map((v) => v.length)).toEqual([1, 1]);
  });

  it("cron cada 30 min: un aviso por cita, con 23.5-24 h de anticipacion y sin duplicados aunque haya ~96 corridas", async () => {
    const negocio = await negocioConCitas(ZONAS);
    const ticks = ticksCada("2026-09-14T00:00:00.000Z", "2026-09-16T06:00:00.000Z", 30 * MIN);
    const porCita = await simular(negocio, ticks);
    for (const cita of negocio.citas) {
      const envios = porCita.get(cita.id)!;
      expect(envios, `cita ${cita.startsAt.toISOString()} (${cita.timeZone})`).toHaveLength(1);
      const anticipacion = cita.startsAt.getTime() - envios[0]!.getTime();
      expect(anticipacion).toBeLessThanOrEqual(24 * HORA);
      expect(anticipacion).toBeGreaterThan(23.5 * HORA);
    }
    // Una vez enviado (y marcado), mas corridas no reenvian nada.
    const otra = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T20:00:00.000Z"));
    expect(otra.sent).toBe(0);
  });

  it("una cita reservada con menos de 24 h de aviso tambien recibe el recordatorio (antes nunca lo recibia)", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["15:00"] }]); // 21:00 UTC del martes
    const [cita] = negocio.citas;
    const s = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T14:00:00.000Z")); // 7 h antes
    expect(s.sent).toBe(1);
    expect(negocio.fixture.repo.getOutbox().filter((o) => o.dedupeKey.startsWith(`reminder-24h:${cita!.id}:`))).toHaveLength(1);
  });

  it("jamas avisa de una cita que ya empezo ni de una a mas de 24 h", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["10:00"] }]); // 16:00 UTC del martes
    const lejos = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-14T15:59:00.000Z")); // 24 h 1 min antes
    expect(lejos.processed).toBe(0);
    const empezada = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T16:01:00.000Z"));
    expect(empezada.processed).toBe(0);
    expect(negocio.fixture.repo.getOutbox()).toHaveLength(0);
  });

  it("una cita cancelada no recibe recordatorio", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["10:00"] }]);
    await cancelAppointment(negocio.fixture.repo, { organizationId: negocio.fixture.organizationId, appointmentId: negocio.citas[0]!.id });
    const s = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T00:00:00.000Z"));
    expect(s.processed).toBe(0);
    expect(negocio.fixture.repo.getOutbox().filter((o) => o.channel === "whatsapp")).toHaveLength(0);
  });
});

describe("recordatorio de 24 h con horario de envio por zona de la sucursal, cruzando medianoche (C-14)", () => {
  const CON_HORARIO = { ...MENSAJES_CONFIG_POR_OMISION, sendWindowStart: 9, sendWindowEnd: 20 };

  it("cada aviso sale solo con la hora LOCAL de su sucursal dentro de 9-20 y en la primera corrida de 30 min con cupo", async () => {
    const negocio = await negocioConCitas(ZONAS);
    await negocio.fixture.repo.saveWhatsappMessageConfig(negocio.fixture.organizationId, 0, "actualizado", CON_HORARIO);
    const ticks = ticksCada("2026-09-14T00:00:00.000Z", "2026-09-16T06:00:00.000Z", 30 * MIN);
    const porCita = await simular(negocio, ticks);

    for (const cita of negocio.citas) {
      const envios = porCita.get(cita.id)!;
      expect(envios, `cita ${cita.startsAt.toISOString()} (${cita.timeZone})`).toHaveLength(1);
      const envio = envios[0]!;
      const horaLocalEnvio = horaLocal(envio, cita.timeZone);
      expect(horaLocalEnvio).toBeGreaterThanOrEqual(9);
      expect(horaLocalEnvio).toBeLessThan(20);
      expect(envio.getTime()).toBeLessThan(cita.startsAt.getTime());

      // Calculo independiente: la primera corrida con cupo desde que faltan 24 h.
      const esperado = ticks.find((t) => t.getTime() >= cita.startsAt.getTime() - 24 * HORA && horaLocal(t, cita.timeZone) >= 9 && horaLocal(t, cita.timeZone) < 20);
      expect(envio.toISOString()).toBe(esperado!.toISOString());
    }
  });

  it("una cita de la tarde (Tijuana 19:00 local = 02:00 UTC del dia siguiente) se avisa la tarde anterior en hora local aunque en UTC ya sea otro dia", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Tijuana", horas: ["19:00"] }]);
    await negocio.fixture.repo.saveWhatsappMessageConfig(negocio.fixture.organizationId, 0, "actualizado", CON_HORARIO);
    const porCita = await simular(negocio, ticksCada("2026-09-14T00:00:00.000Z", "2026-09-16T06:00:00.000Z", 30 * MIN));
    const envio = porCita.get(negocio.citas[0]!.id)![0]!;
    // Lunes 19:00 locales = martes 02:00Z: el horario esta abierto (9-20) y faltan exactamente 24 h.
    expect(envio.toISOString()).toBe("2026-09-15T02:00:00.000Z");
    expect(envio.getUTCDate()).toBe(15); // ya es martes en UTC...
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/Tijuana", day: "numeric" }).format(envio)).toBe("14"); // ...pero lunes en Tijuana
  });

  it("una cita de la noche (Tijuana 21:00 local) cuyo aviso cae con el horario cerrado espera a la apertura de la manana siguiente en hora local", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Tijuana", horas: ["21:00"] }]);
    await negocio.fixture.repo.saveWhatsappMessageConfig(negocio.fixture.organizationId, 0, "actualizado", CON_HORARIO);
    const porCita = await simular(negocio, ticksCada("2026-09-14T00:00:00.000Z", "2026-09-16T06:00:00.000Z", 30 * MIN));
    const envio = porCita.get(negocio.citas[0]!.id)![0]!;
    expect(envio.toISOString()).toBe("2026-09-15T16:00:00.000Z"); // martes 09:00 locales, 12 h antes de la cita
  });

  it("con el cron DIARIO a las 14:00 UTC el horario de envio se evalua en la zona de cada sucursal: abierto en Cancun (09:00), cerrado en Tijuana (07:00)", async () => {
    const negocio = await negocioConCitas([
      { zona: "America/Cancun", horas: ["06:00"] },
      { zona: "America/Tijuana", horas: ["06:00"] },
    ]);
    await negocio.fixture.repo.saveWhatsappMessageConfig(negocio.fixture.organizationId, 0, "actualizado", CON_HORARIO);
    const resumen = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-14T14:00:00.000Z")); // Cancun 09:00, Tijuana 07:00
    expect(resumen.sent).toBe(1);
    expect(resumen.skippedOutsideSendWindow).toBe(1);
    const enviado = negocio.fixture.repo.getOutbox()[0]!.dedupeKey.replace("reminder-24h:", "").split(":")[0]!;
    expect(enviado).toBe(negocio.citas.find((c) => c.timeZone === "America/Cancun")!.id);
  });
});

describe("recordatorio de 24 h: una reserva recien hecha espera a la siguiente corrida (C-14)", () => {
  /** Doble que reporta la fecha de reserva que le pidamos (el repositorio en memoria usa el reloj real). */
  class ReservaRecienteRepo extends InMemoryCitasRepository {
    reservadoHaceMs = 0;
    constructor(private readonly nowRef: () => Date) {
      super();
    }
    override async loadAppointmentsPendingReminder(organizationId: string, from: string, to: string): Promise<readonly ReminderCandidateRow[]> {
      const rows = await super.loadAppointmentsPendingReminder(organizationId, from, to);
      return rows.map((r) => ({ ...r, createdAt: new Date(this.nowRef().getTime() - this.reservadoHaceMs).toISOString() }));
    }
  }

  it("con 20 min de reservada no sale; con 1 h 30 min si, una sola vez", async () => {
    let ahora = new Date("2026-09-15T00:00:00.000Z");
    const repo = new ReservaRecienteRepo(() => ahora);
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["10:00"] }], repo);
    repo.reservadoHaceMs = 20 * MIN;
    const temprano = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, ahora);
    expect(temprano.sent).toBe(0);
    expect(temprano.processed).toBe(0);

    ahora = new Date(ahora.getTime() + 30 * MIN);
    repo.reservadoHaceMs = 90 * MIN;
    const despues = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, ahora);
    expect(despues.sent).toBe(1);
    const repetida = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date(ahora.getTime() + 30 * MIN));
    expect(repetida.sent).toBe(0);
    expect(negocio.fixture.repo.getOutbox().filter((o) => o.channel === "whatsapp")).toHaveLength(1);
  });
});

describe("recordatorio fallido: evento para notificaciones (C-14)", () => {
  it("una cita aislada por un error real genera un evento error_interno sin PII y con dedupe por cita", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["10:00"] }]);
    const cita = negocio.citas[0]!;
    const original = negocio.fixture.repo.markReminderSent.bind(negocio.fixture.repo);
    negocio.fixture.repo.markReminderSent = async () => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    };
    const resumen = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T00:00:00.000Z"));
    negocio.fixture.repo.markReminderSent = original;
    expect(resumen.failedReminderEvents).toEqual([
      {
        tipo: "citas.recordatorio_fallido",
        severidad: "atencion",
        categoria: "recordatorios",
        enlace: "agenda",
        dedupeKey: `citas.recordatorio_fallido:${cita.id}:error_interno`,
        organizationId: negocio.fixture.organizationId,
        appointmentId: cita.id,
        motivo: "error_interno",
      },
    ]);
    expect(JSON.stringify(resumen.failedReminderEvents)).not.toContain("99988877");
  });

  it("recordatorio activo pero sin ningun canal (sin WhatsApp conectado y sin correo) genera un evento sin_canal, y la cita sigue pendiente", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["10:00"] }]);
    negocio.fixture.repo.seedWhatsAppConfig(negocio.fixture.organizationId, "");
    const resumen = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T00:00:00.000Z"));
    expect(resumen.sent).toBe(0);
    expect(resumen.failedReminderEvents.map((e) => [e.motivo, e.severidad])).toEqual([["sin_canal", "info"]]);
    // Sigue pendiente: al conectar WhatsApp la siguiente corrida lo envia.
    negocio.fixture.repo.seedWhatsAppConfig(negocio.fixture.organizationId, "1234567890");
    const siguiente = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T00:30:00.000Z"));
    expect(siguiente.sent).toBe(1);
    expect(siguiente.failedReminderEvents).toEqual([]);
  });

  it("un recordatorio apagado no es un fallo: sin evento", async () => {
    const negocio = await negocioConCitas([{ zona: "America/Mexico_City", horas: ["10:00"] }]);
    await negocio.fixture.repo.saveWhatsappMessageConfig(negocio.fixture.organizationId, 0, "actualizado", { ...MENSAJES_CONFIG_POR_OMISION, reminderEnabled: false });
    const resumen = await runConfirmacionCitaCore(negocio.fixture.repo, negocio.fixture.organizationId, new Date("2026-09-15T00:00:00.000Z"));
    expect(resumen.failedReminderEvents).toEqual([]);
  });
});
