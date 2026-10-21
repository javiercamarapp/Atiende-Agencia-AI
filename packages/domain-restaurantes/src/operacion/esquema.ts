// Mini-biblioteca de esquemas para los contratos del panel del operador (`contratos.ts`).
//
// Por que existe: el repo no depende de zod (ni de ninguna libreria de esquemas) y agregar una dependencia nueva a un
// monorepo publico solo para un andamiaje cambia el lockfile de todos. Esto cubre lo que los contratos necesitan: validar en
// RUNTIME un cuerpo desconocido (`unknown`) y deducir el tipo TypeScript del mismo esquema, con errores por campo en espanol.
// Es PURO (sin imports ni efectos): lo pueden importar la API, el dominio, la SPA (`@atiende/domain-restaurantes/operacion`)
// y la API simulada de e2e para validar sus respuestas contra el mismo contrato.

export interface ErrorEsquema {
  /** Ruta del campo con puntos e indices (`items[0].cantidad`); `""` = la raiz. */
  readonly campo: string;
  readonly mensaje: string;
}

export type Resultado<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly errores: readonly ErrorEsquema[] };

export interface Esquema<T> {
  /** Valida `valor`; nunca lanza. Un objeto desconocido con claves de mas se acepta y esas claves se descartan. */
  readonly validar: (valor: unknown, ruta?: string) => Resultado<T>;
  /** Marca interna de un campo que puede faltar en un objeto (`opcional`). */
  readonly esOpcional?: true;
}

export type Inferir<E> = E extends Esquema<infer T> ? T : never;

function bien<T>(valor: T): Resultado<T> {
  return { ok: true, valor };
}
function mal(campo: string, mensaje: string): Resultado<never> {
  return { ok: false, errores: [{ campo, mensaje }] };
}

export function texto(opc: { readonly min?: number; readonly max?: number; readonly patron?: RegExp; readonly descripcion?: string } = {}): Esquema<string> {
  return {
    validar(v, ruta = "") {
      if (typeof v !== "string") return mal(ruta, "se esperaba texto.");
      if (opc.min !== undefined && v.length < opc.min) return mal(ruta, opc.min === 1 ? "no puede ir vacio." : `debe tener al menos ${opc.min} caracteres.`);
      if (opc.max !== undefined && v.length > opc.max) return mal(ruta, `debe tener como maximo ${opc.max} caracteres.`);
      if (opc.patron && !opc.patron.test(v)) return mal(ruta, opc.descripcion ?? "formato no valido.");
      return bien(v);
    },
  };
}

export function numero(opc: { readonly min?: number; readonly max?: number; readonly entero?: boolean } = {}): Esquema<number> {
  return {
    validar(v, ruta = "") {
      if (typeof v !== "number" || !Number.isFinite(v)) return mal(ruta, "se esperaba un numero.");
      if (opc.entero && !Number.isInteger(v)) return mal(ruta, "se esperaba un numero entero.");
      if (opc.min !== undefined && v < opc.min) return mal(ruta, `debe ser al menos ${opc.min}.`);
      if (opc.max !== undefined && v > opc.max) return mal(ruta, `debe ser como maximo ${opc.max}.`);
      return bien(v);
    },
  };
}

export function booleano(): Esquema<boolean> {
  return { validar: (v, ruta = "") => (typeof v === "boolean" ? bien(v) : mal(ruta, "se esperaba verdadero o falso.")) };
}

export function enumerado<const V extends readonly [string, ...string[]]>(valores: V): Esquema<V[number]> {
  return {
    validar: (v, ruta = "") => (typeof v === "string" && (valores as readonly string[]).includes(v) ? bien(v as V[number]) : mal(ruta, `debe ser uno de: ${valores.join(", ")}.`)),
  };
}

/** Texto ISO 8601 con fecha y hora (lo que produce `Date#toISOString`, con o sin milisegundos y con zona). */
export function fechaIso(): Esquema<string> {
  const base = texto({ min: 20, max: 40, patron: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/, descripcion: "se esperaba una fecha ISO 8601 con hora y zona." });
  return {
    validar(v, ruta = "") {
      const r = base.validar(v, ruta);
      if (!r.ok) return r;
      return Number.isNaN(Date.parse(r.valor)) ? mal(ruta, "fecha inexistente.") : r;
    },
  };
}

