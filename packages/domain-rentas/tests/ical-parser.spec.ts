// Tests reales (no mocks) del parser ICS RFC 5545 contra fixtures concretas —
// incluye una fixture real exportada por Airbnb (formato observado en producción:
// BEGIN/END VCALENDAR, VEVENT con UID/DTSTART/DTEND VALUE=DATE, SUMMARY genérico,
// sin SEQUENCE/DTSTAMP fiable en algunos feeds) y una fixture con TZID (formato de
// Google Calendar/Booking.com para eventos DATE-TIME).
import { describe, expect, it } from "vitest";
import { IcsParseError, parsearIcs } from "../src/ical/parser.ts";
import { resolverFechaLocal, fechaLocalDesdeFechaHoraConZona, fechaLocalDesdeInstante } from "../src/ical/resolver-fecha.ts";

// Fixture real: formato de export de Airbnb observado en producción (líneas CRLF,
// DTSTART/DTEND con VALUE=DATE, SUMMARY genérico "Reserved"/"Airbnb (Not available)").
const FIXTURE_AIRBNB = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Airbnb Inc//Hosting Calendar//EN",
  "CALSCALE:GREGORIAN",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260615",
  "DTEND;VALUE=DATE:20260620",
  "UID:a1b2c3d4e5f6@airbnb.com",
  "SUMMARY:Reserved",
  "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH",
  "DTSTAMP:20260601T120000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// Fixture con líneas plegadas (folding RFC 5545 §3.1: continuación con un único
// espacio) y TZID (formato típico de Booking.com/Google Calendar).
const FIXTURE_TZID_PLEGADA = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Booking.com//Calendar//EN",
  "BEGIN:VEVENT",
  "UID:booking-reserva-998877@booking.com",
  "SEQUENCE:2",
  "DTSTAMP:20260602T083000Z",
  "DTSTART;TZID=America/Mexico_City:20260710T150000",
  "DTEND;TZID=America/Mexico_City:20260715T110000",
  "STATUS:CONFIRMED",
  "SUMMARY:CLOSED - Not available (Booking.com reservation 998877 super larg",
  " o continuado en la siguiente línea)",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const FIXTURE_CANCELLED_CON_DURATION = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//VRBO//EN", "BEGIN:VEVENT", "UID:vrbo-111@homeaway.com", "DTSTAMP:20260603T000000Z", "DTSTART;VALUE=DATE:20260801", "DURATION:P3D", "STATUS:CANCELLED", "SEQUENCE:1", "END:VEVENT", "END:VCALENDAR"].join("\r\n");

