// Protocol versioning. Increment on breaking changes.
//
// v1: framing was [u32 len][JSON]; PTY input/output bytes were base64'd
//     inside the JSON `data` field.
// v2: framing is  [u32 totalLen][u32 jsonLen][JSON][optional payload bytes];
//     OutputMessage and InputMessage drop their `data` field and carry
//     bytes via the payload tail. (See framing.ts.)
// v3: InputMessage may carry requestId; the daemon returns input-ok or a
//     correlated error only after pty.write. This is required for honest remote
//     answer confirmation, so an older fire-and-forget daemon is incompatible.
//
// v2 remains negotiable for ordinary terminal operations so a detached daemon
// from the previous desktop build can be adopted without losing its live shells.
// Acknowledged companion input explicitly requires negotiated v3 and refuses
// before sending on v2; the supervisor can therefore observe the old daemon's
// package version and surface/update the skew instead of retaining an unreachable
// "unknown" instance.
export const CURRENT_PROTOCOL_VERSION = 3 as const;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [3, 2];
