# verify-restaurantes-pm-r12-romper-2

Capa **Postgres real** de la ronda 2 del "romper" (R12) del agente de PM (WhatsApp y voz). Solo pruebas: no hay migracion ni se toca la base real.
Las pruebas con modelo simulado y repositorio en memoria viven en `packages/domain-restaurantes/tests/pm-r11-romper/{7,8,9,10,11,12}-ronda-2-*.spec.ts`;
esta carpeta cubre lo que el repositorio en memoria **no puede ver**: el comportamiento real de las funciones de solo-sistema del webhook de WhatsApp
cuando falla la infraestructura (reintentos, duplicados de dos instancias, mensajes fuera de orden, transacciones abortadas).

| Archivo | Que hace |
|---|---|
| `assertions.sql` | El gate (14 escenarios). Lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs` (contrato de 3 archivos). Debe pasar siempre. |
| `hallazgos-abiertos.sql` | Informe `ABIERTO` / `CORREGIDO` de defectos de la capa SQL que siguen abiertos (R12-15: reloj de la base que retrocede). **No** es parte del gate. |
| `run.sh` | `initdb` efimero + migraciones reales + gate + informe de hallazgos abiertos. |

## Que cubre `assertions.sql`

| # | Escenarios | Resultado esperado |
|---|---|---|
| K1-K2 | Transaccion abortada con sub-bloque (SAVEPOINT) y respuesta perdida tras guardar | El pedido siguiente se crea; el reintento con la misma llave devuelve el MISMO pedido. |
| L1-L7 | `claim_whatsapp_message` | Dos instancias: gana una; un mensaje fallido se reclama de nuevo; uno procesado no; un reclamo de mas de 5 min se retoma, de menos no; fuera de orden no se bloquean; entradas absurdas devuelven false sin error. |
| M1-M5 | `claim_whatsapp_conversation` | El lease serializa por telefono, no entre telefonos, se libera al terminar o al vencer; un plazo absurdo se rechaza. |

## Uso

```
TMPDIR=/tmp bash scripts/verify-restaurantes-pm-r12-romper-2/run.sh
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-pm-r12-romper-2
```

Hallazgos de seguridad: este repo es publico. `hallazgos-abiertos.sql` describe la **clase** del problema, no una receta; el cambio minimo propuesto requiere
una migracion y NO se aplica aqui (requiere OK de Javier y aplicarse a la base real por separado).
