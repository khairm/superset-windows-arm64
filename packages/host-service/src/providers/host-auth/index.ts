// (CLOUD-SEVERANCE-P2) `EdgeGuardedHostAuthProvider` is DELETED, not merely
// unused. It accepted every request on the promise of a cloud edge that turns
// unauthorised callers away, and this fork has no edge. Refusing the flag that
// selected it stops today's route to it; deleting the class stops a future
// merge from adding a construction site that never consults that flag. Absence
// is provable, "unreachable" is not.
export { PskHostAuthProvider } from "./PskHostAuthProvider";
export type { HostAuthProvider } from "./types";
