import { fail } from './errors.js';
export function defineProc(spec) {
    const def = {
        name: spec.name,
        args: spec.args,
        returns: spec.returns,
        execute: spec.execute,
    };
    if (spec.description !== undefined) {
        def.description = spec.description;
    }
    if (spec.mcp !== undefined) {
        def.mcp = spec.mcp;
    }
    if (spec.roles !== undefined) {
        def.roles = spec.roles;
    }
    if (spec.refs !== undefined) {
        def.refs = spec.refs;
    }
    if (spec.validate !== undefined) {
        def.validate = spec.validate;
    }
    return def;
}
/** Canonical accessor for a proc's verb name. Equivalent to `proc.name`; provided
 *  so consumers can pass `getProcName(proc)` when destructuring loses inference. */
export function getProcName(proc) {
    return proc.name;
}
/**
 * Whether `proc` should be registered as a tool with any MCP server. Default
 * is true; set `mcp: false` on the ProcDef to opt out (the proc is still
 * deployed and granted, just not exposed as a tool).
 */
export function isMcpExposed(proc) {
    return proc.mcp !== false;
}
export { fail };
//# sourceMappingURL=defineProc.js.map