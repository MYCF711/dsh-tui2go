/**
 * Stable session identity across backends.
 * A bare session id is only unique inside one backend's catalog, so every
 * cross-backend reference carries the backend id with it.
 */
/** One session of one backend. */
export interface AgentSessionRef {
    /**
     * Backend id: `dsh`, `claude`, `acp:<agent>`.
     *
     * A plain string on purpose (P0 R11): branding it would force every backend,
     * every fixture and this whole neutral layer through the app-level validator,
     * for no gain here — what a ref and a `~/.dsh-tui/backends/<id>/` path need is
     * the **id syntax** gate (`agent/backend-manifest.ts`), and that is applied
     * wherever an untrusted value enters (`kernelPrefs.parseBackendId`, the
     * registry's parse, the launcher's mirror). Backends build their own refs from
     * their own constant id.
     */
    readonly backendId: string;
    /** The backend's own session id (DSH session id, Claude session uuid). */
    readonly sessionId: string;
}
/** Backend assumed when a persisted reference carries no prefix. */
export declare const DEFAULT_BACKEND_ID = "dsh";
/**
 * Serialize a reference as `<backendId>:<sessionId>`. DSH references
 * serialize without a prefix, so DSH ids persisted by older builds (MRU
 * lists, `--resume <id>`) stay valid as-is.
 */
export declare function formatSessionRef(ref: AgentSessionRef): string;
/**
 * Parse {@link formatSessionRef} output. Backend ids may themselves contain
 * a colon (`acp:gemini`), so the prefix is the longest known backend id the
 * text starts with (followed by `:` and a non-empty session id); any other
 * string is a bare DSH session id (DSH ids never need escaping this way).
 */
export declare function parseSessionRef(text: string, knownBackends: readonly string[]): AgentSessionRef;
/** Value equality of two references. */
export declare function sameSessionRef(a: AgentSessionRef, b: AgentSessionRef): boolean;
//# sourceMappingURL=refs.d.ts.map