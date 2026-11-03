import { homedir } from 'node:os';

export const REDACTED = '[REDACTED]';

/** Normalised (lower case, no `_`/`-`) key names whose values must never be logged. */
const SENSITIVE_KEYS = new Set([
    'token',
    'accesstoken',
    'secret',
    'password',
    'secretaccesskey',
    'accesskeyid',
    'authorization',
]);

const MAX_DEPTH = 8;

export interface RedactOptions {
    /** Home directory to replace with `~`. Defaults to os.homedir(). */
    homeDir?: string;
}

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function homePattern(homeDir: string | undefined): RegExp | null {
    if (!homeDir) return null;
    const trimmed = homeDir.replace(/[\\/]+$/, '');
    if (trimmed.length < 2) return null;
    const variants = new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')]);
    return new RegExp([...variants].map(escapeRegExp).join('|'), 'gi');
}

/** Redacts secrets inside a free-form string. */
function redactString(input: string, home: RegExp | null): string {
    let out = input
        // Authorization header / key-value forms, with or without a scheme.
        .replace(
            /(authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s"',;]+/gi,
            `$1${REDACTED}`,
        )
        // Bare "Bearer xyz" values.
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=|-]+/gi, `Bearer ${REDACTED}`)
        // Sanctum personal access tokens: "<id>|<random>".
        .replace(/\b\d+\|[A-Za-z0-9]{20,}/g, REDACTED);
    if (home) out = out.replace(home, '~');
    return out;
}

function walk(value: unknown, home: RegExp | null, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return redactString(value, home);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[Truncated]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (value instanceof Error) {
        const result: Record<string, unknown> = {
            name: value.name,
            message: redactString(value.message, home),
        };
        if (value.stack) result['stack'] = redactString(value.stack, home);
        return result;
    }

    if (Array.isArray(value)) {
        return value.map((item) => walk(item, home, depth + 1, seen));
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        result[key] = isSensitiveKey(key) ? REDACTED : walk(item, home, depth + 1, seen);
    }
    return result;
}

/**
 * Returns a copy of `value` with secrets removed: Authorization/Bearer values,
 * Sanctum-style tokens, values of sensitive keys, and the user's home directory (as `~`).
 */
export function redact(value: string, options?: RedactOptions): string;
export function redact(value: unknown, options?: RedactOptions): unknown;
export function redact(value: unknown, options: RedactOptions = {}): unknown {
    const home = homePattern(options.homeDir ?? homedir());
    return walk(value, home, 0, new WeakSet());
}
