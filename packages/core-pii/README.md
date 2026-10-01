# @atiende/core-pii

Fuente UNICA de patrones y helpers de scrub de PII y secretos del monorepo (PL-10). Pura y
sin I/O (salvo `instalarScrubEnConsola`, que envuelve el `console` recibido).

| Pieza | Para que |
| --- | --- |
| `PATRONES_SCRUB`, `PATRON_TARJETA`, `PATRON_CVV`, `PATRON_VENCIMIENTO`, `CLAVE_SENSIBLE` | los patrones (un solo lugar donde agregar o ajustar uno) |
| `scrubTexto(texto, { maxLargo?, preservarUuid? })` | texto libre: correos, telefonos, tarjetas, JWT, bearer, llaves con prefijo, URIs con credenciales, `clave=valor` sensible, tokens largos |
| `scrubValor(valor, opciones)` / `scrubError(err)` | objetos/arrays/Errors con topes de profundidad y tamano; claves sensibles se redactan sin mirar el valor |
| `OPCIONES_LOGS` | preset para logs: UUID intactos, errores con `code`/`detail` redactados, numeros conservados |
| `redactarDatosDePago(texto)` | tarjeta/CVV/vencimiento de un mensaje de cliente ANTES de persistirlo (WhatsApp de citas, hoteles y restaurantes) |
| `instalarScrubEnConsola()` | envuelve `console.log/info/warn/error/debug`: ninguna salida del proceso sale sin scrub; una linea JSON se redacta de forma estructural |

Consumidores: `apps/api/src/logger.ts` (`logEvent`), `apps/api/src/app.ts` (el `onError` loguea por
`logEvent`), `apps/api/src/vercel.ts` (instala el scrub en la consola), `apps/api/src/alertas/
redaccion.ts` (alertas salientes) y `redactSensitiveInfo` de domain-citas/hoteles/restaurantes.

Los patrones son deliberadamente conservadores hacia redactar de mas. Un UUID se conserva solo con
`preservarUuid` (logs); en alertas se sigue tratando como cadena larga.
