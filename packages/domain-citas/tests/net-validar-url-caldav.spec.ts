// Hallazgo de auditoría (ALTO, SSRF real y explotable) — el endpoint de conexión
// CalDAV solo validaba que la URL empezara con "https://" (chequeo de STRING),
// sin bloquear hosts internos/privados. Estas pruebas cubren exactamente los 3
// escenarios del hallazgo:
//   (a) una URL pública legítima sigue funcionando.
//   (b) IPs literales privadas/loopback/link-local/metadata en la URL se
//       rechazan (localhost, 127.0.0.1, 169.254.169.254, 10.x, 172.16-31.x,
//       192.168.x, y sus equivalentes IPv6).
//   (c) un HOSTNAME que no tiene pinta de privado pero que RESUELVE por DNS a
//       una IP privada también se rechaza — la defensa real contra DNS
//       rebinding: se valida la IP a la que efectivamente se resolvería la
//       conexión, no el string del hostname en el momento de validar.
import { describe, expect, it } from "vitest";
import { crearValidadorUrlCaldav } from "../src/net/validar-url-caldav.ts";
import { validarIpPermitida, validarTodasLasIps } from "../src/net/ssrf.ts";

describe("validarIpPermitida / validarTodasLasIps (guard puro)", () => {
  it("permite IPs públicas IPv4 e IPv6 reales", () => {
    expect(validarIpPermitida("8.8.8.8").permitida).toBe(true);
    expect(validarIpPermitida("203.0.113.10").permitida).toBe(true);
    expect(validarIpPermitida("2606:4700:4700::1111").permitida).toBe(true); // Cloudflare DNS pública
  });

  it("rechaza loopback, link-local/metadata y los 3 rangos RFC1918 completos", () => {
    expect(validarIpPermitida("127.0.0.1").permitida).toBe(false);
    expect(validarIpPermitida("127.255.255.255").permitida).toBe(false);
    expect(validarIpPermitida("169.254.169.254").permitida).toBe(false); // metadata cloud (AWS/GCP/Azure)
    expect(validarIpPermitida("169.254.0.1").permitida).toBe(false);
    // 10.0.0.0/8
    expect(validarIpPermitida("10.0.0.0").permitida).toBe(false);
    expect(validarIpPermitida("10.255.255.255").permitida).toBe(false);
    // 172.16.0.0/12 (172.16.x a 172.31.x)
    expect(validarIpPermitida("172.16.0.0").permitida).toBe(false);
    expect(validarIpPermitida("172.31.255.255").permitida).toBe(false);
    expect(validarIpPermitida("172.15.255.255").permitida).toBe(true); // justo fuera del rango: NO bloqueado
    expect(validarIpPermitida("172.32.0.0").permitida).toBe(true); // justo fuera del rango: NO bloqueado
    // 192.168.0.0/16
    expect(validarIpPermitida("192.168.0.0").permitida).toBe(false);
    expect(validarIpPermitida("192.168.255.255").permitida).toBe(false);
  });

  it("rechaza los equivalentes IPv6 de loopback/link-local/metadata", () => {
    expect(validarIpPermitida("::1").permitida).toBe(false); // loopback IPv6
    expect(validarIpPermitida("fe80::1").permitida).toBe(false); // link-local IPv6
    expect(validarIpPermitida("fc00::1").permitida).toBe(false); // unique-local IPv6
    // IPv4 privada/metadata embebida en IPv6 (::ffff:a.b.c.d) -- cualquier
    // representación textual, no solo el prefijo literal "::ffff:".
    expect(validarIpPermitida("::ffff:127.0.0.1").permitida).toBe(false);
    expect(validarIpPermitida("::ffff:169.254.169.254").permitida).toBe(false);
    expect(validarIpPermitida("0:0:0:0:0:ffff:a9fe:a9fe").permitida).toBe(false); // 169.254.169.254 en hex completo
    expect(validarIpPermitida("::ffff:8.8.8.8").permitida).toBe(true); // pública embebida: permitida
  });

  it("validarTodasLasIps es fail-closed: basta UNA IP peligrosa en una respuesta DNS mixta", () => {
    expect(validarTodasLasIps(["8.8.8.8", "10.0.0.5"]).permitida).toBe(false);
    expect(validarTodasLasIps(["8.8.8.8", "1.1.1.1"]).permitida).toBe(true);
    expect(validarTodasLasIps([]).permitida).toBe(false);
  });
});

