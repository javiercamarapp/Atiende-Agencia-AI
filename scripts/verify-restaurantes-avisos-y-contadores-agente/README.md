# verify-restaurantes-avisos-y-contadores-agente

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/043_avisos_idempotentes_y_contadores_agente.sql`
(espejo: `supabase/migrations/20240101000321_043_avisos_idempotentes_y_contadores_agente.sql`), rescate-orig-restaurantes-1 §2.

Cubre `restaurantes.callback_registrar_agente` (solo sistema) y las columnas/indices nuevos de `restaurantes.callback_requests` (parte A, escenarios A/S/C), y
`restaurantes.whatsapp_contador_agente` con `whatsapp_conversations.agent_counters` (parte B, escenarios K: contadores de "no entiendo" y "colonia no reconocida"):

- Positivo: aviso nuevo; el mismo id de evento 3 veces -> 1 aviso; 3 mensajes distintos con el mismo motivo -> 1 aviso abierto con 2 notas
  agregadas; reenvio de un evento ya agregado como nota -> no repite la nota; dos motivos distintos -> 2 avisos; mismo id de evento en otra
  organizacion -> permitido (el indice unico es por organizacion).
- Negativo: un aviso resuelto o fuera de la ventana no absorbe uno nuevo; otro canal -> otro aviso; el tope de 4000 caracteres de `message`.
- Seguridad: staff autenticado (`auth.uid()` no nulo) -> 42501; `anon` -> 42501; sucursal de otra organizacion -> 42501; canal y ventana
  invalidos -> 22023; `authenticated` no puede insertar `callback_requests` directamente; el indice unico rechaza un duplicado.
- Compatibilidad: filas historicas sin `source_event_id` se pueden repetir (el camino anterior, base sin migrar, sigue insertando igual).

- Manual: `scripts/verify-restaurantes-avisos-y-contadores-agente/run.sh`.
- CI: lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de archivos que los demas `verify-*`).
