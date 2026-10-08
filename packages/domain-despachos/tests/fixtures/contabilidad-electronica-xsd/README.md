# XSD oficiales de contabilidad electrónica 1.3 (SAT)

Copias de los esquemas publicados por el SAT, usadas SOLO por las pruebas para validar el XML que genera el motor:

| Archivo | Origen |
| --- | --- |
| `CatalogoCuentas_1_3.xsd` | http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd |
| `BalanzaComprobacion_1_3.xsd` | http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd |
| `PolizasPeriodo_1_3.xsd` | http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd |
| `CatalogosParaEsqContE.xsd` | http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogosParaEsqContE/CatalogosParaEsqContE.xsd |

Descargados el 7-oct-2026. La ÚNICA modificación: en `CatalogoCuentas_1_3.xsd` y `PolizasPeriodo_1_3.xsd` el `schemaLocation` del
`xs:import` apunta a `CatalogosParaEsqContE.xsd` (archivo hermano) en vez de a la URL del SAT, para validar sin red. El resto es byte a byte
el original (incluida la marca BOM de `CatalogosParaEsqContE.xsd`). Si el SAT publica una versión nueva, se reemplazan y se actualizan
`src/contabilidad-electronica/codigos-agrupadores.ts` y la ficha `normas/anexo-24-codigo-agrupador.yaml` (la prueba de sincronía falla si divergen).
