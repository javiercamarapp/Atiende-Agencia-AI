# verify-hoteles-whatsapp-retry-cap

Verificación, contra un Postgres **real**, de
`packages/domain-hoteles/migrations/027_whatsapp_retry_cap.sql`: cierra el hueco de
Fase 2 (integridad) — "los reintentos de WhatsApp entrante no tienen tope, y cada
reintento de Meta vuelve a gastar un turno de LLM". `hoteles.claim_whatsapp_message`
re-reclamaba SIEMPRE un mensaje en estado `'failed'`, sin importar cuántas veces ya
se había intentado — Meta reintenta un webhook con 5xx/429 durante días, y cada
reintento volvía a correr `turnHandler.handleInboundMessage` de punta a punta
(llamada real al LLM, gasto real), sin que el huésped recibiera jamás una respuesta
si la causa del fallo era persistente.

## Qué demuestra (9 escenarios)

1. **Sesión de sistema real.** Un caller con `auth.uid()` NO nulo (staff
   autenticado real) es rechazado — este RPC es solo para el webhook (verificación
   sin cambios de esta migración, confirmada de todos modos).
2. **Intentos dentro del tope siguen reclamando.** `attempts=1` y `attempts=4`
   (`MAX=5`), ambos en `'failed'`, reclaman con normalidad — comportamiento
   IDÉNTICO al de hoy, nunca una regresión que bloquee un reintento legítimo
   temprano. El intento que lleva `attempts` de 4 a 5 (el último permitido) también
   reclama.
3. **El intento que agotaría el tope (`attempts=5`, `'failed'`) YA NO reclama** —
   `false`, sin lanzar ninguna excepción.
4. **Transición explícita a estado terminal.** Al agotar el tope, la fila pasa a
   `'attempts_exhausted'` (agregado al `CHECK` de `status` en esta misma
   migración) — nunca se queda "silenciosamente" en `'failed'`, indistinguible de
   "todavía reintentable".
5. **El estado terminal es real y para siempre.** Un mensaje ya
   `'attempts_exhausted'` nunca vuelve a reclamarse, por más reintentos que lleguen.
6. **Un mensaje `'processed'` nunca se toca** — ni se reclama de nuevo, ni se
   transiciona a `'attempts_exhausted'` (esa transición exige `status = 'failed'`).
7. **Aislamiento cross-tenant.** Un caller con la `property_id` de OTRA property
   para un `message_id` que ya pertenece a la primera no lo reclama y TAMPOCO
   transiciona la fila real — la transición exige `property_id = p_property_id`
   del CALLER, no solo la del mensaje ya guardado.
8. **Esquema de producción a medio migrar (esta migración NO aplicada).** La
   versión ANTERIOR real de la función — byte-idéntica a
   `017_rpc_anti_duplicado_authenticated_grants.sql`, recreada dentro de una
   transacción revertida al final (DDL transaccional) — reclama SIEMPRE un mensaje
   `'failed'` sin importar `attempts`: la prueba reproducible de que el bug era
   real, y de que `PostgresHotelesRepository.claimWhatsAppMessage` (misma firma
   exacta) sigue funcionando contra ese esquema viejo sin ningún error de "función
   no existe" — este fix nunca necesitó ningún catch de SQLSTATE 42883/42P01/42703
   en TypeScript porque el nombre/parámetros/tipo de retorno de la función nunca
   cambiaron.

El efecto complementario — que el N-ésimo intento (el que ya no reclama) tampoco
vuelve a invocar `turnHandler.handleInboundMessage` (el LLM) del lado de
TypeScript — se verifica por separado con `AbortAwareFakeSession` en
`packages/domain-hoteles/tests/whatsapp-retry-cap.spec.ts` (esa capa nunca toca
Postgres real, así que no puede probar el tope en sí, solo el efecto en
`handleInboundWhatsAppMessage`).

Cada escenario corre en su propio `begin; ... rollback;`, autocontenido: siembra
directo (INSERT, como el superusuario que corre el script) el `attempts`/`status`
que necesita, en vez de encadenar `commit`s entre escenarios — el gate automático
de `scripts/verify-real-postgres-ci/run-gate.mjs` solo reconoce bloques que
terminan en `rollback;`.

## Cómo correrlo

- Manual, contra un Postgres local efímero (requiere `initdb`/`pg_ctl`/`psql` en
  PATH): `scripts/verify-hoteles-whatsapp-retry-cap/run.sh`
- Automático en CI, contra el Postgres del workflow:
  `node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-whatsapp-retry-cap`
  (o sin argumento, que descubre este directorio junto con todos los demás
  `scripts/verify-*/`).
