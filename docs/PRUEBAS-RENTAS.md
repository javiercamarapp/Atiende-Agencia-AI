# Pruebas adversariales, de concurrencia y de carga de rentas

Protegen las dos promesas centrales del producto: **cero overbooking** y **el feed del cliente no abre la red interna**. (Paridad3, Rn-P3-11 a Rn-P3-14 y Rn-P3-29.)

## Como correrlas

| Que | Comando | Donde corre |
|---|---|---|
| Adversariales de dominio (SSRF, catalogo de 20 casos de sync) y XSS web | `npm run test:adversarial:rentas` | `npm run test:unit` en CI (sin red real) |
| Concurrencia real con N conexiones | `bash scripts/verify-rentas-concurrencia/run.sh` | CI: job `rentas-concurrencia-gate` de `postgres-real-gate.yml` |
| Zona horaria con ocupaciones vigentes (SQL) | `scripts/verify-rentas-operar-tenant-nuevo` (escenarios 39 a 39e) | gate `postgres-real-gate` (auto-descubierto) |
| Carga | `npm run load:rentas` (N reducido) o `npm run load:rentas -- --completo` | **manual o nocturno, fuera de CI** |

La carga levanta su propio Postgres efimero (`initdb` + `pg_ctl`). No la corras en paralelo con otros procesos pesados: con N completo abre decenas de conexiones.
Hardware de la corrida de referencia (N reducido): Apple M3, 8 nucleos, 24 GiB, Node 26.
Sin SLO publicado (regla del original, §Plan-1): se reportan p50/p95/p99 y la carga solo falla si se rompe un invariante.

## Catalogo de 20 casos (ACEPTACION §Calendario-2)

Archivo: `packages/domain-rentas/tests/adversarial/sync-catalogo-20-casos.adversarial.spec.ts`. Cada caso es un `describe` con su nombre.

| # | Describe | Estado |
|---|---|---|
| 1 | `caso-01-doble-evento` | cubierto |
| 2 | `caso-02-reserva-simultanea-dos-canales` | cubierto |
| 3 | `caso-03-eventos-desordenados` | cubierto |
| 4 | `caso-04-modificacion-de-fechas` | cubierto |
| 5 | `caso-05-cancelacion-no-reabre-noches-ocupadas-por-otra-causa` | cubierto |
| 6 | `caso-06-timeout-tras-exito-remoto` | cubierto |
| 7 | `caso-07-reintento-de-import-ya-procesado` | cubierto |
| 8 | `caso-08-ack-perdido` | cubierto |
| 9 | `caso-09-feed-malformado` | cubierto |
| 10 | `caso-10-feed-vacio` | cubierto |
| 11 | `caso-11-feed-inaccesible` | cubierto |
| 12 | `caso-12-bloqueo-manual-superpuesto-con-import` | cubierto |
| 13 | `caso-13-uid-reciclado` | cubierto (con y sin SEQUENCE) |
| 14 | `caso-14-dst-madrid-y-nueva-york-2027` | cubierto (6 variantes: UTC y TZID, salto y retroceso) |
| 15 | `caso-15-estancias-contiguas` | cubierto |
| 16 | `caso-16-crash-y-replay-a-mitad-de-batch` | cubierto |
| 17 | `caso-17-limites-de-api-http-429` | cubierto |
| 18 | `caso-18-aislamiento-multitenant` | dominio cubierto; el cruce por HTTP/RLS esta `test.skip` con motivo: `apps/api/tests/rentas-*.spec.ts` y `scripts/verify-rentas-cron-rls` |
| 19 | `caso-19-escalada-de-privilegios` | `test.skip` con motivo: `apps/api/tests/rentas-reservas.spec.ts`, `rentas-bloqueos.spec.ts`, `packages/domain-rentas/tests/roles.spec.ts` |
| 20 | `caso-20-ssrf` | cubierto aqui y a fondo en `ssrf.adversarial.spec.ts` |

Ademas del catalogo: regresiones D-DSD-04 (rebote anti-eco entre dos canales), D-DSD-10 (vacio sin historial), D-DSD-12 (bookkeeping perdido), feed HTML disfrazado y feed truncado.

## Otras suites

- `ssrf.adversarial.spec.ts`: IPv6 mapeada (dotted, hex, mayusculas, expandida, con corchetes), NAT64 `64:ff9b::`, IPv4-compatible, bordes de 10/8, 172.16/12 y 192.168/16, `file:`/`ftp:`/`data:`, `user:pass@`, loopback sin modo simulador, redirect al segundo salto hacia IP interna (revalidado), tope de 5 MiB, timeout TOTAL con servidor lento, bomba de VEVENT, linea infinita.
- `apps/web/tests/rentas-xss-mensajeria.spec.tsx`: HTML/JS del huesped se muestra como texto en Aprobaciones (borradores, nombre, motivo de rechazo).
- `apps/web/tests/rentas-calendario-cancelar-canal.spec.tsx` y `apps/api/tests/rentas-reservas.spec.ts`: Rn-P3-29 (no se cancela una reserva de canal).

## Hallazgos de estas suites

| Id | Hallazgo | Estado |
|---|---|---|
| Rn-P3-29 | La API cancelaba reservas importadas de Airbnb/Booking/Vrbo (las noches quedaban libres con la reserva viva en el canal) | corregido en este PR (API + UI) |
| Rn-P3-11 / D-DSD-07 | Se podia cambiar la zona horaria con ocupaciones vigentes | corregido: migracion 032 |
| SSRF | La deny-list aprobaba una cadena con puntos que no era IPv4 valida (`999.1.1.1`, `1.2.3`) | corregido (fail-closed), defensa en profundidad |
| #436 | `core.accept_staff_invite` responde 42702 contra Postgres real: ninguna invitacion de staff se puede aceptar | **no corregido aqui**: lo corrige la migracion 0053 de la PR #436; el escenario (e) de concurrencia se omite con aviso hasta entonces |
