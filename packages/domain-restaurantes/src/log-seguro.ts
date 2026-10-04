// Errores de Postgres a los logs SIN datos personales (QA R1 seguridad-12).
//
// El objeto de error de `pg` trae `detail` (p. ej. "Key (customer_phone)=(...) already exists" o la fila completa de una violacion de
// restriccion), `where`, `routine` y el SQL: pasarlo tal cual a `console.error` manda telefonos y nombres al proveedor de logs. Los
// intentos best-effort solo necesitan saber QUE fallo, asi que se registra unicamente el nombre del error y su SQLSTATE.
export function describirErrorSeguro(err: unknown): string {
  if (err === null || err === undefined) return "error desconocido";
  if (typeof err !== "object") return `error no estandar (${typeof err})`;
  const name = (err as { name?: unknown }).name;
  const code = (err as { code?: unknown }).code;
  const nombre = typeof name === "string" && name.length > 0 && name.length <= 80 ? name : "Error";
  const sqlstate = typeof code === "string" && /^[0-9A-Za-z_]{1,10}$/.test(code) ? code : null;
  return sqlstate ? `${nombre} code=${sqlstate}` : nombre;
}
