import { describe, expect, it } from "vitest";
import { resumirFeedIcs } from "../src/ical/probar-feed.ts";
import { IcsParseError } from "../src/ical/parser.ts";

const ev = (uid: string, ini: string, fin: string, extra: string[] = []) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${ini}`, `DTEND;VALUE=DATE:${fin}`, ...extra, "END:VEVENT"];
const cal = (...bloques: string[][]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", ...bloques.flat(), "END:VCALENDAR"].join("\r\n");

describe("resumirFeedIcs", () => {
  it("cuenta eventos y calcula el rango de fechas", () => {
    const r = resumirFeedIcs(cal(ev("a", "20270110", "20270114"), ev("b", "20270101", "20270103"), ev("c", "20270301", "20270305")));
    expect(r).toEqual({ eventos: 3, cancelados: 0, desde: "2027-01-01", hasta: "2027-03-05" });
  });

  it("un calendario válido sin eventos da rango nulo", () => {
    expect(resumirFeedIcs(cal())).toEqual({ eventos: 0, cancelados: 0, desde: null, hasta: null });
  });

  it("los eventos cancelados se cuentan aparte y no extienden el rango", () => {
    const r = resumirFeedIcs(cal(ev("a", "20270110", "20270114"), ev("x", "20280101", "20280105", ["STATUS:CANCELLED"])));
    expect(r).toEqual({ eventos: 2, cancelados: 1, desde: "2027-01-10", hasta: "2027-01-14" });
  });

  it("rechaza lo que no es un iCalendar con IcsParseError", () => {
    expect(() => resumirFeedIcs("<html>no soy un calendario</html>")).toThrow(IcsParseError);
    expect(() => resumirFeedIcs("")).toThrow(IcsParseError);
  });
});
