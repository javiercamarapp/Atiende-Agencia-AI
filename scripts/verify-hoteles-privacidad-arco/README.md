# verify-hoteles-privacidad-arco

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-boveda-identidad/`)
de `packages/domain-hoteles/migrations/032_hoteles_consentimiento_arco_incidentes.sql`
(H-02: consentimiento, aviso de privacidad, ARCO, bloqueo previo a la purga, retención legal
por incidente, registro de vulneraciones).

```
scripts/verify-hoteles-privacidad-arco/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-privacidad-arco
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).
Aviso: es verificación técnica de una implementación de decisiones de producto; NO es
asesoría legal (ver "Privacidad: un abogado debe confirmar" en `packages/domain-hoteles/README.md`).

## Qué prueba (103 chequeos del gate, 58 escenarios numerados)

- Aviso de privacidad versionado: solo owner/gm publican (frontdesk, cross-tenant y `anon`
  rechazados); una sola versión vigente; un aviso publicado es inmutable; validaciones de finalidades.
- Ledger de consentimientos: el trigger copia la versión del aviso y sella org/quién/cuándo
  (el cliente no los manda: GRANT de columna); exige TODAS las finalidades obligatorias y solo
  opcionales del aviso; datos sensibles exigen firma/mecanismo de autenticación; cross-tenant
  (huésped, identidad o aviso de otra property); append-only; revocación una sola vez e inmutable.
- Ventana de bloqueo: default 7 días, 3-30 editable solo por owner/gm, con huella de quién y de qué a qué.
- Bloqueo: owner/gm bloquean; la identidad bloqueada pierde el acceso operativo (revelar, verificar,
  solicitar purga); a nivel de datos NI el superusuario purga una identidad activa, una bloqueada con
  ventana vigente o con retención legal activa, ni desbloquea ni reescribe el bloqueo.
- Purga existente por bloqueo: aprobar una purga (doble control) bloquea y deja la solicitud
  `en_bloqueo`; el barrido de sistema bloquea lo vencido y solo purga al vencer la ventana; usuarios
  con `auth.uid()` y `anon` no disparan el barrido.
- Acceso excepcional a identidades bloqueadas: doble control (quien pide no aprueba), un solo uso,
  caduca a las 2 horas, solo quien pidió lo consume; huella en la bitácora.
- Retención legal (legal hold): folio + motivo + autorización; impide purgar mientras dure; al
  liberarla (nota obligatoria) el siguiente barrido purga; ligada a un incidente de la misma property.
- ARCO: plazos (respuesta = recepción + 20 días, ejecución = decisión + 15), prórroga única con
  motivo, transiciones válidas, cancelación procedente bloquea la identidad, solo owner/gm leen y
  operan, sin escritura directa.
- Incidentes: front-of-house reporta, owner/gm gestionan; contener, registrar notificación (solo
  registro, el sistema no envía nada) y cerrar (con riesgo significativo exige notificación o motivo).
- Bitácora de privacidad append-only; `anon` sin acceso a ninguna tabla nueva.
- Base a medio migrar: con tablas (42P01), función (42883) o columnas (42703) ausentes,
  `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` recupera la sesión y el camino anterior sí corre (nunca 25P02).
