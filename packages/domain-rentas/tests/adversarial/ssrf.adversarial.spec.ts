// Rn-P3-13 -- suite adversarial SSRF del fetch de feeds iCal (caso 20 del catalogo de §Calendario-2) y limites del parser.
// Cubre lo que el arreglo H1 del original (IPv6 mapeada a IPv4) y los topes de red/tamano prometen y que sync-net-real.spec.ts
// (5 casos) no ejercitaba: formas hex/NAT64 de IPv6, rangos RFC1918 en sus bordes, esquemas peligrosos, redirect a un destino
// interno revalidado por salto, cuerpo mayor al tope, bomba de VEVENT, linea infinita y timeout TOTAL con servidor lento.
// Sin red real: los servidores son http.Server en loopback accesibles solo por el simulador local autorizado.
import * as http from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { IcsParseError, LIMITES_ICS_POR_DEFECTO, parsearIcs } from "../../src/ical/parser.ts";
import { fetchIcsSeguro } from "../../src/sync/net/fetch-ics-seguro.ts";
import { SsrfError, validarIpPermitida, validarTodasLasIps } from "../../src/sync/net/ssrf.ts";

const servidores: http.Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all(servidores.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function levantar(manejador: http.RequestListener): Promise<number> {
  const servidor = http.createServer(manejador);
  servidor.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  servidores.push(servidor);
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const dir = servidor.address();
  if (!dir || typeof dir === "string") throw new Error("no se pudo levantar el servidor de prueba");
  return dir.port;
}

/** Resolutor de la prueba: `simulador.local` es el unico host autorizado a loopback; el resto resuelve a lo que cada caso diga. */
const resolutor = (otros: Record<string, string[]> = {}) => (host: string): string[] => {
  if (host === "simulador.local") return ["127.0.0.1"];
  const ips = otros[host];
  if (!ips) throw new Error(`host inesperado en la prueba: ${host}`);
  return ips;
};

async function motivoDe(promesa: Promise<unknown>): Promise<string> {
  try {
    await promesa;
  } catch (e) {
    if (e instanceof SsrfError) return e.motivo;
    throw e;
  }
  return "no_lanzo";
}

describe("SSRF -- validarIpPermitida (IPv4 e IPv6 en todas sus formas textuales)", () => {
  const BLOQUEADAS: ReadonlyArray<readonly [string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback (borde alto de /8)"],
    ["0.0.0.0", "reservado 0.0.0.0/8"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["10.255.255.255", "RFC1918 10/8 borde alto"],
    ["172.16.0.1", "RFC1918 172.16/12 borde bajo"],
    ["172.31.255.255", "RFC1918 172.16/12 borde alto"],
    ["192.168.0.1", "RFC1918 192.168/16"],
    ["169.254.169.254", "metadata cloud"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["224.0.0.1", "multicast"],
    ["::1", "loopback IPv6"],
    ["::", "no especificada"],
    ["fe80::1", "link-local IPv6"],
    ["fc00::1", "unique-local IPv6"],
    ["fd12:3456::1", "unique-local IPv6 (fd)"],
    ["ff02::1", "multicast IPv6"],
    ["::ffff:127.0.0.1", "IPv4 mapeada a loopback (forma dotted-quad)"],
    ["::ffff:169.254.169.254", "IPv4 mapeada a metadata"],
    ["::ffff:7f00:1", "IPv4 mapeada a loopback (forma hex)"],
    ["::ffff:a9fe:a9fe", "IPv4 mapeada a metadata (forma hex)"],
    ["::FFFF:A9FE:A9FE", "IPv4 mapeada a metadata (mayusculas)"],
    ["0:0:0:0:0:ffff:7f00:1", "IPv4 mapeada expandida"],
    ["0000:0000:0000:0000:0000:ffff:0a00:0001", "IPv4 mapeada con relleno de ceros a 10.0.0.1"],
    ["[::ffff:10.0.0.1]", "IPv4 mapeada entre corchetes"],
    ["::ffff:192.168.1.1", "IPv4 mapeada a RFC1918"],
    ["::ffff:172.16.5.4", "IPv4 mapeada a 172.16/12"],
    ["64:ff9b::7f00:1", "NAT64 a loopback"],
    ["64:ff9b::a9fe:a9fe", "NAT64 a metadata"],
    ["64:ff9b::10.0.0.1", "NAT64 a RFC1918 (dotted-quad)"],
    ["::7f00:1", "IPv4-compatible deprecada a loopback"],
    ["fe80::1%eth0", "link-local con zona"],
  ];

  it.each(BLOQUEADAS)("rechaza %s (%s)", (ip) => {
    expect(validarIpPermitida(ip).permitida).toBe(false);
  });

  it.each([
    ["93.184.216.34"],
    ["8.8.8.8"],
    ["172.15.255.255"],
    ["172.32.0.1"],
    ["192.169.0.1"],
    ["2606:4700:4700::1111"],
    ["::ffff:8.8.8.8"],
    ["64:ff9b::808:808"],
  ])("control: permite la IP publica %s (el guard no rechaza todo)", (ip) => {
    expect(validarIpPermitida(ip).permitida).toBe(true);
  });

  it.each([["999.1.1.1"], ["1.2.3"], ["no-es-ip"], [":::"], ["1:2:3:4:5:6:7:8:9"], ["::ffff:1.2.3.999"]])("una cadena que no es IP (%s) se rechaza, nunca se permite por defecto", (ip) => {
    expect(validarIpPermitida(ip).permitida).toBe(false);
  });

  it("DNS mixto: basta UNA IP peligrosa entre varias publicas para rechazar el destino (fail-closed)", () => {
    expect(validarTodasLasIps(["93.184.216.34", "10.0.0.5"]).permitida).toBe(false);
    expect(validarTodasLasIps(["93.184.216.34", "::ffff:127.0.0.1"]).permitida).toBe(false);
    expect(validarTodasLasIps([]).permitida).toBe(false);
  });
});

describe("SSRF -- fetchIcsSeguro rechaza antes de abrir un socket", () => {
  it("esquema file: sin resolver DNS", async () => {
    let resolvio = false;
    const motivo = await motivoDe(
      fetchIcsSeguro({ url: "file:///etc/passwd", resolverPersonalizado: () => { resolvio = true; return ["127.0.0.1"]; } }),
    );
    expect(motivo).toBe("esquema_no_permitido");
    expect(resolvio).toBe(false);
  });

  it.each([["ftp://feed.example/x.ics"], ["gopher://feed.example/"], ["javascript:alert(1)"], ["data:text/calendar,BEGIN:VCALENDAR"]])("esquema %s", async (url) => {
    expect(await motivoDe(fetchIcsSeguro({ url, resolverPersonalizado: () => ["93.184.216.34"] }))).toBe("esquema_no_permitido");
  });

  it("http:// a una IP de loopback literal NO se acepta sin el modo simulador (ni con la bandera, porque el host no es simulador.local)", async () => {
    expect(await motivoDe(fetchIcsSeguro({ url: "http://127.0.0.1:8080/feed.ics" }))).toBe("esquema_no_permitido");
    expect(await motivoDe(fetchIcsSeguro({ url: "http://127.0.0.1:8080/feed.ics", permitirHttpSimuladorLocal: true }))).toBe("esquema_no_permitido");
  });

  it("http://simulador.local sin la bandera de desarrollo se rechaza (la bandera nunca es el valor por defecto)", async () => {
    expect(await motivoDe(fetchIcsSeguro({ url: "http://simulador.local:1/feed.ics", resolverPersonalizado: resolutor() }))).toBe("esquema_no_permitido");
  });

  it("https hacia un nombre que resuelve a loopback, sin modo simulador -> ip_bloqueada", async () => {
    expect(await motivoDe(fetchIcsSeguro({ url: "https://localhost-disfrazado.example/x.ics", resolverPersonalizado: () => ["127.0.0.1"] }))).toBe("ip_bloqueada");
  });

  it.each([["10.1.2.3"], ["172.16.0.9"], ["172.31.255.1"], ["192.168.1.1"], ["169.254.169.254"], ["::ffff:127.0.0.1"], ["::ffff:7f00:1"], ["64:ff9b::a9fe:a9fe"], ["::1"], ["fe80::1"]])("https hacia un nombre que resuelve a %s -> ip_bloqueada", async (ip) => {
    expect(await motivoDe(fetchIcsSeguro({ url: "https://feed-interno.example/x.ics", resolverPersonalizado: () => [ip] }))).toBe("ip_bloqueada");
  });

  it("credenciales embebidas (user:pass@) -> credenciales_en_url, antes de resolver", async () => {
    let resolvio = false;
    const motivo = await motivoDe(fetchIcsSeguro({ url: "https://usuario:secreto@feed.example/x.ics", resolverPersonalizado: () => { resolvio = true; return ["93.184.216.34"]; } }));
    expect(motivo).toBe("credenciales_en_url");
    expect(resolvio).toBe(false);
  });

  it("resolucion DNS vacia -> resolucion_dns_vacia", async () => {
    expect(await motivoDe(fetchIcsSeguro({ url: "https://sin-dns.example/x.ics", resolverPersonalizado: () => [] }))).toBe("resolucion_dns_vacia");
  });

  it("el mensaje de error nunca filtra la query ni las credenciales de la URL", async () => {
    try {
      await fetchIcsSeguro({ url: "https://feed.example/x.ics?token=SECRETO123", resolverPersonalizado: () => ["10.0.0.1"] });
      throw new Error("se esperaba SsrfError");
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfError);
      expect((e as Error).message).not.toContain("SECRETO123");
    }
  });
});

describe("SSRF -- redirecciones: cada salto se revalida", () => {
  async function conRedirect(location: string, otros: Record<string, string[]> = {}, opciones: { maxRedirects?: number } = {}): Promise<string> {
    const puerto = await levantar((_req, res) => {
      res.writeHead(302, { Location: location });
      res.end();
    });
    return motivoDe(fetchIcsSeguro({ url: `http://simulador.local:${puerto}/feed.ics`, permitirHttpSimuladorLocal: true, resolverPersonalizado: resolutor(otros), ...opciones }));
  }

  it.each([["169.254.169.254"], ["10.0.0.5"], ["172.16.5.4"], ["192.168.0.10"], ["::ffff:127.0.0.1"], ["64:ff9b::7f00:1"]])("segundo salto hacia un host que resuelve a %s -> ip_bloqueada", async (ip) => {
    expect(await conRedirect("https://interna.example/oculto.ics", { "interna.example": [ip] })).toBe("ip_bloqueada");
  });

  it("segundo salto hacia file:// -> esquema_no_permitido", async () => {
    expect(await conRedirect("file:///etc/passwd")).toBe("esquema_no_permitido");
  });

  it("segundo salto hacia http://169.254.169.254 (metadata en claro) -> esquema_no_permitido", async () => {
    expect(await conRedirect("http://169.254.169.254/latest/meta-data/")).toBe("esquema_no_permitido");
  });

  it("segundo salto con credenciales embebidas -> credenciales_en_url", async () => {
    expect(await conRedirect("https://u:p@feed.example/x.ics", { "feed.example": ["93.184.216.34"] })).toBe("credenciales_en_url");
  });

  it("Location relativa que vuelve al mismo host: bucle de redirecciones -> demasiadas_redirecciones (tope fijo, sin bucle infinito)", async () => {
    const puerto = await levantar((_req, res) => {
      res.writeHead(302, { Location: "/otra.ics" });
      res.end();
    });
    const motivo = await motivoDe(fetchIcsSeguro({ url: `http://simulador.local:${puerto}/feed.ics`, permitirHttpSimuladorLocal: true, resolverPersonalizado: resolutor(), maxRedirects: 3 }));
    expect(motivo).toBe("demasiadas_redirecciones");
  });
});

describe("Topes de cuerpo y de tiempo del fetch", () => {
  it("un cuerpo de mas de 5 MiB se aborta con el tope duro (sin acumularlo completo)", async () => {
    const puerto = await levantar((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/calendar" });
      const trozo = Buffer.alloc(256 * 1024, 0x41);
      let enviados = 0;
      const escribir = (): void => {
        while (enviados < 8 * 1024 * 1024) {
          enviados += trozo.length;
          if (!res.write(trozo)) {
            res.once("drain", escribir);
            return;
          }
        }
        res.end();
      };
      escribir();
    });
    await expect(fetchIcsSeguro({ url: `http://simulador.local:${puerto}/feed.ics`, permitirHttpSimuladorLocal: true, resolverPersonalizado: resolutor() })).rejects.toThrow(/excede el l.mite de 5242880 bytes/);
  });

  it("un cuerpo justo bajo el tope SI se entrega completo (el tope no rechaza feeds grandes legitimos)", async () => {
    const cuerpo = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n" + "X-RELLENO:" + "a".repeat(100_000) + "\r\n";
    const puerto = await levantar((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/calendar" });
      res.end(cuerpo);
    });
    const r = await fetchIcsSeguro({ url: `http://simulador.local:${puerto}/feed.ics`, permitirHttpSimuladorLocal: true, resolverPersonalizado: resolutor() });
    expect(r.status).toBe(200);
    expect(r.cuerpo).toBe(cuerpo);
  });

  it("timeout TOTAL: un servidor que gotea un byte cada 40 ms (nunca esta inactivo) se corta al vencer el plazo", async () => {
    const puerto = await levantar((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/calendar" });
      const t = setInterval(() => res.write("X"), 40);
      res.on("close", () => clearInterval(t));
    });
    const inicio = Date.now();
    await expect(fetchIcsSeguro({ url: `http://simulador.local:${puerto}/feed.ics`, permitirHttpSimuladorLocal: true, resolverPersonalizado: resolutor(), timeoutMs: 400 })).rejects.toThrow(/timeout/i);
    expect(Date.now() - inicio).toBeLessThan(3000);
  });

  it("timeout por socket muerto: un servidor que acepta y nunca responde se corta", async () => {
    const puerto = await levantar(() => {
      /* nunca responde */
    });
    await expect(fetchIcsSeguro({ url: `http://simulador.local:${puerto}/feed.ics`, permitirHttpSimuladorLocal: true, resolverPersonalizado: resolutor(), timeoutMs: 300 })).rejects.toThrow(/timeout/i);
  });
});

describe("Parser ICS -- bombas y entradas hostiles", () => {
  const evento = (i: number): string => `BEGIN:VEVENT\r\nUID:bomba-${i}@simulador.local\r\nDTSTAMP:20270101T000000Z\r\nDTSTART;VALUE=DATE:20270101\r\nDTEND;VALUE=DATE:20270102\r\nEND:VEVENT\r\n`;
  const envolver = (cuerpo: string): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Bomba//EN\r\n${cuerpo}END:VCALENDAR\r\n`;

  it("bomba de VEVENT: mas eventos que el tope por defecto -> demasiados_eventos", () => {
    const feed = envolver(Array.from({ length: LIMITES_ICS_POR_DEFECTO.maxEventos + 1 }, (_, i) => evento(i)).join(""));
    expect(feed.length).toBeLessThan(LIMITES_ICS_POR_DEFECTO.maxBytes * 4);
    try {
      parsearIcs(feed, { ...LIMITES_ICS_POR_DEFECTO, maxBytes: Number.MAX_SAFE_INTEGER });
      throw new Error("se esperaba IcsParseError");
    } catch (e) {
      expect(e).toBeInstanceOf(IcsParseError);
      expect((e as IcsParseError).codigo).toBe("demasiados_eventos");
    }
  });

  it("linea infinita (des-plegada por continuaciones) -> linea_demasiado_larga, sin agotar memoria", () => {
    const trozos = Array.from({ length: 400 }, () => ` ${"A".repeat(100)}`).join("\r\n");
    const feed = envolver(`BEGIN:VEVENT\r\nUID:linea@simulador.local\r\nDESCRIPTION:x\r\n${trozos}\r\nEND:VEVENT\r\n`);
    try {
      parsearIcs(feed);
      throw new Error("se esperaba IcsParseError");
    } catch (e) {
      expect((e as IcsParseError).codigo).toBe("linea_demasiado_larga");
    }
  });

  it("cuerpo mayor al tope de bytes del parser -> tamano_excedido antes de tokenizar", () => {
    const feed = envolver(`X-RELLENO:${"A".repeat(LIMITES_ICS_POR_DEFECTO.maxBytes)}\r\n`);
    try {
      parsearIcs(feed);
      throw new Error("se esperaba IcsParseError");
    } catch (e) {
      expect((e as IcsParseError).codigo).toBe("tamano_excedido");
    }
  });

  it("feed HTML disfrazado (pagina de login/captcha con 200 OK) no es un calendario valido y no produce eventos", () => {
    let eventos = -1;
    try {
      eventos = parsearIcs("<!doctype html><html><body><h1>Please verify you are human</h1></body></html>").eventos.length;
    } catch (e) {
      expect(e).toBeInstanceOf(IcsParseError);
      return;
    }
    expect(eventos).toBe(0);
  });

  it("feed truncado a mitad de un VEVENT -> IcsParseError, nunca un evento a medias", () => {
    const completo = envolver(evento(1));
    const truncado = completo.slice(0, completo.indexOf("DTEND"));
    expect(() => parsearIcs(truncado)).toThrow(IcsParseError);
  });

  it("un feed legitimo dentro de todos los limites se acepta (control)", () => {
    expect(parsearIcs(envolver(evento(1))).eventos).toHaveLength(1);
  });
});
