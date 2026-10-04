// Constructor minimo de ZIP para las pruebas de la carga masiva de CFDI (D-13): permite fabricar a proposito ZIP hostiles
// (encabezados que mienten, nombres con `..`, cifrado, duplicados) que una libreria de ZIP normal no escribiria.
import { deflateRawSync } from "node:zlib";

export interface EntradaZipPrueba {
  readonly nombre: string;
  readonly datos: Uint8Array | string;
  /** 8 = deflate (default), 0 = stored. */
  readonly metodo?: 0 | 8;
  /** Miente en el directorio central: tamaño descomprimido declarado. */
  readonly declararDescomprimido?: number;
  readonly flags?: number;
}

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLA_CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export function construirZip(entradas: readonly EntradaZipPrueba[]): Uint8Array {
  const partes: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  const codificador = new TextEncoder();
  for (const e of entradas) {
    const datos = typeof e.datos === "string" ? codificador.encode(e.datos) : e.datos;
    const metodo = e.metodo ?? 8;
    const comprimido = metodo === 8 ? new Uint8Array(deflateRawSync(datos)) : datos;
    const nombre = [...codificador.encode(e.nombre)];
    const flags = e.flags ?? 0x0800;
    const crc = crc32(datos);
    const declarado = e.declararDescomprimido ?? datos.byteLength;
    const local = [...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(metodo), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(comprimido.byteLength), ...u32(declarado), ...u16(nombre.length), ...u16(0), ...nombre];
    partes.push(local, [...comprimido]);
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(metodo), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(comprimido.byteLength), ...u32(declarado), ...u16(nombre.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nombre]);
    offset += local.length + comprimido.byteLength;
  }
  const tamCentral = central.reduce((s, c) => s + c.length, 0);
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entradas.length), ...u16(entradas.length), ...u32(tamCentral), ...u32(offset), ...u16(0)];
  return Uint8Array.from([...partes.flat(), ...central.flat(), ...eocd]);
}
