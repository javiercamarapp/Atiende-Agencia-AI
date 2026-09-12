import { describe, expect, it } from "vitest";
import { buildVEventIcs, IcsParseError, parseVEventIcs } from "../src/caldav-ics.ts";

describe("buildVEventIcs", () => {
  it("produce un VCALENDAR/VEVENT válido con CRLF y campos exactos", () => {
    const ics = buildVEventIcs({
      uid: "cita-123@atiende.ai",
      dtstartUtc: "2026-09-10T15:00:00.000Z",
      dtendUtc: "2026-09-10T15:30:00.000Z",
      summary: "Consulta general - Juan Pérez",
      description: "Tel: 5512345678",
      dtstampUtc: "2026-09-08T00:00:00.000Z",
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics).toContain("UID:cita-123@atiende.ai\r\n");
    expect(ics).toContain("DTSTART:20260910T150000Z\r\n");
    expect(ics).toContain("DTEND:20260910T153000Z\r\n");
    expect(ics).toContain("DTSTAMP:20260908T000000Z\r\n");
    expect(ics).toContain("SUMMARY:Consulta general - Juan Pérez\r\n");
    expect(ics).toContain("DESCRIPTION:Tel: 5512345678\r\n");
    expect(ics).toContain("STATUS:CONFIRMED\r\n");
    expect(ics.trimEnd().endsWith("END:VEVENT\r\nEND:VCALENDAR")).toBe(true);
    // Nunca LF suelto sin CR (RFC 5545 exige CRLF).
    expect(/(?<!\r)\n/.test(ics)).toBe(false);
  });

  it("incluye ATTENDEE con mailto: y CN cuando se da nombre+email", () => {
    const ics = buildVEventIcs({ uid: "cita-456@atiende.ai", dtstartUtc: "2026-09-10T15:00:00.000Z", dtendUtc: "2026-09-10T15:30:00.000Z", summary: "Cita", description: "", attendeeEmail: "juan@example.com", attendeeName: "Juan Pérez" });
    expect(ics).toContain("ATTENDEE;CN=Juan Pérez:mailto:juan@example.com\r\n");
  });

  it("escapa `,` `;` `\\` y saltos de línea en SUMMARY/DESCRIPTION (RFC 5545 §3.3.11)", () => {
    const ics = buildVEventIcs({ uid: "cita-789@atiende.ai", dtstartUtc: "2026-09-10T15:00:00.000Z", dtendUtc: "2026-09-10T15:30:00.000Z", summary: "Cita; urgente, con \\ y\nsalto", description: "" });
    expect(ics).toContain("SUMMARY:Cita\\; urgente\\, con \\\\ y\\nsalto\r\n");
  });

  it("pliega (fold) líneas que exceden 75 octetos, con continuación de un espacio", () => {
    const summaryLargo = "S".repeat(200);
    const ics = buildVEventIcs({ uid: "cita-fold@atiende.ai", dtstartUtc: "2026-09-10T15:00:00.000Z", dtendUtc: "2026-09-10T15:30:00.000Z", summary: summaryLargo, description: "" });
    const lineasCrudas = ics.split("\r\n");
    for (const linea of lineasCrudas) {
      expect(new TextEncoder().encode(linea).length).toBeLessThanOrEqual(75);
    }
    const idx = lineasCrudas.findIndex((l) => l.startsWith("SUMMARY:"));
    expect(lineasCrudas[idx + 1]?.startsWith(" ")).toBe(true);
    // Round-trip: al parsear de vuelta, el summary completo se recompone.
    const parsed = parseVEventIcs(ics);
    expect(parsed.summary).toBe(summaryLargo);
  });
});

describe("parseVEventIcs", () => {
  it("round-trip completo build->parse conserva todos los campos", () => {
    const draft = {
      uid: "cita-roundtrip@atiende.ai",
      dtstartUtc: "2026-09-10T15:00:00.000Z",
      dtendUtc: "2026-09-10T15:30:00.000Z",
      summary: "Consulta, con coma; y punto y coma",
      description: "Notas:\nsegunda línea",
      dtstampUtc: "2026-09-08T00:00:00.000Z",
    };
    const ics = buildVEventIcs(draft);
    const parsed = parseVEventIcs(ics);
    expect(parsed.uid).toBe(draft.uid);
    expect(parsed.dtstartUtc).toBe(draft.dtstartUtc);
    expect(parsed.dtendUtc).toBe(draft.dtendUtc);
    expect(parsed.summary).toBe(draft.summary);
    expect(parsed.description).toBe(draft.description);
    expect(parsed.status).toBe("CONFIRMED");
  });

  it("VEVENT sin UID lanza IcsParseError", () => {
    const rotoIcs = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "DTSTART:20260910T150000Z", "DTEND:20260910T153000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    expect(() => parseVEventIcs(rotoIcs)).toThrow(IcsParseError);
  });

  it("tolera parámetros en ATTENDEE sin fallar (no los necesita, pero no debe romperse)", () => {
    const ics = buildVEventIcs({ uid: "cita-attendee@atiende.ai", dtstartUtc: "2026-09-10T15:00:00.000Z", dtendUtc: "2026-09-10T15:30:00.000Z", summary: "Cita", description: "", attendeeEmail: "juan@example.com", attendeeName: "Juan Pérez" });
    const parsed = parseVEventIcs(ics);
    expect(parsed.uid).toBe("cita-attendee@atiende.ai");
  });
});
