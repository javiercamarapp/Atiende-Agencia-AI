// Guardas SSRF puras — port literal de rentas/packages/adapters/src/net/ssrf.ts
// (repo origen, H-024, REQ-030). Sin IO: solo deciden si una IP/URL está permitida.
// `fetch-ics-seguro.ts` es quien las invoca ANTES de abrir cualquier socket.

export type MotivoRechazoSsrf = "esquema_no_permitido" | "credenciales_en_url" | "ip_bloqueada" | "resolucion_dns_vacia" | "demasiadas_redirecciones";

export class SsrfError extends Error {
  readonly motivo: MotivoRechazoSsrf;
  constructor(motivo: MotivoRechazoSsrf, mensaje: string) {
    super(mensaje);
    this.name = "SsrfError";
    this.motivo = motivo;
  }
}

/** Convierte una IPv4 en un entero de 32 bits para comparación de rangos. */
function ipv4AEntero(ip: string): number | null {
  const partes = ip.split(".");
  if (partes.length !== 4) return null;
  let n = 0;
  for (const parte of partes) {
    const octeto = Number(parte);
    if (!Number.isInteger(octeto) || octeto < 0 || octeto > 255) return null;
    n = (n << 8) | octeto;
  }
  return n >>> 0;
}

function enRangoIpv4(ip: string, base: string, bits: number): boolean {
  const ipNum = ipv4AEntero(ip);
  const baseNum = ipv4AEntero(base);
  if (ipNum === null || baseNum === null) return false;
  const mascara = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mascara) === (baseNum & mascara);
}

// OWASP SSRF Prevention Cheat Sheet: metadata cloud + todos los rangos privados/
// loopback/link-local IPv4.
const RANGOS_BLOQUEADOS_IPV4: Array<{ base: string; bits: number; motivo: string }> = [
  { base: "127.0.0.0", bits: 8, motivo: "loopback" },
  { base: "0.0.0.0", bits: 8, motivo: "reservado (0.0.0.0/8)" },
  { base: "10.0.0.0", bits: 8, motivo: "privado RFC1918" },
  { base: "172.16.0.0", bits: 12, motivo: "privado RFC1918" },
  { base: "192.168.0.0", bits: 16, motivo: "privado RFC1918" },
  { base: "169.254.0.0", bits: 16, motivo: "link-local / metadata cloud (169.254.169.254 incluido)" },
  { base: "224.0.0.0", bits: 4, motivo: "multicast" },
  { base: "100.64.0.0", bits: 10, motivo: "CGNAT compartido (RFC 6598)" },
];

/** Parsea una dirección IPv6 textual (cualquier forma válida: comprimida con `::`,
 * expandida, con dotted-quad IPv4 embebido en el último grupo) a sus 16 bytes.
 * Devuelve `null` si la cadena no es una IPv6 válida. Necesario para detectar de forma
 * robusta (no solo por prefijo literal `"::ffff:"`) CUALQUIER representación de una
 * IPv4 mapeada/embebida en IPv6: dotted-quad (`::ffff:127.0.0.1`), hexadecimal
 * completa (`0:0:0:0:0:ffff:7f00:1`), con mayúsculas, con relleno de ceros, etc. */
function parsearIpv6ABytes(ipOriginal: string): number[] | null {
  let ip = ipOriginal.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const idxZona = ip.indexOf("%");
  if (idxZona !== -1) ip = ip.slice(0, idxZona);
  if (ip === "") return null;

  const mitades = ip.split("::");
  if (mitades.length > 2) return null; // "::" no puede aparecer más de una vez

  const partir = (grupo: string): string[] => (grupo === "" ? [] : grupo.split(":"));

  const expandirIpv4Embebida = (grupos: string[]): string[] | null => {
    if (grupos.length === 0) return grupos;
    const ultimo = grupos[grupos.length - 1]!;
    if (!ultimo.includes(".")) return grupos;
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ultimo)) return null;
    const octetos = ultimo.split(".").map(Number);
    if (octetos.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hexAlto = (((octetos[0]! << 8) | octetos[1]!) >>> 0).toString(16);
    const hexBajo = (((octetos[2]! << 8) | octetos[3]!) >>> 0).toString(16);
    return [...grupos.slice(0, -1), hexAlto, hexBajo];
  };

  const izquierda = expandirIpv4Embebida(partir(mitades[0]!));
  const derecha = mitades.length === 2 ? expandirIpv4Embebida(partir(mitades[1]!)) : [];
  if (izquierda === null || derecha === null) return null;

  const totalGrupos = izquierda.length + derecha.length;
  if (mitades.length === 1) {
    if (totalGrupos !== 8) return null;
  } else {
    if (totalGrupos > 7) return null; // "::" debe representar >=1 grupo de ceros
  }
  const relleno = mitades.length === 2 ? new Array(8 - totalGrupos).fill("0") : [];
  const grupos = [...izquierda, ...relleno, ...derecha];
  if (grupos.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of grupos) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/** Si los bytes de una IPv6 codifican una IPv4 (mapeada `::ffff:0:0/96`,
 * compatible-deprecada `::/96`, o NAT64 well-known `64:ff9b::/96`), devuelve esa IPv4
 * en notación decimal con puntos. */
