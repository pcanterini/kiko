// Checks messages against protocol/schema.json, with no dependency: only the JSON Schema keywords
// the schema uses (type, const, enum, properties, required, additionalProperties: false, items,
// oneOf, $ref to $defs, minLength/maxLength, pattern, minimum/maximum, maxItems). Anything else in
// the schema is ignored, so a new keyword there needs a line here (the unit test checks every
// example, and messages that must fail).
// Imported, not read at run time, so an installed copy's executable has it built in.
import schemaJson from "../../protocol/schema.json" with { type: "json" };
import { isObject } from "../core/is-object.ts";

type Schema = Record<string, any>;

export const schema: Schema = schemaJson;
/** The version every message carries (`v`); the hub takes only this one. */
export const PROTOCOL_VERSION: number = schema.version;

/** The message types the schema defines, and who sends each (x-from). */
export const MESSAGE_TYPES: Map<string, "phone" | "hub"> = new Map(
  (schema.oneOf as Array<{ $ref: string }>).map((r) => {
    const name = r.$ref.replace("#/$defs/", "");
    return [name, schema.$defs[name]["x-from"]];
  }),
);

/**
 * Why `message` isn't a valid message (from `from`, when given), or null when it is. Picks the
 * definition by its type first, so the reason names the field that's wrong rather than every
 * message it isn't.
 */
export function invalid(message: unknown, from?: "phone" | "hub"): string | null {
  if (!isObject(message)) return "not a JSON object";
  const type = message.type;
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) return `unknown type ${JSON.stringify(type)}`;
  if (from && MESSAGE_TYPES.get(type) !== from) return `${type} isn't sent by the ${from}`;
  return check(schema.$defs[type], message, type);
}

function check(s: Schema, value: unknown, at: string): string | null {
  if (s.$ref) return check(resolve(s.$ref), value, at);
  if ("const" in s && value !== s.const) return `${at}: must be ${JSON.stringify(s.const)}`;
  if (s.enum && !s.enum.includes(value)) return `${at}: must be one of ${s.enum.map((x: unknown) => JSON.stringify(x)).join(", ")}`;
  if (s.type) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => is(t, value))) return `${at}: must be ${types.join(" or ")}`;
  }
  if (s.oneOf) {
    const passing = (s.oneOf as Schema[]).filter((sub) => check(sub, value, at) === null).length;
    if (passing !== 1) {
      // One alternative only: its own reason is the clearest.
      const reasons = (s.oneOf as Schema[]).map((sub) => check(sub, value, at)).filter(Boolean);
      return passing === 0 ? (reasons.length === 1 ? reasons[0] : `${at}: matches none of its forms (${reasons.join("; ")})`) : `${at}: matches more than one form`;
    }
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) return `${at}: shorter than ${s.minLength}`;
    if (s.maxLength !== undefined && value.length > s.maxLength) return `${at}: longer than ${s.maxLength}`;
    if (s.pattern && !new RegExp(s.pattern, "u").test(value)) return `${at}: doesn't match ${s.pattern}`;
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) return `${at}: below ${s.minimum}`;
    if (s.maximum !== undefined && value > s.maximum) return `${at}: above ${s.maximum}`;
  }
  if (Array.isArray(value)) {
    if (s.maxItems !== undefined && value.length > s.maxItems) return `${at}: more than ${s.maxItems} items`;
    if (s.items) {
      for (let i = 0; i < value.length; i++) {
        const why = check(s.items, value[i], `${at}[${i}]`);
        if (why) return why;
      }
    }
  }
  if (isObject(value)) {
    for (const key of s.required ?? []) if (!(key in value)) return `${at}: missing ${key}`;
    const props: Record<string, Schema> = s.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) {
        const why = check(props[key], v, `${at}.${key}`);
        if (why) return why;
      } else if (s.additionalProperties === false) return `${at}: unexpected field ${key}`;
    }
  }
  return null;
}

function resolve(ref: string): Schema {
  if (!ref.startsWith("#/$defs/")) throw new Error(`unsupported $ref ${ref}`);
  const found = schema.$defs[ref.slice("#/$defs/".length)];
  if (!found) throw new Error(`no definition for ${ref}`);
  return found;
}

function is(type: string, value: unknown) {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return false;
  }
}
