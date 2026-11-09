// Resumen seguro para logs de una respuesta de error de Resend (`POST /emails`).
//
// El cuerpo de error de Resend es `{ statusCode, name, message }`; `message` puede repetir lo que se le mandó
// (destinatarios, asunto, fragmentos del contenido o de un enlace de acceso), y un proxy intermedio puede devolver
// HTML con cualquier cosa. A los logs solo llegan el estado HTTP y `name`, que en Resend es un identificador fijo
// (`validation_error`, `rate_limit_exceeded`, `invalid_idempotent_request`…); si `name` no tiene esa forma, o el
// cuerpo no es JSON, se registra "desconocido". Nunca se devuelve el cuerpo ni `message`.
export interface ErrorResendResumido {
  readonly status: number;
  readonly codigo: string;
}

const CODIGO_RESEND = /^[a-z][a-z0-9_]{0,63}$/;

export function resumirErrorResend(status: number, cuerpo: string): ErrorResendResumido {
  let codigo = "desconocido";
  try {
    const parsed: unknown = JSON.parse(cuerpo);
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === "string" && CODIGO_RESEND.test(name)) codigo = name;
    }
  } catch {
    // cuerpo no JSON: se queda en "desconocido"
  }
  return { status, codigo };
}