function ipv4EmbebidaEnBytes(bytes: number[]): string | null {
  const esCero = (desde: number, hasta: number): boolean => bytes.slice(desde, hasta).every((b) => b === 0);
  const ultimosCuatro = (): string => bytes.slice(12, 16).join(".");

  // ::ffff:a.b.c.d — IPv4-mapeada (RFC 4291 §2.5.5.2).
  if (esCero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return ultimosCuatro();
  // 64:ff9b::a.b.c.d — NAT64 Well-Known Prefix (RFC 6052), mismo vector.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && esCero(4, 12)) {
    return ultimosCuatro();
  }
  // ::a.b.c.d — IPv4-compatible, deprecada (RFC 4291), excluyendo ::/128 y ::1/128.
  if (esCero(0, 12) && !esCero(12, 16) && !(esCero(12, 15) && bytes[15] === 1)) return ultimosCuatro();
  return null;
}

function ipv6EsLoopbackOULinkLocalOULocalUnica(bytes: number[]): { bloqueada: boolean; motivo?: string } {
  const esCero = (desde: number, hasta: number): boolean => bytes.slice(desde, hasta).every((b) => b === 0);
  if (esCero(0, 16)) return { bloqueada: true, motivo: "IPv6 no especificada" };
  if (esCero(0, 15) && bytes[15] === 1) return { bloqueada: true, motivo: "loopback IPv6" };
  if ((bytes[0]! & 0xff) === 0xfe && (bytes[1]! & 0xc0) === 0x80) {
    return { bloqueada: true, motivo: "link-local IPv6 (fe80::/10)" };
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return { bloqueada: true, motivo: "unique-local IPv6 (fc00::/7)" };
  if (bytes[0] === 0xff) return { bloqueada: true, motivo: "multicast IPv6 (ff00::/8)" };
  return { bloqueada: false };
}

export interface ResultadoValidacionIp {
  permitida: boolean;
  motivo?: string;
}

/** Valida una única IP (v4 o v6) ya resuelta contra la deny-list completa: metadata
 * cloud, loopback, link-local, RFC1918, multicast, unique-local IPv6. Toda IPv6 que
 * codifique una IPv4 (mapeada `::ffff:a.b.c.d`, en cualquier representación textual,
 * NAT64 `64:ff9b::/96`, o compatible-deprecada `::a.b.c.d`) se normaliza a esa IPv4 y
 * se revalida por completo contra `RANGOS_BLOQUEADOS_IPV4`, en vez de compararse solo
 * contra los patrones IPv6. */
export function validarIpPermitida(ip: string): ResultadoValidacionIp {
  const esIpv4Literal = ip.includes(".") && !ip.includes(":");
  if (esIpv4Literal) {
    for (const rango of RANGOS_BLOQUEADOS_IPV4) {
      if (enRangoIpv4(ip, rango.base, rango.bits)) {
        return { permitida: false, motivo: rango.motivo };
      }
    }
    return { permitida: true };
  }

  const bytes = parsearIpv6ABytes(ip);
  if (bytes === null) return { permitida: false, motivo: "dirección IP no reconocida" };

  const ipv4Embebida = ipv4EmbebidaEnBytes(bytes);
  if (ipv4Embebida !== null) return validarIpPermitida(ipv4Embebida);

  const resultado = ipv6EsLoopbackOULinkLocalOULocalUnica(bytes);
  if (resultado.bloqueada) return { permitida: false, motivo: resultado.motivo };
  return { permitida: true };
}

/** Valida un conjunto completo de IPs resueltas para un mismo hostname: fail-closed —
 * basta con que UNA sea peligrosa para rechazar la conexión completa (evita elegir
 * selectivamente la IP "buena" de una respuesta DNS mixta, un vector de DNS
 * rebinding). */
export function validarTodasLasIps(ips: readonly string[]): ResultadoValidacionIp {
  if (ips.length === 0) return { permitida: false, motivo: "resolución DNS sin resultados" };
  for (const ip of ips) {
    const r = validarIpPermitida(ip);
    if (!r.permitida) return r;
  }
  return { permitida: true };
}

/** Elimina credenciales (`user:pass@`) de una URL antes de loguearla — nunca se
 * registran credenciales en logs. También colapsa la query string para no filtrar
 * tokens de canal embebidos como parámetro. */
export function redactarUrlParaLog(url: string): string {
  try {
    const u = new URL(url);
    const query = u.search ? "?<redactado>" : "";
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}${query}`;
  } catch {
    return "<url-invalida-no-logueada>";
  }
}
