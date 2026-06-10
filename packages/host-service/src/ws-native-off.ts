// (WS-NATIVE-OFF) Force `ws` onto its pure-JS mask/unmask + UTF-8 validation
// paths BEFORE any module pulls `ws` in. The optional native modules
// (bufferutil / utf-8-validate) are rebuilt nondeterministically by the
// packaging step; a build that ships a broken bufferutil makes the bundled
// require resolve to an EMPTY module — no throw, so ws's try/catch fallback
// never engages — and the first masked client frame ≥32 bytes (the initial
// terminal resize) throws `bufferUtil.unmask is not a function`, wedging that
// socket's receiver. Result: ALL terminal keyboard input silently dies while
// output (unmasked server frames) keeps flowing. JS fallback cost is
// negligible at terminal frame sizes. Incident: build 41124b7d3.
//
// This module must stay the FIRST import of the serve entry; the coordinator
// also sets these in the child env (apps/desktop host-service-coordinator) as
// the production guarantee.
process.env.WS_NO_BUFFER_UTIL ??= "1";
process.env.WS_NO_UTF_8_VALIDATE ??= "1";