describe("parsearIcs — fixtures reales RFC 5545", () => {
  it("parsea un feed real de Airbnb (VALUE=DATE, sin SEQUENCE)", () => {
    const resultado = parsearIcs(FIXTURE_AIRBNB);
    expect(resultado.eventos).toHaveLength(1);
    const [evento] = resultado.eventos;
    expect(evento!.uid).toBe("a1b2c3d4e5f6@airbnb.com");
    expect(evento!.dtstart).toEqual({ tipo: "DATE", fecha: "2026-06-15" });
    expect(evento!.dtend).toEqual({ tipo: "DATE", fecha: "2026-06-20" });
    expect(evento!.sequence).toBeNull();
    expect(evento!.summary).toBe("Reserved");
    expect(evento!.dtstamp).toBe("2026-06-01T12:00:00Z");
    // DATE no tiene zona: resolverFechaLocal la usa tal cual, sin importar la zona de
    // la propiedad.
    expect(resolverFechaLocal(evento!.dtstart, "America/Cancun")).toBe("2026-06-15");
    expect(resolverFechaLocal(evento!.dtend, "Europe/Madrid")).toBe("2026-06-20");
  });

  it("des-pliega (unfold) una línea SUMMARY partida y resuelve DATE-TIME con TZID a la zona de la propiedad", () => {
    const resultado = parsearIcs(FIXTURE_TZID_PLEGADA);
    expect(resultado.eventos).toHaveLength(1);
    const [evento] = resultado.eventos;
    // La línea SUMMARY plegada se reconstruye completa, sin el espacio de
    // continuación ni el CRLF.
    expect(evento!.summary).toBe("CLOSED - Not available (Booking.com reservation 998877 super largo continuado en la siguiente línea)");
    expect(evento!.status).toBe("CONFIRMED");
    expect(evento!.sequence).toBe(2);
    expect(evento!.dtstart).toEqual({ tipo: "DATE-TIME-TZID", tzid: "America/Mexico_City", fechaHoraLocal: "2026-07-10T15:00:00" });

    // Misma zona origen y destino: la fecha de calendario resultante es la fecha de
    // pared tal cual (sin cruzar medianoche por conversión de huso).
    expect(resolverFechaLocal(evento!.dtstart, "America/Mexico_City")).toBe("2026-07-10");
    // Zona destino distinta (Madrid, CEST = UTC+2 en julio): 2026-07-10T15:00 CDMX
    // (México ya no observa horario de verano, UTC-6 todo el año) = 2026-07-10T21:00
    // UTC = 2026-07-10T23:00 Madrid — mismo día calendario en este caso concreto.
    expect(resolverFechaLocal(evento!.dtstart, "Europe/Madrid")).toBe("2026-07-10");
  });

  it("calcula DTEND a partir de DURATION y respeta STATUS:CANCELLED", () => {
    const resultado = parsearIcs(FIXTURE_CANCELLED_CON_DURATION);
    const [evento] = resultado.eventos;
    expect(evento!.status).toBe("CANCELLED");
    expect(evento!.dtstart).toEqual({ tipo: "DATE", fecha: "2026-08-01" });
    expect(evento!.dtend).toEqual({ tipo: "DATE", fecha: "2026-08-04" }); // +P3D
  });

  it("tolera VTIMEZONE/VALARM desconocidos sin fallar el parseo", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:America/Mexico_City",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:con-alarma@x.com",
      "DTSTAMP:20260601T000000Z",
      "DTSTART;VALUE=DATE:20260901",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-P1D",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const resultado = parsearIcs(ics);
    expect(resultado.eventos).toHaveLength(1);
    expect(resultado.eventos[0]!.uid).toBe("con-alarma@x.com");
    // Sin DTEND/DURATION: duración implícita de un día natural.
    expect(resultado.eventos[0]!.dtend).toEqual({ tipo: "DATE", fecha: "2026-09-02" });
  });

  it("rechaza un feed que no inicia con BEGIN:VCALENDAR", () => {
    expect(() => parsearIcs("UID:x\r\nEND:VCALENDAR")).toThrowError(IcsParseError);
  });

  it("rechaza estructura desbalanceada (END sin BEGIN correspondiente)", () => {
    expect(() => parsearIcs("BEGIN:VCALENDAR\r\nEND:VEVENT\r\nEND:VCALENDAR")).toThrowError(IcsParseError);
  });

  it("rechaza VEVENT sin UID", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTAMP:20260601T000000Z\r\nDTSTART;VALUE=DATE:20260601\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(() => parsearIcs(ics)).toThrowError(IcsParseError);
  });

  it("rechaza UID vacío igual que UID ausente", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:\r\nDTSTAMP:20260601T000000Z\r\nDTSTART;VALUE=DATE:20260601\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(() => parsearIcs(ics)).toThrowError(IcsParseError);
  });

  it("rechaza una fecha con mes/día fuera de rango (validación semántica, no solo de forma)", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTAMP:20260601T000000Z\r\nDTSTART;VALUE=DATE:20269999\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(() => parsearIcs(ics)).toThrowError(IcsParseError);
  });

  it("rechaza una hora con componente fuera de rango (99 minutos)", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTAMP:20260601T000000Z\r\nDTSTART:20260601T009900Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(() => parsearIcs(ics)).toThrowError(IcsParseError);
  });

  // Hallazgo de auditoría (a3, MEDIA) — `DTSTART:00000101` es sintácticamente válido
  // según el regex de 4 dígitos (año "0000"), pero produce la fecha '0000-01-01', que
  // Postgres real rechaza con 22008 en `daterange()` -- ver el comentario de cabecera
  // de `validarComponentesFecha`. Se rechaza en el dominio, ANTES de cualquier SQL.
  it("rechaza DTSTART con año '0000' (VALUE=DATE)", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTAMP:20260601T000000Z\r\nDTSTART;VALUE=DATE:00000101\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(() => parsearIcs(ics)).toThrowError(IcsParseError);
  });

  it("rechaza DTSTART con año '0000' (DATE-TIME)", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTAMP:20260601T000000Z\r\nDTSTART:00000101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(() => parsearIcs(ics)).toThrowError(IcsParseError);
  });

  // Hallazgo de auditoría (a3, MEDIA) — un SEQUENCE fuera de rango de `integer`
  // (Postgres int4, máximo 2147483647 -- ver el comentario de cabecera del campo
  // `sequence` en la normalización de abajo) pasaba el parser con `Number.isFinite` y
  // reventaba `upsertEventoImportado` con 22003 contra Postgres real. Se descarta a
  // `null` (equivalente a "sin SEQUENCE"), nunca aborta el evento completo por esto
  // solo -- un canal real que manda un SEQUENCE corrupto no debería impedir importar
  // la reserva.
  it("descarta un SEQUENCE fuera de rango de int32 (queda null, no revienta el parseo)", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTAMP:20260601T000000Z\r\nDTSTART;VALUE=DATE:20260601\r\nSEQUENCE:9999999999\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const resultado = parsearIcs(ics);
    expect(resultado.eventos).toHaveLength(1);
    expect(resultado.eventos[0]!.sequence).toBeNull();
  });

  it("descarta un SEQUENCE negativo (queda null)", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTAMP:20260601T000000Z\r\nDTSTART;VALUE=DATE:20260601\r\nSEQUENCE:-1\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const resultado = parsearIcs(ics);
    expect(resultado.eventos[0]!.sequence).toBeNull();
  });

  it("acepta un SEQUENCE válido en el borde superior de int32", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTAMP:20260601T000000Z\r\nDTSTART;VALUE=DATE:20260601\r\nSEQUENCE:2147483647\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const resultado = parsearIcs(ics);
    expect(resultado.eventos[0]!.sequence).toBe(2147483647);
  });

  it("respeta el límite de tamaño en bytes", () => {
    const grande = "BEGIN:VCALENDAR\r\n" + "X-PADDING:" + "a".repeat(100) + "\r\n" + "END:VCALENDAR\r\n";
    expect(() => parsearIcs(grande, { maxBytes: 10, maxEventos: 5000, maxLongitudLineaDesplegada: 8000 })).toThrowError(IcsParseError);
  });

  it("respeta el límite de número de eventos", () => {
    const lineas = ["BEGIN:VCALENDAR", "VERSION:2.0"];
    for (let i = 0; i < 3; i++) {
      lineas.push("BEGIN:VEVENT", `UID:e${i}@x.com`, "DTSTAMP:20260601T000000Z", "DTSTART;VALUE=DATE:20260601", "END:VEVENT");
    }
    lineas.push("END:VCALENDAR");
    expect(() => parsearIcs(lineas.join("\r\n"), { maxBytes: 2 * 1024 * 1024, maxEventos: 2, maxLongitudLineaDesplegada: 8000 })).toThrowError(IcsParseError);
  });

  it("rechaza una zona horaria IANA inválida al resolver la fecha local", () => {
    const resultado = parsearIcs(FIXTURE_TZID_PLEGADA);
    expect(() => resolverFechaLocal(resultado.eventos[0]!.dtstart, "Marte/Cráter_Gale")).toThrowError(IcsParseError);
  });

  it("fechaLocalDesdeInstante y fechaLocalDesdeFechaHoraConZona son consistentes entre sí", () => {
    // 2026-01-15T05:00:00Z en America/Mexico_City (UTC-6 en enero, sin DST) es
    // 2026-01-14T23:00:00 hora local -> fecha de calendario 2026-01-14.
    expect(fechaLocalDesdeInstante("2026-01-15T05:00:00Z", "America/Mexico_City")).toBe("2026-01-14");
    // La misma hora de pared, interpretada como si ya estuviera en
    // America/Mexico_City, resuelta de vuelta a esa misma zona, debe devolver la
    // fecha de pared tal cual (identidad).
    expect(fechaLocalDesdeFechaHoraConZona("2026-01-14T23:00:00", "America/Mexico_City", "America/Mexico_City")).toBe("2026-01-14");
  });
});
