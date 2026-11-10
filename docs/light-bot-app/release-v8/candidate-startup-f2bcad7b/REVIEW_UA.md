Startup diagnostics for source f2bcad7b420c8c46f9d8a4dbd2b7adf41f6b939b819478befbcc7209b32fd83e.

The prior runtime logged only a generic module-import failure. This change emits bounded allowlisted failure metadata and Node platform identity, never the raw message, stack, environment, or cause. Exit and runtime guards remain intact. The exact failure cause and production boot remain unconfirmed.

Validation: strict TypeScript; 363/363 backend tests; production build with 315 source inputs and 17 artifacts; both inert release verifiers; independent four compiled canary cases. Dependencies and client assets are unchanged from security529. No migration replay, database changes, secret changes, or campaign sends.
