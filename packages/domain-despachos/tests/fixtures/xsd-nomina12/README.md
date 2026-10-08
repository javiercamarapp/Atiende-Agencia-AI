# XSD oficial del complemento Nómina 1.2

Descargados de los URL oficiales del SAT (sat.gob.mx/sitio_internet/cfd/...). Usados por `tests/nomina-xml-xsd.spec.ts` con `xmllint-wasm` (libxml2 en WebAssembly, dependencia de desarrollo de domain-despachos).

| Archivo | Origen | Cambio |
|---|---|---|
| `nomina12.xsd` | `.../cfd/nomina/nomina12.xsd` (sha256 original `ac5db22c...29083`) | Solo los 3 `schemaLocation` apuntan a los archivos locales de esta carpeta |
| `catNomina.xsd` | `.../catalogos/Nomina/catNomina.xsd` | Ninguno |
| `tdCFDI.xsd` | `.../tipoDatos/tdCFDI/tdCFDI.xsd` | Ninguno |
| `catCFDI.c_Estado.xsd` | `.../catalogos/catCFDI.xsd` (6 MB) | Recortado al `simpleType` `c_Estado` verbatim (único tipo de catCFDI que importa nomina12) |

El comprobante `cfdi:Comprobante` (cfdv40.xsd) NO se valida aquí: se valida el nodo `nomina12:Nomina`, que es lo que cambia.