export function uuid(): Esquema<string> {
  return texto({ patron: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, descripcion: "se esperaba un UUID." });
}

export function arreglo<T>(item: Esquema<T>, opc: { readonly min?: number; readonly max?: number } = {}): Esquema<T[]> {
  return {
    validar(v, ruta = "") {
      if (!Array.isArray(v)) return mal(ruta, "se esperaba una lista.");
      if (opc.min !== undefined && v.length < opc.min) return mal(ruta, `debe traer al menos ${opc.min} elemento(s).`);
      if (opc.max !== undefined && v.length > opc.max) return mal(ruta, `debe traer como maximo ${opc.max} elemento(s).`);
      const salida: T[] = [];
      const errores: ErrorEsquema[] = [];
      v.forEach((el, i) => {
        const r = item.validar(el, `${ruta}[${i}]`);
        if (r.ok) salida.push(r.valor);
        else errores.push(...r.errores);
      });
      return errores.length > 0 ? { ok: false, errores } : bien(salida);
    },
  };
}

/** Acepta `null` ademas de lo que acepte `e`. */
export function nulable<T>(e: Esquema<T>): Esquema<T | null> {
  return { validar: (v, ruta = "") => (v === null ? bien(null) : e.validar(v, ruta)) };
}

/** Campo que puede faltar (o venir `undefined`) en un objeto; si viene, se valida con `e`. */
export function opcional<T>(e: Esquema<T>): Esquema<T | undefined> & { readonly esOpcional: true } {
  return { esOpcional: true, validar: (v, ruta = "") => (v === undefined ? bien(undefined) : e.validar(v, ruta)) };
}

type Forma = Record<string, Esquema<unknown>>;
type ClavesOpcionales<F extends Forma> = { [K in keyof F]: F[K] extends { readonly esOpcional: true } ? K : never }[keyof F];
type Obligatorias<F extends Forma> = { [K in Exclude<keyof F, ClavesOpcionales<F>>]: Inferir<F[K]> };
type Opcionales<F extends Forma> = { [K in ClavesOpcionales<F>]?: Exclude<Inferir<F[K]>, undefined> };
export type DeObjeto<F extends Forma> = Obligatorias<F> & Opcionales<F>;

export function objeto<F extends Forma>(forma: F): Esquema<{ [K in keyof DeObjeto<F>]: DeObjeto<F>[K] }> {
  return {
    validar(v, ruta = "") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return mal(ruta, "se esperaba un objeto.");
      const entrada = v as Record<string, unknown>;
      const salida: Record<string, unknown> = {};
      const errores: ErrorEsquema[] = [];
      for (const [clave, esquema] of Object.entries(forma)) {
        const sub = ruta === "" ? clave : `${ruta}.${clave}`;
        if (entrada[clave] === undefined && !esquema.esOpcional) {
          errores.push({ campo: sub, mensaje: "es obligatorio." });
          continue;
        }
        const r = esquema.validar(entrada[clave], sub);
        if (!r.ok) errores.push(...r.errores);
        else if (r.valor !== undefined) salida[clave] = r.valor;
      }
      return errores.length > 0 ? { ok: false, errores } : bien(salida as { [K in keyof DeObjeto<F>]: DeObjeto<F>[K] });
    },
  };
}

/** Mapa de texto a valor (llaves libres), p. ej. `porEstado`. */
export function registro<T>(valor: Esquema<T>): Esquema<Record<string, T>> {
  return {
    validar(v, ruta = "") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return mal(ruta, "se esperaba un objeto.");
      const salida: Record<string, T> = {};
      const errores: ErrorEsquema[] = [];
      for (const [k, el] of Object.entries(v)) {
        const r = valor.validar(el, ruta === "" ? k : `${ruta}.${k}`);
        if (r.ok) salida[k] = r.valor;
        else errores.push(...r.errores);
      }
      return errores.length > 0 ? { ok: false, errores } : bien(salida);
    },
  };
}

/** Texto de los errores para un mensaje de API: `campo: mensaje; campo: mensaje`. */
export function describirErrores(errores: readonly ErrorEsquema[]): string {
  return errores.map((e) => (e.campo === "" ? e.mensaje : `${e.campo}: ${e.mensaje}`)).join("; ");
}
