# Native protocol

Retains Paseo's native wire schemas, provider/configuration types and codecs for direct control
and existing-service interoperability. Native product message definitions are schema vocabulary;
Miko does not start their services or expose their operations through its execution API.

Miko's public Hub execution contract is the separate `@mikoagents/execution-protocol` package.
Its exact version and source digest are validated jointly with Hub. Keep native wire definitions
compatible when selecting upstream fixes; package source names remain upstream names until staged
Miko packaging rewrites imports.
