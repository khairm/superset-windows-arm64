// Desktop bundle entry for the host-service worker thread. Emitted as
// dist/main/host-worker.js, side-by-side with host-service.js so the pool's
// script resolution finds it (see host-worker-pool.ts).
// (WIN-HIDE-FIRST-IMPORT) A worker thread has its own child_process module
// object, so it needs its own patch. Must stay the first import.
import "main/lib/windows-child-process-patch-install";
import "@superset/host-service/host-worker";
