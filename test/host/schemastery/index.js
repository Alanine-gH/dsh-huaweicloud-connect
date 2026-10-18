/**
 * @deepseek-ai/schemastery 的离线替身（仅测试台用）。
 *
 * 只需支持插件用到的链式写法：z.object({...}) / z.string() / z.boolean() / z.number()
 * 以及 .default() / .description() / [key: string]: unknown 索引签名。
 * 真实的 schemastery 在 DSH 宿主里提供。
 */

function chainify(inner) {
  const node = {
    ...inner,
    default: (value) => chainify({ ...inner, kind: "default", value }),
    description: (text) => chainify({ ...inner, description: text }),
    optional: () => chainify({ ...inner, optional: true }),
    required: () => chainify({ ...inner, optional: false }),
  };
  return node;
}

const base = {
  object: (shape) => chainify({ kind: "object", shape }),
  string: () => chainify({ kind: "string" }),
  boolean: () => chainify({ kind: "boolean" }),
  number: () => chainify({ kind: "number" }),
  literal: (value) => chainify({ kind: "literal", value }),
  array: (item) => chainify({ kind: "array", item }),
  any: () => chainify({ kind: "any" }),
  unknown: () => chainify({ kind: "unknown" }),
  never: () => chainify({ kind: "never" }),
};

const z = chainify(base);
export default z;
