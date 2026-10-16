# verify-restaurantes-pm-r11-romper

Capa **Postgres real** de la ronda "romper" (R11) del agente de PM (WhatsApp y voz). Solo pruebas (la migracion 089 de defensa en profundidad vive en `packages/domain-restaurantes/migrations/`; nunca se aplica a la base real desde aqui).
Las pruebas con modelo simulado y repositorio en memoria viven en `packages/domain-restaurantes/tests/pm-r11-romper/`; esta carpeta cubre lo
que el repositorio en memoria **no puede ver**: lo que `jsonb` acepta, RLS / GRANT / `auth.uid()` reales y las RPC de solo-sistema.

| Archivo | Que hace |
|---|---|
| `assertions.sql` | El gate (O12-O22 cubren la migracion 089). Lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs` (contrato de 3 archivos). Debe pasar siempre. |
| `hallazgos-abiertos.sql` | Informe `ABIERTO` / `CORREGIDO` de defectos de la capa SQL que siguen abiertos (hoy solo R11-13b; R11-13, R11-15 y R11-16 los corrige la migracion 089). **No** es parte del gate. |
| `run.sh` | `initdb` efimero + migraciones reales + gate + informe de hallazgos abiertos. |

## Que cubre `assertions.sql`

| # | Escenarios | Resultado esperado |
|---|---|---|
| K1-K7 | (R12, `entradas-contra-pg.mjs`, lo corre run.sh) El texto que PRODUCE el codigo TypeScript real de entrada (`limitarLargoDelMensaje`) para NUL, controles, emoji cortado a media y un mensaje enorme cabe en `whatsapp_append_turn`: R11-08/09 corregidos. |
| P1-P2 | (R12, migracion 088) Las partes de una respuesta larga encoladas en UNA transaccion (12 partes + el aviso de botones) salen de `claim_messaging_outbox_batch(1, ...)` exactamente en el orden en que se encolaron; re-encolar la misma llave no crea fila nueva. Sin la 088 P1 falla (el desempate era el uuid al azar). **La 088 requiere aplicarse a la base real con OK de Javier.** |
| J1-J4 | Un NUL (U+0000) o un sustituto UTF-16 suelto en un mensaje del cliente | `whatsapp_append_turn` falla con 22P05 / 22P02: es la **evidencia** de R11-08 y R11-09 (el TypeScript hoy puede mandarlos). Un emoji completo si se guarda; el error dentro de un sub-bloque no deja la sesion inservible. |
| O1-O11 | `create_order_idempotent` | Solo sistema (42501 con `auth.uid`), huella/llave mal formada, misma llave en dos organizaciones = dos pedidos, llave reutilizada con otro contenido = `PT409`, doble envio = mismo pedido, huella igual en otra organizacion no colapsa, programado en el pasado = 22023, CHECK de `source` y `propina`, desbordamiento numerico, `order_count` sube una vez. |
| R1-R7 | Aislamiento entre organizaciones | El owner de B no ve pedidos / clientes / conversaciones / avisos de A; `anon` sin SELECT; las funciones de solo-sistema (`whatsapp_append_turn`, `claim_whatsapp_message`, `callback_registrar_agente`) no las llama un usuario; el mismo telefono en dos organizaciones guarda conversaciones separadas. |
| C1-C2 | Avisos del agente | Idempotentes por evento y motivo; la misma llave de evento en dos organizaciones no se pisa. |

## Uso

```
TMPDIR=/tmp bash scripts/verify-restaurantes-pm-r11-romper/run.sh        # local: initdb/pg_ctl efimeros (el socket de Postgres tiene tope de 103 caracteres)
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-pm-r11-romper   # solo el gate, contra un Postgres ya corriendo (PGHOST/PGPORT/PGUSER)
```

Hallazgos de seguridad: este repo es publico. `hallazgos-abiertos.sql` describe la **clase** del problema (la funcion acepta datos que el TypeScript nunca
manda), no una receta; el arreglo propuesto esta en `RONDA-11-ROMPER.md` (fuera del repo).
