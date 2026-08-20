/**
 * Sentinel host id for "run this in a cloud sandbox". Not a machine id: a
 * sandbox is created per workspace and has no host row to point at.
 *
 * A leaf of its own so pure decision code can read it without importing the
 * picker component (and, through it, the whole UI graph).
 */
export const CLOUD_HOST_ID = "cloud";
