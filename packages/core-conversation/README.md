# @atiende/core-conversation

Defensa contra el bug más caro identificado en la fusión: doble-booking en
hoteles/restaurantes/citas-reservaciones cuando llegan 2 mensajes casi
simultáneos del mismo cliente sobre la misma reserva/pedido.

## 3 piezas

1. **Lock distribuido** (`src/lock/`) — serializa el procesamiento de
   mensajes concurrentes del mismo `(tenantId, customerKey)`. Portado de
   `atiende.ai/src/lib/whatsapp/conversation-lock.ts` (algoritmo SET NX EX +
   Lua atómico para release/extend, fail-open sin Redis). `RedisLockStore` es
   el adaptador de producción; `InMemoryLockStore` serializa de verdad
   dentro de un proceso (tests, single-worker).
2. **Memoria de estado inyectada al prompt** (`src/prompt-context.ts`) —
   convierte el estado/contexto persistido de la conversación en el bloque
   de texto que se inyecta al system prompt del LLM, para que el agente sepa
   qué ya se decidió en este flow.
3. **Máquina de estados atómica** (`src/state/`) — escritura por
   compare-and-swap (`version`): una transición inválida se rechaza (tabla
   `DEFAULT_BOOKING_TRANSITIONS`) y nunca se aplica parcialmente. Extiende el
   patrón real de `atiende.ai/supabase/migrations/set_conversation_state_rpc.sql`
   (jsonb_set vía RPC) agregando CAS explícito — ver
   `migrations/001_conversation_state_cas.sql`.

`src/guard.ts` (`withConversationLock`) junta las tres piezas: es el wrapper
que el pipeline de mensajes entrantes (WhatsApp, web chat, etc.) usa
alrededor de cada mensaje.

## Fuentes reales portadas

- `~/GitHub-repos-backup/atiende.ai/atiende-ai/src/lib/whatsapp/conversation-lock.ts`
- `~/GitHub-repos-backup/atiende.ai/atiende-ai/src/lib/actions/state-machine.ts`
- `~/GitHub-repos-backup/atiende.ai/atiende-ai/supabase/migrations/set_conversation_state_rpc.sql`
- Tests de referencia:
  `~/GitHub-repos-backup/atiende.ai/atiende-ai/src/lib/whatsapp/__tests__/conversation-lock.test.ts`,
  `~/GitHub-repos-backup/atiende.ai/atiende-ai/src/lib/actions/__tests__/state-machine.test.ts`

## Qué es nuevo vs. el original

atiende.ai NO valida transiciones (cualquier handler puede setear cualquier
`state` libremente) ni tiene CAS por versión en el RPC (confía en que el
lock de conversación ya serializó todo). `core-conversation` agrega ambas
cosas como defensa en profundidad — ver comentarios en
`src/state/transitions.ts`, `src/state/state-machine.ts` y la migración SQL.
