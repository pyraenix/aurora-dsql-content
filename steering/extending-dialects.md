# Extending the Schema Converter to New Dialects

The converter is designed with an adapter pattern so new source dialects can be added without modifying the core conversion logic.

## Architecture

```
Source SQL → Parser → ParsedSchema → Converter (adapter) → DSQL DDL + Report
```

### Key modules

- **sql-parser.js**: Parses raw SQL DDL into a `ParsedSchema` object (tables, columns, constraints, indexes, sequences, triggers, etc.)
- **dsql-constraints.js**: Defines `NormalizedType` enum, the fixed Stage 2 mapping (`NormalizedType → DSQL`), and DSQL platform constraints
- **type-mappings/<dialect>.js**: Stage 1 mapping (`source type → NormalizedType`) for each dialect
- **converter.js**: The `ADAPTERS` registry + `convertSchema()` function that ties parsing, type resolution, issue detection, and DDL generation together
- **index.js**: MCP server exposing tools

## Adding a New Dialect

### Step 1: Create the type mapping file

Create `mcp-server/src/type-mappings/<dialect>.js`:

```javascript
import { NormalizedType } from "../dsql-constraints.js";

export const MY_TYPE_MAPPING = Object.freeze({
  "SOURCE_TYPE": NormalizedType.TEXT,
  // ... map every source type to a NormalizedType
});

export const MY_FALLBACK_TEXT_TYPES = new Set([
  // Types that map to TEXT because DSQL has no equivalent
]);

export const MY_SERIAL_TYPES = new Set([
  // Auto-increment type names
]);

export const MY_UNSUPPORTED_FEATURES = [
  // Features DSQL does not support
];
```

### Step 2: Register the adapter in converter.js

Add an entry to the `ADAPTERS` object:

```javascript
import { MY_TYPE_MAPPING, MY_FALLBACK_TEXT_TYPES, MY_SERIAL_TYPES, MY_UNSUPPORTED_FEATURES } from "./type-mappings/mydialect.js";

// In the ADAPTERS object:
mydialect: {
  typeMapping: MY_TYPE_MAPPING,
  fallbackTextTypes: MY_FALLBACK_TEXT_TYPES,
  serialTypes: MY_SERIAL_TYPES,
  unsupportedFeatures: MY_UNSUPPORTED_FEATURES,
  resolveType: null, // or a custom resolver function for parameterized types
},
```

### Step 3: Update the MCP server tool schemas

In `index.js`, add the new dialect to the `source_dialect` enum in each tool.

### Step 4: Add a steering file

Create `steering/<dialect>-conversion.md` with the type mapping table and dialect-specific rules.

### Step 5: Update POWER.md

Add the new dialect to the description, keywords, tool docs, and steering file mappings.

## Planned Dialects

| Dialect | Status | Key Challenges |
|---------|--------|----------------|
| PostgreSQL | Done | Baseline dialect |
| MySQL | Planned | AUTO_INCREMENT, ENUM/SET types, DATETIME vs TIMESTAMP |
| CockroachDB | Planned | STRING type, interleaved tables, GEOGRAPHY/GEOMETRY |
| Spanner | Planned | GoogleSQL vs PG dialect, STRING(N)/STRING(MAX), ARRAY<T>, interleaving |

## Custom Type Resolvers

For dialects with parameterized types (like Spanner's `STRING(255)` or `ARRAY<INT64>`), implement a `resolveType(rawType, dialect)` function instead of relying on the static mapping dictionary. See `type-mappings/spanner.js` in the DSQL Migration Toolkit for an example.
