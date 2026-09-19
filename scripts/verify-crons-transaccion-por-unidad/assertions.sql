-- verify-crons-transaccion-por-unidad — demuestra, contra Postgres REAL (nunca el
-- repositorio en memoria, que no es transaccional -- ver auditoria-a1b-resultado.json
-- hallazgo #1 punto 7), el MECANISMO EXACTO detrás del hallazgo de auditoría a1b
-- #1 (ALTA)/#2 (MEDIA) que este PR corrige en TypeScript
-- (apps/worker/src/jobs/{hoteles/night-audit,despachos/cobranza-reminders,
-- licitaciones/alert-notifications}.ts + los 2 crons más listados en el cuerpo del
-- PR): "una sola transacción compartida para TODAS las unidades de un barrido +
-- try/catch POR unidad sin SAVEPOINT" hace que un error SQL real en UNA unidad
-- revierta en silencio el trabajo de TODAS -- incluidas las que ya habían
-- 'cerrado bien' -- porque `COMMIT` sobre una transacción ABORTADA (Postgres
-- 25P02) devuelve el tag `ROLLBACK` SIN LANZAR (comportamiento documentado de
-- Postgres, reproducido idéntico por el driver `pg` que usa
-- packages/db/src/managed-postgres-engine.ts).
--
-- Este script NO depende de ninguna migración de negocio (hoteles/despachos/
-- licitaciones) -- el mecanismo que prueba es una propiedad de Postgres/del
-- patrón de transacciones, no de una tabla de vertical concreta. Usa el schema
-- `demo` de bootstrap.sql (una sola tabla, `demo.unit_result`) para poder
-- comparar, dentro de la MISMA base efímera, el patrón "antes" (1 transacción
-- para 3 unidades A/B/C, B falla) contra el patrón "después" (1 transacción POR
-- unidad).
--
-- Convención de este archivo (misma que scripts/verify-outbox-grants/
-- assertions.sql, leído primero como plantilla, y que scripts/verify-real-postgres-ci/
-- run-gate.mjs ya sabe parsear automáticamente): cada escenario vive en su propio
-- bloque `begin;\n...\nrollback;` en columna 0, ejecutado como su PROPIA conexión
-- psql. Un alias `..._deberia_ser_N` verifica un conteo exacto.
--
-- NOTA TÉCNICA (léase antes de tocar este archivo): los escenarios 1 y 3
-- necesitan que un ERROR SQL REAL (`select 1/0`) NO detenga la conexión psql a
-- mitad de camino -- exactamente como el driver `pg` nunca aborta el proceso
-- Node por un error de sentencia, solo relanza la excepción hacia el `catch` de
-- JS (que es precisamente lo que el código de aplicación captura POR unidad).
-- `scripts/verify-real-postgres-ci/run-gate.mjs` invoca cada bloque con
-- `psql -v ON_ERROR_STOP=1`, así que este archivo desactiva esa bandera CON
-- `\set ON_ERROR_STOP off` justo antes de la sentencia que debe fallar SIN
-- detener el resto del bloque, y la reactiva inmediatamente después. Dentro de
-- un bloque, cualquier `ROLLBACK;`/`COMMIT;` de una transacción INTERNA (no la
-- del bloque completo) se escribe en MAYÚSCULAS a propósito: el parser de
-- run-gate.mjs busca el patrón exacto `\nrollback;` (minúsculas) para encontrar
-- el CIERRE del bloque -- un `rollback;` en minúsculas a mitad de un escenario
-- cortaría el bloque ahí mismo. Ver el escenario 3 para el caso real.

\echo 'escenario 1: ANTES del fix (patron reconstruido) -- una sola transaccion para 3 unidades (A, B, C); B dispara un error SQL real -- la transaccion queda ABORTADA, C falla en cascada con el error de B (25P02), y el COMMIT final -- sobre una transaccion abortada -- devuelve ROLLBACK SIN LANZAR: se pierde A, que YA habia "cerrado bien"'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- Unidad A -- "cierra bien" (equivalente a night-audit posteando el cargo de
-- una property, o cobranza-reminders encolando el correo de una organización).
insert into demo.unit_result (unit_id, sesion) values ('A', 'antes');
-- El código de aplicación (JS) envuelve el barrido ENTERO de A/B/C en la MISMA
-- transacción (una sola `withAppSession`), con try/catch SOLO por unidad --
-- nunca relanza fuera del loop. Para que la unidad B dispare un error SQL REAL
-- (P0001/57014/40P01 en el hallazgo real) SIN que psql aborte el resto de este
-- bloque (que sigue representando la MISMA conexión/transacción que un driver
-- `pg` real nunca cierra por su cuenta), se desactiva ON_ERROR_STOP.
\set ON_ERROR_STOP off
select 1/0; -- Unidad B: error SQL real -- ABORTA la transacción a nivel Postgres.
-- Unidad C: cualquier sentencia posterior en la MISMA transacción falla con
-- 25P02 ("current transaction is aborted, commands ignored until end of
-- transaction block") -- el error ENGAÑOSO que documenta la auditoría: C nunca
-- ve SU error real, solo el contagio del aborto de B.
insert into demo.unit_result (unit_id, sesion) values ('C', 'antes');
\set ON_ERROR_STOP on
-- El código de aplicación NUNCA vio una excepción sin capturar (el catch por
-- unidad se tragó tanto el error de B como el 25P02 de C) -- así que llega
-- aquí e intenta el COMMIT final, EXACTO como
-- managed-postgres-engine.ts::withAppSession. Sobre una transacción abortada,
-- Postgres NO lanza: procesa un ROLLBACK real y devuelve ese tag.
commit;
rollback;

\echo 'escenario 2: verificacion del escenario 1 -- tras el COMMIT-que-devolvio-ROLLBACK, CERO filas de la sesion "antes" persisten (ni A, que "ya habia cerrado bien", ni C)'
begin;
select count(*) as antes_persistidas_deberia_ser_0 from demo.unit_result where sesion = 'antes';
rollback;

\echo 'escenario 3: DESPUES del fix (codigo real de este PR) -- 3 transacciones SEPARADAS, una POR unidad; B falla en la SUYA -- A y C SI persisten, cada una con su propio COMMIT real ya confirmado ANTES de que B siquiera empiece'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into demo.unit_result (unit_id, sesion) values ('A', 'despues');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
\set ON_ERROR_STOP off
select 1/0; -- Unidad B: el MISMO error SQL real, pero ahora en SU PROPIA transacción.
\set ON_ERROR_STOP on
-- ROLLBACK real y EXPLÍCITO de SOLO la transacción de B -- exactamente lo que
-- hace `managed-postgres-engine.ts::withAppSession` en su `catch`. En
-- MAYÚSCULAS a propósito (ver nota técnica de cabecera): esta NO es la
-- sentencia que cierra el bloque para el parser del gate.
ROLLBACK;
-- Unidad C arranca su PROPIA transacción nueva -- nunca ve el aborto de B (a
-- diferencia del escenario 1, donde compartían la misma).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into demo.unit_result (unit_id, sesion) values ('C', 'despues');
commit;
rollback;

\echo 'escenario 4: verificacion del escenario 3 -- A y C SI persisten (2 filas), B no dejo ninguna -- el resultado real coincide con lo que el barrido reportaria (A:ok, B:fallo, C:ok), a diferencia del escenario 1/2 donde el resultado reportado MENTIA'
begin;
select count(*) as despues_persistidas_deberia_ser_2 from demo.unit_result where sesion = 'despues';
rollback;

\echo 'escenario 5: control -- la unidad B especificamente NUNCA persistio en NINGUNO de los 2 patrones (ni antes ni despues), consistente con que SU sentencia siempre fue la que fallo'
begin;
select count(*) as b_nunca_persiste_deberia_ser_0 from demo.unit_result where unit_id = 'B';
rollback;

\echo 'listo -- los escenarios 2/4/5 deben terminar en el conteo exacto que indica su alias; 1 y 3 solo deben completar sin error (ambos representan un barrido real que aisla sus fallos por catch/rollback, nunca un error sin capturar).'
