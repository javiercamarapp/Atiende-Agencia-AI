// Tests reales del generador de feed iCal propio — verifica round-trip
// (generar -> reparsear con el propio parser) contra el formato RFC 5545 real, y las
// invariantes de anti-eco (namespace de UID, hash determinista).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calcularHashContenidoBloqueo, construirUidExportado, esUidNamespacePropio, exportarFeedIcs, type BloqueoExportable } from "../src/ical/exportador.ts";
import { parsearIcs } from "../src/ical/parser.ts";

describe("exportarFeedIcs", () => {
  it("genera un feed VCALENDAR válido que el propio parser puede reparsear", () => {
    const ocupacionId = randomUUID();
    const bloqueos: BloqueoExportable[] = [{ ocupacionId, unidadId: "unidad-1", rango: { inicio: "2026-07-01", fin: "2026-07-05" }, razon: "RESERVA_CANAL", sequence: 0 }];
    const feed = exportarFeedIcs("Depto Centro 4B", bloqueos);

    expect(feed.contenidoIcs).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(feed.contenidoIcs).toContain("END:VCALENDAR\r\n");
    expect(feed.contenidoIcs).toContain("VERSION:2.0");

    const reparsed = parsearIcs(feed.contenidoIcs);
    expect(reparsed.eventos).toHaveLength(1);
    const evento = reparsed.eventos[0]!;
    expect(evento.uid).toBe(construirUidExportado(ocupacionId));
    expect(evento.dtstart).toEqual({ tipo: "DATE", fecha: "2026-07-01" });
    expect(evento.dtend).toEqual({ tipo: "DATE", fecha: "2026-07-05" });
    expect(evento.status).toBe("CONFIRMED");
    expect(evento.summary).toBe("Reservado");
    expect(esUidNamespacePropio(evento.uid)).toBe(true);
  });

  it("pliega (fold) una línea X-WR-CALNAME larga a 75 octetos por línea física", () => {
    const nombreLargo = "Depto " + "Muy Largo ".repeat(15);
    const feed = exportarFeedIcs(nombreLargo, []);
    const lineasFisicas = feed.contenidoIcs.split("\r\n");
    const lineaCalname = lineasFisicas.find((l) => l.startsWith("X-WR-CALNAME:"))!;
    expect(Buffer.byteLength(lineaCalname, "utf8")).toBeLessThanOrEqual(75);
    // La(s) línea(s) de continuación empiezan con un único espacio.
    const indice = lineasFisicas.indexOf(lineaCalname);
    expect(lineasFisicas[indice + 1]!.startsWith(" ")).toBe(true);
  });

  it("el hash de contenido es determinista y depende de (unidad, rango, razón), no del UID", () => {
    const h1 = calcularHashContenidoBloqueo({ unidadId: "u1", dtstart: "2026-01-01", dtend: "2026-01-05", razon: "RESERVA_CANAL" });
    const h2 = calcularHashContenidoBloqueo({ unidadId: "u1", dtstart: "2026-01-01", dtend: "2026-01-05", razon: "RESERVA_CANAL" });
    const h3 = calcularHashContenidoBloqueo({ unidadId: "u1", dtstart: "2026-01-01", dtend: "2026-01-06", razon: "RESERVA_CANAL" });
    const h4 = calcularHashContenidoBloqueo({ unidadId: "u1", dtstart: "2026-01-01", dtend: "2026-01-05", razon: "RESERVA_CANAL:CANCELLED" });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).not.toBe(h4);
  });

  it("nunca incluye datos de huésped en el SUMMARY exportado, para cualquier razón", () => {
    const razones: BloqueoExportable["razon"][] = ["RESERVA_CANAL", "BLOQUEO_PROPIETARIO", "MANTENIMIENTO", "BUFFER_LIMPIEZA"];
    for (const razon of razones) {
      const feed = exportarFeedIcs("Cal", [{ ocupacionId: randomUUID(), unidadId: "u1", rango: { inicio: "2026-01-01", fin: "2026-01-02" }, razon, sequence: 0 }]);
      expect(feed.contenidoIcs).not.toMatch(/[A-Za-z]+@[A-Za-z]+\.[a-z]{2,}/); // sin correos
      expect(feed.contenidoIcs).toMatch(/SUMMARY:/);
    }
  });
});
