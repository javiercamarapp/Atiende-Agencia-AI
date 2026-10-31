// Limpieza de duplicados de clientes. REGLA DETERMINISTA: dos clientes son el MISMO si sus telefonos coinciden en los ultimos 10
// digitos (normalizePhone). Esos se FUSIONAN (conservando todo el historial); los parecidos por nombre/colonia solo se PROPONEN
// para que un humano decida (jamas se fusionan solos). Funciones puras; la fusion en base la hace `restaurantes.historial_fusionar_duplicados` (141).
import { sinAcentos } from "../product-search.ts";

export interface ClienteParaFusion {
  readonly id: string;
  readonly phone: string;
  readonly name: string | null;
  readonly orderCount: number;
  readonly lastOrderAt: string | null;
  readonly createdAt: string;
  readonly colonia?: string | null;
}

export interface GrupoFusion {
  /** Ultimos 10 digitos: la clave de identidad. */
  readonly clave: string;
  readonly sobreviviente: string;
  readonly absorbidos: readonly string[];
  readonly orderCountTotal: number;
  readonly lastOrderAt: string | null;
  readonly nombre: string | null;
}

/** Clave de identidad por telefono; null si no hay al menos 10 digitos (un fragmento corto nunca identifica a nadie). */
export function clavePorTelefono(phone: string): string | null {
  const d = phone.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Orden total y estable: mas pedidos, luego el mas antiguo, luego id. El primero sobrevive. */
function mejorPrimero(a: ClienteParaFusion, b: ClienteParaFusion): number {
  return b.orderCount - a.orderCount || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Grupos con mas de un cliente para la misma clave de telefono. Orden estable por clave. */
export function planFusionPorTelefono(clientes: readonly ClienteParaFusion[]): GrupoFusion[] {
  const grupos = new Map<string, ClienteParaFusion[]>();
  for (const c of clientes) {
    const k = clavePorTelefono(c.phone);
    if (k === null) continue;
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(c);
  }
  const out: GrupoFusion[] = [];
  for (const [clave, lista] of [...grupos].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (lista.length < 2) continue;
    const orden = [...lista].sort(mejorPrimero);
    const fechas = orden.map((c) => c.lastOrderAt).filter((f): f is string => f !== null).sort();
    out.push({
      clave,
      sobreviviente: orden[0]!.id,
      absorbidos: orden.slice(1).map((c) => c.id),
      orderCountTotal: orden.reduce((s, c) => s + c.orderCount, 0),
      lastOrderAt: fechas.length > 0 ? fechas[fechas.length - 1]! : null,
      nombre: orden.find((c) => c.name !== null && c.name.trim() !== "")?.name ?? null,
    });
  }
  return out;
}

export interface DomicilioParaFusion {
  readonly address: string;
  readonly colonia: string | null;
  readonly timesUsed: number;
  readonly isDefault: boolean;
}

/** Une listas de domicilios: dos son el mismo si el texto normalizado coincide; gana el que tiene colonia, luego mas usos. Un solo predeterminado. */
export function fusionarDomicilios(listas: readonly (readonly DomicilioParaFusion[])[]): DomicilioParaFusion[] {
  const claves = new Map<string, DomicilioParaFusion>();
  for (const lista of listas)
    for (const d of lista) {
      const k = sinAcentos(d.address).replace(/[^a-z0-9]+/g, " ").trim();
      if (k === "") continue;
      const previo = claves.get(k);
      if (!previo) claves.set(k, d);
      else {
        const gana = (previo.colonia === null && d.colonia !== null) || (previo.colonia === null) === (d.colonia === null) && d.timesUsed > previo.timesUsed;
        claves.set(k, { ...(gana ? d : previo), timesUsed: previo.timesUsed + d.timesUsed, isDefault: previo.isDefault || d.isDefault });
      }
    }
  const out = [...claves.values()];
  let hayDefault = false;
  return out.map((d) => {
    const esDefault = d.isDefault && !hayDefault;
    if (esDefault) hayDefault = true;
    return { ...d, isDefault: esDefault };
  });
}

export interface PropuestaDuplicado {
  readonly a: string;
  readonly b: string;
  readonly motivo: "mismo_nombre_y_colonia" | "telefono_difiere_un_digito_mismo_nombre";
}

function nombreClave(n: string | null): string | null {
  if (n === null) return null;
  const k = sinAcentos(n).replace(/[^a-z]+/g, " ").trim();
  // Un nombre de una sola palabra («Juan») no identifica: falso positivo seguro.
  return k.split(" ").length >= 2 ? k : null;
}

function difiereUnDigito(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
  return d === 1;
}

/** Propuestas (NO fusiones) para revision humana. Pares ordenados (a < b) y sin repetir. */
export function proponerDuplicadosPorNombre(clientes: readonly ClienteParaFusion[]): PropuestaDuplicado[] {
  const out = new Map<string, PropuestaDuplicado>();
  const ord = [...clientes].sort((x, y) => x.id.localeCompare(y.id));
  for (let i = 0; i < ord.length; i++)
    for (let j = i + 1; j < ord.length; j++) {
      const x = ord[i]!;
      const y = ord[j]!;
      const kx = clavePorTelefono(x.phone);
      const ky = clavePorTelefono(y.phone);
      if (kx !== null && kx === ky) continue; // mismo telefono: se fusiona, no se propone
      const nx = nombreClave(x.name);
      if (nx === null || nx !== nombreClave(y.name)) continue;
      const colX = x.colonia ? sinAcentos(x.colonia) : null;
      if (colX !== null && colX === (y.colonia ? sinAcentos(y.colonia) : null)) out.set(`${x.id}|${y.id}`, { a: x.id, b: y.id, motivo: "mismo_nombre_y_colonia" });
      else if (kx !== null && ky !== null && difiereUnDigito(kx, ky)) out.set(`${x.id}|${y.id}`, { a: x.id, b: y.id, motivo: "telefono_difiere_un_digito_mismo_nombre" });
    }
  return [...out.values()];
}