describe("crearValidadorUrlCaldav — validación real de la URL de conexión CalDAV", () => {
  it("(a) una URL pública legítima (hostname que resuelve a una IP pública) es permitida", async () => {
    const validar = crearValidadorUrlCaldav({ resolverDns: () => ["203.0.113.10"] });
    const resultado = await validar("https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/");
    expect(resultado.permitida).toBe(true);
  });

  it("(a) IPs públicas LITERALES en la URL (sin resolver inyectado -- usa dns.lookup real, que para una IP literal no toca la red) siguen permitidas", async () => {
    const validar = crearValidadorUrlCaldav();
    expect((await validar("https://8.8.8.8/dav/")).permitida).toBe(true);
    expect((await validar("https://203.0.113.10/dav/")).permitida).toBe(true);
  });

  it("rechaza un esquema distinto de https:// (nunca solo por el string -- ver ruta HTTP, que ya no usa un regex de prefijo)", async () => {
    const validar = crearValidadorUrlCaldav({ resolverDns: () => ["203.0.113.10"] });
    const resultado = await validar("http://caldav.fastmail.com/dav/x/");
    expect(resultado.permitida).toBe(false);
    expect(resultado.codigo).toBe("esquema_no_permitido");
  });

  it("rechaza una URL malformada sin lanzar", async () => {
    const validar = crearValidadorUrlCaldav();
    const resultado = await validar("no-es-una-url");
    expect(resultado.permitida).toBe(false);
    expect(resultado.codigo).toBe("url_invalida");
  });

  it("rechaza credenciales embebidas en la URL", async () => {
    const validar = crearValidadorUrlCaldav({ resolverDns: () => ["203.0.113.10"] });
    const resultado = await validar("https://user:pass@caldav.fastmail.com/dav/x/");
    expect(resultado.permitida).toBe(false);
    expect(resultado.codigo).toBe("credenciales_en_url");
  });

  it("(b) rechaza IPs literales privadas/loopback/link-local/metadata puestas directo en la URL, sin necesidad de resolver DNS custom", async () => {
    const validar = crearValidadorUrlCaldav(); // dns.lookup real -- IPs literales no tocan la red
    const urlsBloqueadas = [
      "https://localhost/dav/",
      "https://127.0.0.1/dav/",
      "https://169.254.169.254/latest/meta-data/", // metadata AWS/GCP/Azure
      "https://10.0.0.1/dav/",
      "https://10.255.255.254/dav/",
      "https://172.16.0.1/dav/",
      "https://172.31.255.254/dav/",
      "https://192.168.0.1/dav/",
      "https://192.168.255.254/dav/",
      "https://[::1]/dav/", // loopback IPv6
      "https://[fe80::1]/dav/", // link-local IPv6
    ];
    for (const url of urlsBloqueadas) {
      const resultado = await validar(url);
      expect(resultado.permitida, `esperaba que ${url} fuera rechazada`).toBe(false);
      expect(resultado.codigo, `esperaba código ip_bloqueada para ${url}`).toBe("ip_bloqueada");
    }
  });

  it("(c) DNS rebinding: un hostname SIN pinta de privado que resuelve a una IP privada también se rechaza -- se valida la IP resuelta, no el texto del hostname", async () => {
    // El hostname en sí no contiene ninguna señal ("localhost", una IP, etc.) --
    // solo un resolver DNS real revela que apunta a infraestructura interna. Si
    // la validación solo mirara el string de la URL (como el chequeo original de
    // `/^https:\/\//`), esto pasaría sin ser detectado.
    const validar = crearValidadorUrlCaldav({ resolverDns: (hostname) => (hostname === "calendario-legitimo.ejemplo-atacante.com" ? ["10.0.0.5"] : ["203.0.113.10"]) });
    const resultado = await validar("https://calendario-legitimo.ejemplo-atacante.com/dav/calendars/x/");
    expect(resultado.permitida).toBe(false);
    expect(resultado.codigo).toBe("ip_bloqueada");
  });

  it("(c) DNS rebinding con respuesta DNS mixta: si CUALQUIERA de las IPs resueltas es privada, se rechaza (fail-closed)", async () => {
    const validar = crearValidadorUrlCaldav({ resolverDns: () => ["203.0.113.10", "169.254.169.254"] });
    const resultado = await validar("https://calendario.ejemplo.com/dav/x/");
    expect(resultado.permitida).toBe(false);
    expect(resultado.codigo).toBe("ip_bloqueada");
  });

  it("rechaza cuando la resolución DNS no devuelve ninguna IP", async () => {
    const validar = crearValidadorUrlCaldav({ resolverDns: () => [] });
    const resultado = await validar("https://sin-dns.ejemplo.com/dav/x/");
    expect(resultado.permitida).toBe(false);
    expect(resultado.codigo).toBe("resolucion_dns_vacia");
  });

  it("rechaza cuando la resolución DNS falla (hostname inexistente)", async () => {
    const validar = crearValidadorUrlCaldav({
      resolverDns: () => {
        throw new Error("ENOTFOUND");
      },
    });
    const resultado = await validar("https://no-existe.ejemplo-invalido/dav/x/");
    expect(resultado.permitida).toBe(false);
    expect(resultado.codigo).toBe("resolucion_dns_vacia");
  });
});
