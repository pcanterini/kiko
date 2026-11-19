// What parsed JSON is an object: not null, not an array. Imports nothing, so anything can use it.

/** Whether `v` is an object (not null, not an array): its fields `unknown`, or `any` as `isObject<any>(v)`. */
export const isObject = <T = unknown>(v: unknown): v is Record<string, T> => typeof v === "object" && v !== null && !Array.isArray(v);
