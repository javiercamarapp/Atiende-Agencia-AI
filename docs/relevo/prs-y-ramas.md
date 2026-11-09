# PRs y ramas en vuelo (foto del 8-nov 23:02, revisada el 9-nov)

Fuente: inventario del Paso 1 (`gh pr list` + estado de CI y de migraciones por PR). La foto envejece rápido: antes de actuar, confirma con
`gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup`. Orden de trabajo: [`cola-maestra.md`](cola-maestra.md).

## Clases

| Clase | Significado | PRs |
|---|---|---|
| LISTO | CI verde, mergeable, base reciente | #762 #764 #812 #791; #798, #703 y #709 tras cambiar su base a `main` |
| NECESITA-CI | sin CI por el bloqueo de facturación (o CI viejo); no hay rojo conocido | #714 #718 #759 #765 #766 #767 #768 #769 #772 #773 #776 #777 #779 #780 #814 #815 #819 |
| ROJO real | falla propia, no del bloqueo | #775 (lint + CodeQL alta), #802 (`env-inventory`), #747 (solo-agrega-specs; OOM de typecheck, ver #815), #760 (e2e) |
| EN-CONFLICTO | no fusiona limpio contra su base | #770 (padre de 8 PRs de i18n), #771 (cobro), #752 (voz), #763, #796, #816, #716, #694, R23/R24 #702 #707 #708 #712 |
| BLOQUEADO-POR-PADRE | apilado sobre otro PR abierto | i18n (#781 #784 #785 #787 #788 #789 #790 #799 #800 #801 #803 #804 #805 #806 #807 #817 #818), CFO (#794 #797 #808 #810), cobro (#793 #802 #809), voz #813, ds3 #749 #755 |
| OCTUBRE | #401-#588 (22 PRs) sobre una base de hace 1,126-3,076 commits; 11 con GitGuardian ✗ y #486 con CodeQL alta. Nada de su contenido está en `main` | ver tabla |

Notas: #177 se cerró el 9-nov. De #462/#476 (migración 000358 idéntica) sobra uno tras pasar sus commits. #805/#806 y #716/#718 **no** son duplicados.
Choques de migración: #702 (000417/103 contra `main`), #426 (000399), #463 (0057 interno), #462/#476 (000358). Por debajo de 000800 (renumerar o `--include-all`): #796,
cobro 000700-705, R23/R24 y los PRs de octubre.

## Todos los PRs abiertos

| PR | Título | Rama | Base | Clase | Nota |
|---|---|---|---|---|---|
| #401 | feat(hoteles): motor de reservas directo publico (H-42) | `feat/h42-motor-reservas-directo-publico` | `main` | OCTUBRE (base vieja) |  |
| #426 | feat(despachos): facturacion de honorarios e igualas con prefacturas y timbrado (D-32) | `feat/d32-facturacion-honorarios-igualas` | `main` | OCTUBRE (base vieja) |  |
| #432 | feat(rentas): checklist de onboarding con datos reales (Rn-36) y seed demo (Rn-33) | `feat/rn33-36-seed-demo-y-onboarding` | `main` | OCTUBRE (base vieja) |  |
| #438 | fix(despachos): DIOT sin ventas, total CFDI con IEPS/locales, IVA proporcional y calendario ... | `feat/paridad3-despachos-fiscal-correcciones` | `main` | OCTUBRE (base vieja) |  |
| #443 | feat(licitaciones): listados completos, paginacion real y deduplicacion entre fuentes (parid... | `feat/paridad3-licitaciones-listados-completos-y-dedupe` | `main` | OCTUBRE (base vieja) |  |
| #446 | feat(despachos): conciliacion N-a-1 correcta y acotada, direccion y unicidad del CFDI, pilot... | `feat/paridad3-despachos-conciliacion` | `main` | OCTUBRE (base vieja) |  |
| #452 | feat(hoteles): viaje del huesped sin escribir a mano - mensajes por evento, primer contacto,... | `feat/paridad3-hoteles-viaje-huesped` | `main` | OCTUBRE (base vieja) |  |
| #453 | feat(despachos): del XML a la poliza sin manos - clasificacion al ingerir, polizas del perio... | `feat/paridad3-despachos-autopiloto-ingesta-libro` | `main` | OCTUBRE (base vieja) |  |
| #458 | fix(citas): lote QA R1 api-caos (horarios pasados, lista de espera, sucursales, idempotencia... | `fix/qa-r1-citas-api-caos` | `main` | OCTUBRE (base vieja) |  |
| #462 | feat(rentas): finanzas en piloto automatico - codigo de la OTA, importar CSV de pagos y movi... | `feat/paridad3-rentas-finanzas-autopiloto` | `main` | OCTUBRE (base vieja) |  |
| #463 | feat(plataforma): preflight 'Listo para produccion' por organizacion y sin valores por omisi... | `feat/plataforma-pm-preflight-go-live` | `main` | OCTUBRE (base vieja) |  |
| #471 | fix(citas): zona horaria del negocio en el agente, la Agenda y los avisos (QA R1) | `fix/qa-r1-citas-tz` | `main` | OCTUBRE (base vieja) |  |
| #473 | feat(licitaciones): autopiloto - vigilante de cambios, nuevo match, KYC programado y auditor... | `feat/paridad3-licitaciones-autopiloto` | `main` | OCTUBRE (base vieja) |  |
| #476 | feat(rentas): pre-check-in publico por reserva, aviso y entrega manual de accesos omitidos y... | `feat/paridad3-rentas-precheckin-acceso` | `main` | OCTUBRE (base vieja) |  |
| #480 | feat(despachos): nomina con ley vigente - subsidio %UMA, IMSS por rama, prestaciones y XML 1... | `feat/paridad3-despachos-nomina-2026` | `main` | OCTUBRE (base vieja) |  |
| #485 | feat(rentas): conectividad y canales - feed iCal con token rotable, catalogo de canales, mat... | `feat/paridad3-rentas-conectividad-canales` | `main` | OCTUBRE (base vieja) |  |
| #486 | fix(citas): lote QA R1 automatizacion (recordatorios, lista de espera, Google Calendar, rete... | `fix/qa-r1-citas-automatizacion` | `main` | OCTUBRE (base vieja) |  |
| #488 | feat(despachos): piloto automatico de documentos, estatus SAT y cierre, y entrega al cliente... | `feat/paridad3-despachos-autopiloto-cierre-cliente` | `main` | OCTUBRE (base vieja) |  |
| #490 | fix(citas): lote QA R1 del panel (carrera de rango, confirmaciones, Reintentar, horarios alt... | `fix/qa-r1-citas-panel` | `main` | OCTUBRE (base vieja) |  |
| #496 | feat(despachos): contabilidad electronica conforme al XSD 1.3, codigo agrupador, polizas con... | `feat/paridad3-despachos-contabilidad-electronica-xsd` | `main` | OCTUBRE (base vieja) |  |
| #531 | feat(superadmin): entrar a la organización de un cliente (sesión de soporte en solo lectura) | `feat/superadmin-entrar-a-clientes` | `main` | OCTUBRE (base vieja) |  |
| #588 | fix(pm-r12): no crear el pedido tras un rechazo del resumen (A13) ni con un 'sí' a la pregun... | `fix/pm-r12-rechazo-resumen` | `main` | OCTUBRE (base vieja) |  |
| #694 | fix(restaurantes/web): P2 de #677 y #675 (aviso de agregados, cantidades en palabras, Escape... | `fix/wa-p2-agregados-grande-escape` | `main` | EN-CONFLICTO |  |
| #697 | feat(voz-banco): esqueleto del banco de voz, compuerta de pedidos y cliente simulado M0 (T01... | `feat/voz-banco-t01-t04` | `main` | sin clasificar en el inventario |  |
| #698 | fix(voz): el worker reenvía x-atiende-call-turn a las herramientas | `fix/voz-reenviar-call-turn` | `main` | sin clasificar en el inventario |  |
| #702 | R23 alertas WhatsApp al gerente, ventana 24 h e interruptor de emergencia (sin ejecutar loca... | `fix/r23-alertas` | `fix/r22-coe` | EN-CONFLICTO |  |
| #703 | R23 panel: asignar escalados, handoff de voz y alertas (sin ejecutar localmente) | `fix/r23-panel` | `fix/r22-coe` | LISTO tras cambiar base a main |  |
| #705 | R23 reactivacion automatica opt-in y captura de consentimiento (sin ejecutar localmente) | `fix/r23-reactiva` | `fix/r22-coe` | sin clasificar en el inventario |  |
| #707 | R23 plantilla de restaurante Fase A: config, generador, importador de menu; PM byte a byte i... | `fix/r23-demo` | `fix/r22-coe` | EN-CONFLICTO |  |
| #708 | R23 historial: importador, perfil 360, limpieza de duplicados y segmentos (migraciones 140-142) | `fix/r23-perfil` | `fix/r22-coe` | EN-CONFLICTO |  |
| #709 | R23 analitica del dueno: demanda, zonas, productos/combos, ratios y alertas ETA (migraciones... | `fix/r23-demanda` | `fix/r22-coe` | LISTO tras cambiar base a main |  |
| #711 | R24: crear_pedido no adopta un metodo de pago que nadie dijo; regla de numero dictado distinto | `fix/r24-sistematicos` | `fix/r22-coe` | sin clasificar en el inventario |  |
| #712 | R24 paridad menor: borrar producto, idiomas de voz, archivos a conocimiento, tono editable, ... | `fix/r24-paridad` | `fix/r22-coe` | EN-CONFLICTO |  |
| #713 | R24 operacion del dia: aceptar/rechazar, salida y entrega con hora real, encuesta post-entre... | `fix/r24-operacion` | `fix/r22-coe` | sin clasificar en el inventario |  |
| #714 | chore(ci): Bump actions/download-artifact from 7 to 8 in the actions group across 1 directory | `dependabot/github_actions/actions-4eb699f393` | `main` | NECESITA-CI |  |
| #716 | feat(voz): cerebro suelto (voz-turno) intercambiable en el worker de voz | `feat/voz-cerebro-suelto` | `main` | EN-CONFLICTO |  |
| #718 | feat(pm): cerebro de WhatsApp medido (suelto) detrás de bandera por organización | `feat/pm-cerebro-suelto` | `main` | NECESITA-CI | cerebro WhatsApp; 3 arreglos sin medir (fa304de9f) |
| #747 | feat(ds3): guía y recorrido animado — restaurantes | `ds3/guia-restaurantes` | `main` | ROJO real | solo-agrega-specs (OOM de typecheck, ver #815) |
| #749 | feat(ds3): guía y recorrido animado — citas, hoteles, despachos, licitaciones, rentas y supe... | `ds3/guia-verticales` | `ds3/guia-restaurantes` | BLOQUEADO-POR-PADRE |  |
| #752 | feat(voz): calidad ronda 2 — sin bucle de espera, cierre honesto, aviso corto, prompt a la m... | `feat/pm-voz-calidad-r2` | `main` | EN-CONFLICTO |  |
| #754 | feat(ds3): periodo, primario suave, tarjetas y tablas (paridad Rovaq) | `ds3/contenido-paleta` | `main` | sin clasificar en el inventario |  |
| #755 | feat(ds3): aviso de error con Reintentar y (i) «Cómo se calculó» (paridad Rovaq) | `ds3/contenido-error-info` | `ds3/contenido-paleta` | BLOQUEADO-POR-PADRE |  |
| #759 | feat(ds3): Resumen general de la organización — restaurantes (comparativo por sucursal con G... | `ds3/resumen-general` | `main` | NECESITA-CI |  |
| #760 | chore(ds3): retiro del diseño anterior — CI: sin solo-agrega-specs ni bandera en el barrido | `ds3/retiro-ci-bandera` | `ds3/diseno-nuevo-por-omision` | ROJO real | e2e |
| #762 | feat(ds3): restaurantes — operación (paridad Rovaq) | `ds3/restaurantes-operacion` | `main` | LISTO |  |
| #763 | feat(ds3): restaurantes — catálogo y clientes (paridad Rovaq) | `ds3/restaurantes-catalogo-clientes` | `main` | EN-CONFLICTO |  |
| #764 | feat(ds3): restaurantes — agente y configuración (paridad Rovaq) | `ds3/restaurantes-agente-configuracion` | `main` | LISTO |  |
| #765 | feat(restaurantes): «Limpiar caché y recargar» cuando una pantalla no carga | `feat/restaurantes-carga-limpiar-cache` | `main` | NECESITA-CI |  |
| #766 | fix(seguridad): MFA del superadmin obligatoria con compuerta de enrolamiento | `fix/mfa-superadmin` | `main` | NECESITA-CI |  |
| #767 | feat(restaurantes): mapeo de columnas al importar clientes CSV/Excel | `feat/restaurantes-importar-mapeo-columnas` | `main` | NECESITA-CI |  |
| #768 | feat(ds3): «Útil / No fue útil» del Copiloto — tabla con RLS (0076), API en las 6 verticales... | `ds3/datos-retroalimentacion` | `main` | NECESITA-CI |  |
| #769 | feat(restaurantes): selector de idiomas del agente de voz | `feat/restaurantes-idiomas-agente` | `main` | NECESITA-CI |  |
| #770 | feat(ds3): i18n ES/EN — restaurantes (1/n): base, Resumen y Pedidos | `ds3/i18n-restaurantes-1` | `main` | EN-CONFLICTO |  |
| #771 | feat(cobro): planes medidos (por sucursal, minutos y conversaciones incluidas) y uso facturable | `feat/cobro-planes-medidos` | `main` | EN-CONFLICTO |  |
| #772 | feat(restaurantes): pestañas Recibidas/Enviadas/Programadas con autopromoción y urgencia de ... | `feat/restaurantes-pedidos-pestanas` | `main` | NECESITA-CI |  |
| #773 | feat(restaurantes): modo simple del horario por día | `feat/restaurantes-horario-simple` | `main` | NECESITA-CI |  |
| #775 | fix(seguridad): CSP de la SPA en modo enforce con colector de reportes | `fix/csp-enforce` | `main` | ROJO real | lint + CodeQL alta |
| #776 | feat(restaurantes): clonación de voz con varias muestras y tarjeta de voz | `feat/restaurantes-voz-clonacion` | `main` | NECESITA-CI |  |
| #777 | feat(restaurantes): pin de sucursal con geocodificación del servidor | `feat/restaurantes-pin-sucursal` | `main` | NECESITA-CI |  |
| #779 | fix(ops): smoke post-deploy contra el alias de producción y prod-health en rojo sin PROD_BAS... | `fix/smoke-health` | `main` | NECESITA-CI |  |
| #780 | fix(ops): errores 500 de la API a Sentry con datos redactados (SENTRY_DSN) | `fix/sentry` | `main` | NECESITA-CI |  |
| #781 | feat(ds3): i18n ES/EN — restaurantes: autopiloto, historial, comandas, conversaciones y avisos | `ds3/i18n-restaurantes-2` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #784 | feat(ds3): i18n ES/EN — restaurantes: agente de WhatsApp | `ds3/i18n-restaurantes-agente` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #785 | feat(ds3): i18n ES/EN — restaurantes: clientes y equipo (ficha, importación, staff) | `ds3/i18n-restaurantes-clientes` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #787 | feat(ds3): i18n ES/EN — restaurantes: catálogo, sucursales y marketing | `ds3/i18n-restaurantes-catalogo` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #788 | feat(ds3): i18n ES/EN — restaurantes: operación del día | `ds3/i18n-restaurantes-operacion` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #789 | feat(ds3): i18n ES/EN — restaurantes: CFO (1/2) | `ds3/i18n-restaurantes-cfo` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #790 | feat(ds3): i18n ES/EN — restaurantes: configuración, primeros pasos y probador de WhatsApp | `ds3/i18n-restaurantes-ajustes` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #791 | feat(superadmin-cfo): métricas del cockpit — economía por cliente, MRR bridge, LTV/CAC, burn... | `feat/superadmin-cfo-metricas` | `main` | LISTO |  |
| #793 | feat(cobro): tabulador, planes Básico/Plus/Pro, pago por uso, cotizador con margen, proyecci... | `feat/cobro-tabulador-consumo` | `feat/cobro-planes-medidos` | BLOQUEADO-POR-PADRE |  |
| #794 | feat(superadmin-cfo): API del cockpit — economía por cliente, métricas SaaS, supuestos, capt... | `feat/superadmin-cfo-api` | `feat/superadmin-cfo-metricas` | BLOQUEADO-POR-PADRE |  |
| #796 | feat(alta): «primer valor en <30 min» por sucursal (menú, horario, zonas, cobro, prueba del ... | `feat/alta-primer-valor` | `main` | EN-CONFLICTO |  |
| #797 | feat(superadmin-cfo): pantalla «CFO de la plataforma» — KPIs SaaS, economía por cliente, com... | `feat/superadmin-cfo-pantalla` | `feat/superadmin-cfo-api` | BLOQUEADO-POR-PADRE |  |
| #798 | feat(alta): CTA de restaurantes hacia el registro (selector, login y copy del sitio) | `feat/alta-cta-registro` | `feat/alta-registro-restaurantes` | LISTO tras cambiar base a main |  |
| #799 | feat(ds3): i18n ES/EN — restaurantes: repartidor | `ds3/i18n-restaurantes-repartidor` | `ds3/i18n-restaurantes-operacion` | BLOQUEADO-POR-PADRE |  |
| #800 | feat(ds3): i18n ES/EN — restaurantes: turnos, cierres, auditoría y privacidad | `ds3/i18n-restaurantes-clientes-2` | `ds3/i18n-restaurantes-clientes` | BLOQUEADO-POR-PADRE |  |
| #801 | feat(ds3): i18n ES/EN — restaurantes: CFO (2/2) | `ds3/i18n-restaurantes-cfo-2` | `ds3/i18n-restaurantes-cfo` | BLOQUEADO-POR-PADRE |  |
| #802 | feat(cobro): Stripe por plan (lista permitida, IVA, uso medido), SPEI, cobranza y gancho de ... | `feat/cobro-stripe-cobranza` | `feat/cobro-tabulador-consumo` | ROJO real + BLOQUEADO-POR-PADRE | env-inventory |
| #803 | feat(ds3): i18n ES/EN — superadmin (1/n): andamio, resumen y organizaciones | `ds3/i18n-superadmin-1` | `ds3/i18n-restaurantes-1` | BLOQUEADO-POR-PADRE |  |
| #804 | feat(ds3): i18n ES/EN — citas (2/n) | `ds3/i18n-citas-2` | `ds3/i18n-citas-1` | BLOQUEADO-POR-PADRE |  |
| #805 | feat(ds3): i18n ES/EN — restaurantes: agente de voz y ajustes del agente (1/2: agente de voz) | `ds3/i18n-restaurantes-voz` | `ds3/i18n-restaurantes-agente` | BLOQUEADO-POR-PADRE |  |
| #806 | feat(ds3): i18n ES/EN — restaurantes: agente de voz y ajustes del agente (2/2: ajustes del a... | `ds3/i18n-restaurantes-voz-ajustes` | `ds3/i18n-restaurantes-voz` | BLOQUEADO-POR-PADRE |  |
| #807 | feat(ds3): i18n ES/EN — citas (1/n) | `ds3/i18n-citas-1` | `ds3/i18n-superadmin-1` | BLOQUEADO-POR-PADRE |  |
| #808 | feat(superadmin-cfo): recomendaciones con IA sin cifras inventadas, alertas de pool/costo/dó... | `feat/superadmin-cfo-recomendaciones` | `feat/superadmin-cfo-pantalla` | BLOQUEADO-POR-PADRE |  |
| #809 | feat(cobro): pantallas «Consumo y facturación» y «Cobro y cotizador» | `feat/cobro-pantallas` | `feat/cobro-stripe-cobranza` | BLOQUEADO-POR-PADRE |  |
| #810 | feat(superadmin-cfo): Excel del cockpit y resumen mensual de inversionistas en PDF | `feat/superadmin-cfo-exportar` | `feat/superadmin-cfo-recomendaciones` | BLOQUEADO-POR-PADRE |  |
| #812 | feat(ds3): restaurantes — CFO, tablas en tarjeta (paridad Rovaq) | `ds3/restaurantes-cfo` | `main` | LISTO |  |
| #813 | feat(voz): calidad ronda 3 — silencio mientras piensa, «sí» encima del total, consentimiento... | `feat/pm-voz-calidad-r3` | `feat/pm-voz-calidad-r2` | BLOQUEADO-POR-PADRE | base #752; cabeza 7a590666c sin E2E |
| #814 | chore(deps): Bump the npm-minor-patch group across 1 directory with 24 updates | `dependabot/npm_and_yarn/npm-minor-patch-9805075c94` | `main` | NECESITA-CI |  |
| #815 | fix(ci): typecheck con tope de heap de 6 GB (OOM del programa raíz de tsc) | `ci/main-verde-oom` | `main` | NECESITA-CI | arregla OOM del typecheck de main |
| #816 | feat(ds3): i18n ES/EN — marco del Resumen y «Pregúntale a tus datos» (1/3) | `ds3/i18n-resumen-copiloto` | `main` | EN-CONFLICTO |  |
| #817 | feat(ds3): i18n ES/EN — Copiloto de las 6 verticales: portada, chips con la misma consulta d... | `ds3/i18n-copiloto-verticales` | `ds3/i18n-resumen-copiloto` | BLOQUEADO-POR-PADRE |  |
| #818 | feat(ds3): i18n ES/EN — Resumen de hoteles, despachos, licitaciones y rentas (3/3) | `ds3/i18n-resumen-verticales` | `ds3/i18n-superadmin-1` | BLOQUEADO-POR-PADRE |  |
| #819 | rediseño R2: antetítulo por categoría, encabezado + avisos debajo, móvil, primario suave, th... | `rediseno/shell-paleta-r2` | `main` | NECESITA-CI |  |

## Ramas locales sin PR (olas del 9-nov)

| Rama | Ola | Estado |
|---|---|---|
| `fix/hoteles-cobro-centavos` | 1-A | 5 commits locales, sin push |
| `fix/billing-ledger-atomico` | 1-B | sin commits |
| `ci/codeql-actions-read` | 1-C | sin commits |
| `ci/smoke-post-deploy-prod` | 1-E | sin commits |
| `seg/revoke-security-definer` | 2-F | 5 commits locales, sin push |
| `docs/evals-voz-relevo` | 2-docs | este PR |
| `db/g1-espejos-huerfanos` | 4-G | 5 commits locales, sin push |
| `respaldo/suelto-vigente-20261107` | — | en el repo suelto (privado): código vigente del suelto |
