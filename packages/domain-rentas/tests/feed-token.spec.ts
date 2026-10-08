// Rn-13 -- token opaco y rotable de la URL de exportación del feed iCal (dominio puro).
import { describe, expect, it } from "vitest";
import {
  etagDeFeedIcs,
  extraerTokenDeSegmento,
  generarTokenFeed,
  hashesFeedIguales,
  hashTokenFeed,
  rutaFeedPorToken,
  tokenFeedConFormatoValido,
} from "../src/ical/feed-token.ts";

describe("generarTokenFeed / hashTokenFeed", () => {
  it("genera 256 bits en base64url (43 caracteres) y el hash es el SHA-256 hexadecimal del token", () => {
    const { token, hash } = generarTokenFeed();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTokenFeed(token)).toBe(hash);
    // Vector conocido: SHA-256("abc").
    expect(hashTokenFeed("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("dos tokens nunca coinciden y el hash no contiene el token", () => {
    const a = generarTokenFeed();
    const b = generarTokenFeed();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).not.toContain(a.token);
  });
});

describe("hashesFeedIguales (comparación en tiempo constante)", () => {
  it("iguala hashes idénticos y rechaza distintos", () => {
    const { hash } = generarTokenFeed();
    expect(hashesFeedIguales(hash, hash)).toBe(true);
    expect(hashesFeedIguales(hash, generarTokenFeed().hash)).toBe(false);
  });

  it("rechaza entradas que no son un SHA-256 hexadecimal sin lanzar (longitud distinta, mayúsculas, basura)", () => {
    const { hash } = generarTokenFeed();
    expect(hashesFeedIguales(hash, hash.slice(0, 63))).toBe(false);
    expect(hashesFeedIguales(hash, hash.toUpperCase())).toBe(false);
    expect(hashesFeedIguales("", "")).toBe(false);
    expect(hashesFeedIguales("zz", "zz")).toBe(false);
  });
});

describe("forma del token en la ruta", () => {
  it("acepta `<token>.ics` y devuelve el token; rechaza lo demás", () => {
    const { token } = generarTokenFeed();
    expect(tokenFeedConFormatoValido(token)).toBe(true);
    expect(extraerTokenDeSegmento(`${token}.ics`)).toBe(token);
    expect(extraerTokenDeSegmento(token)).toBeNull(); // sin .ics
    expect(extraerTokenDeSegmento(`${token}x.ics`)).toBeNull(); // 44 caracteres
    expect(extraerTokenDeSegmento("corto.ics")).toBeNull();
    expect(extraerTokenDeSegmento(`${"a".repeat(42)}!.ics`)).toBeNull();
    expect(rutaFeedPorToken(token)).toBe(`/rentas/feed/${token}.ics`);
  });
});

describe("etagDeFeedIcs", () => {
  const feed = (dtstamp: string, uid = "u1") =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${dtstamp}`, "DTSTART;VALUE=DATE:20270101", "DTEND;VALUE=DATE:20270104", "END:VEVENT", "END:VCALENDAR"].join("\r\n") + "\r\n";

  it("no cambia cuando solo cambia el DTSTAMP (el exportador lo pone en `ahora` en cada petición)", () => {
    expect(etagDeFeedIcs(feed("20260101T000000Z"))).toBe(etagDeFeedIcs(feed("20261007T101500Z")));
  });

  it("cambia cuando cambia la disponibilidad", () => {
    expect(etagDeFeedIcs(feed("20260101T000000Z", "u1"))).not.toBe(etagDeFeedIcs(feed("20260101T000000Z", "u2")));
  });

  it("es un ETag entrecomillado", () => {
    expect(etagDeFeedIcs(feed("20260101T000000Z"))).toMatch(/^"[0-9a-f]{32}"$/);
  });
});
