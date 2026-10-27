export const VERSION = "0.6.1";
/** Review modes this runner can execute. */
export const MODES = ["diff", "context", "deep"] as const;
/** Optional abilities announced at register and heartbeat. `local-code`: deep reviews from this machine's own git clone (payload v2). */
export const FEATURES = ["local-code"] as const;
export const PROTOCOL = "v1";
