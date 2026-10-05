// QA-citas-R1-features-12: inscribirse en la lista de espera (staff, agente de WhatsApp y agente de voz).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "../src/errors.ts";
import { MAX_LISTA_ESPERA_ACTIVAS_POR_TELEFONO, enrollInWaitlist } from "../src/waitlist-enrollment.ts";
import { TOOLS_VOZ_CITAS, ejecutarToolVozCitas } from "../src/voz/tools-servidor.ts";
import { DEFINICIONES_VOZ_CITAS } from "../src/voz/registro-tools.ts";
import { TOOLS, executeToolCall } from "../src/whatsapp/llm-turn-handler.ts";
import { buildCitasFixture } from "./fixtures.ts";

const PHONE = "9991234567";

describe("enrollInWaitlist", () => {
  it("anota, es idempotente con la misma solicitud y queda como candidato vivo (el broadcast y el aviso al liberar ya tienen a quien avisar)", async () => {
    const f = buildCitasFixture();
    const base = { organizationId: f.organizationId, customerPhone: PHONE, customerName: "Ana", serviceId: f.serviceId, providerId: f.providerId, preferredDateFrom: "2027-09-13", preferredDateTo: "2027-09-17", preferredTimeWindow: "morning" };
    const a = await enrollInWaitlist(f.repo, base);
    const b = await enrollInWaitlist(f.repo, base);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    const vivos = await f.repo.loadLiveWaitlistCandidates(f.organizationId);
    expect(vivos).toHaveLength(1);
    expect(vivos[0]).toMatchObject({ customerPhone: PHONE, preferredTimeWindow: "morning", preferredDateFrom: "2027-09-13" });
  });

  it("sin preferencias queda como 'any' y sin fechas; valida fechas, franja, ids ajenos y NUL", async () => {
    const f = buildCitasFixture();
    const { entry } = await enrollInWaitlist(f.repo, { organizationId: f.organizationId, customerPhone: PHONE });
    expect(entry).toMatchObject({ preferredTimeWindow: "any", preferredDateFrom: null, providerId: null, serviceId: null });
    const base = { organizationId: f.organizationId, customerPhone: "9990000001" };
    for (const malo of [{ preferredDateFrom: "mañana" }, { preferredDateFrom: "2027-02-30" }, { preferredDateFrom: "2027-09-17", preferredDateTo: "2027-09-13" }, { preferredTimeWindow: "madrugada" }, { customerName: "Ana\u0000" }, { customerPhone: "" }]) {
      await expect(enrollInWaitlist(f.repo, { ...base, ...malo })).rejects.toBeInstanceOf(AppointmentValidationError);
    }
    await expect(enrollInWaitlist(f.repo, { ...base, serviceId: "no-es-uuid" })).rejects.toBeInstanceOf(AppointmentNotFoundError);
    await expect(enrollInWaitlist(f.repo, { ...base, providerId: randomUUID() })).rejects.toBeInstanceOf(AppointmentNotFoundError);
  });

  it("un telefono no puede acumular mas de 5 anotaciones activas (409)", async () => {
    const f = buildCitasFixture();
    for (let i = 0; i < MAX_LISTA_ESPERA_ACTIVAS_POR_TELEFONO; i++) {
      await enrollInWaitlist(f.repo, { organizationId: f.organizationId, customerPhone: PHONE, preferredDateFrom: `2027-09-${String(10 + i).padStart(2, "0")}` });
    }
    await expect(enrollInWaitlist(f.repo, { organizationId: f.organizationId, customerPhone: PHONE, preferredDateFrom: "2027-09-25" })).rejects.toBeInstanceOf(AppointmentConflictError);
  });

  it("la anotacion de una organizacion no aparece en la lista de otra", async () => {
    const a = buildCitasFixture();
    await enrollInWaitlist(a.repo, { organizationId: a.organizationId, customerPhone: PHONE });
    expect(await a.repo.loadLiveWaitlistCandidates(randomUUID())).toHaveLength(0);
  });
});

describe("anotar_lista_espera: herramienta del agente (WhatsApp y voz)", () => {
  it("WhatsApp: la herramienta existe, usa el telefono del chat (nunca un parametro) y no se duplica al repetirla", async () => {
    expect(TOOLS.some((t) => t.name === "anotar_lista_espera")).toBe(true);
    const f = buildCitasFixture();
    const input = { service_id: f.serviceId, provider_id: f.providerId, date_from: "2027-09-13", date_to: "2027-09-17", time_window: "afternoon", customer_name: "Ana", telefono: "9990009999" };
    const uno = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "anotar_lista_espera", input });
    const dos = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "anotar_lista_espera", input });
    expect((uno.result as { waitlist: { already_on_list: boolean } }).waitlist.already_on_list).toBe(false);
    expect((dos.result as { waitlist: { already_on_list: boolean } }).waitlist.already_on_list).toBe(true);
    const vivos = await f.repo.loadLiveWaitlistCandidates(f.organizationId);
    expect(vivos.map((v) => v.customerPhone)).toEqual([PHONE]);
  });

  it("WhatsApp: un id inventado o una fecha invalida regresan un error para el modelo, sin escribir nada", async () => {
    const f = buildCitasFixture();
    const r = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "anotar_lista_espera", input: { service_id: "inventado" } });
    expect(r.result).toHaveProperty("error");
    const r2 = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "anotar_lista_espera", input: { date_from: "el lunes" } });
    expect(r2.result).toHaveProperty("error");
    expect(await f.repo.loadLiveWaitlistCandidates(f.organizationId)).toHaveLength(0);
  });

  it("voz: esta declarada, exige numero de llamada (anonimo no puede) y anota con el numero de la llamada", async () => {
    expect(TOOLS_VOZ_CITAS).toContain("anotar_lista_espera");
    expect(DEFINICIONES_VOZ_CITAS.some((d) => d.name === "anotar_lista_espera")).toBe(true);
    const f = buildCitasFixture();
    const anonimo = await ejecutarToolVozCitas({ repo: f.repo, organizationId: f.organizationId, telefono: "" }, "anotar_lista_espera", {});
    expect(anonimo.resultado).toMatchObject({ error: "llamante_anonimo" });
    const ok = await ejecutarToolVozCitas({ repo: f.repo, organizationId: f.organizationId, telefono: PHONE }, "anotar_lista_espera", { time_window: "evening" });
    expect(ok.resultado).toMatchObject({ waitlist: { already_on_list: false } });
    expect((await f.repo.loadLiveWaitlistCandidates(f.organizationId))[0]).toMatchObject({ customerPhone: PHONE, preferredTimeWindow: "evening" });
  });
});
