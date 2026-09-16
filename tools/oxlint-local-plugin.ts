/**
 * Local oxlint rules, loaded via `jsPlugins` in `.oxlintrc.json`.
 *
 * oxlint resolves this TypeScript source directly — no build step. JS plugins are alpha
 * there and not subject to semver.
 *
 * The ESTree node shapes are declared inline rather than pulled from `@types/estree`:
 * this file sits outside every tsconfig `include`, so an import would not resolve.
 */

interface EstreeNode {
  type: string;
  value?: unknown;
  elements?: unknown[];
  properties?: unknown[];
  expressions?: unknown[];
  quasis?: { value: { raw: string } }[];
  left?: EstreeNode;
  right?: EstreeNode;
  consequent?: EstreeNode;
  alternate?: EstreeNode;
  expression?: EstreeNode;
}

interface ConditionalExpressionNode extends EstreeNode {
  consequent: EstreeNode;
  alternate: EstreeNode;
}

interface RuleContext {
  report(descriptor: { node: EstreeNode; messageId: string; data?: Record<string, string> }): void;
}

/** `""`, `[]`, `{}` and empty template literals all read as "no value" branches. */
function isEmptyValue(node: EstreeNode): boolean {
  if (node.type === "Literal") return node.value === "";
  if (node.type === "ArrayExpression") return node.elements?.length === 0;
  if (node.type === "ObjectExpression") return node.properties?.length === 0;
  if (node.type === "TemplateLiteral") {
    return node.expressions?.length === 0 && (node.quasis ?? []).every((q) => q.value.raw === "");
  }
  return false;
}

const noEmptyTernaryBranch = {
  meta: {
    type: "suggestion",
    docs: {
      description: "disallow ternaries whose only purpose is to fall back to an empty value",
    },
    schema: [],
    messages: {
      emptyBranch:
        "Ternary falls back to an empty {{ kind }}. Build the value conditionally instead of branching to nothing.",
    },
  },
  create(context: RuleContext) {
    return {
      ConditionalExpression(node: ConditionalExpressionNode) {
        let empty: EstreeNode | null = null;
        if (isEmptyValue(node.alternate)) empty = node.alternate;
        else if (isEmptyValue(node.consequent)) empty = node.consequent;
        if (!empty) return;

        let kind = "string";
        if (empty.type === "ArrayExpression") kind = "array";
        else if (empty.type === "ObjectExpression") kind = "object";

        context.report({ node, messageId: "emptyBranch", data: { kind } });
      },
    };
  },
};

interface LogicalExpressionNode extends EstreeNode {
  operator: string;
  left: EstreeNode & { operator?: string };
  right: EstreeNode & { operator?: string };
  parent?: EstreeNode & { operator?: string };
}

function isNullish(node?: EstreeNode & { operator?: string }): boolean {
  return node?.type === "LogicalExpression" && node.operator === "??";
}

const noChainedNullishCoalescing = {
  meta: {
    type: "suggestion",
    docs: { description: "disallow chaining more than one `??` to pick among candidates" },
    schema: [],
    messages: {
      chained:
        "Chained `??`. Pick the candidate with guard clauses, one condition per line, instead of stacking fallbacks.",
    },
  },
  create(context: RuleContext) {
    return {
      LogicalExpression(node: LogicalExpressionNode) {
        if (node.operator !== "??") return;
        if (!isNullish(node.left) && !isNullish(node.right)) return;
        // `a ?? b ?? c` nests left, so only the outermost link reports the chain once.
        if (isNullish(node.parent)) return;

        context.report({ node, messageId: "chained" });
      },
    };
  },
};

interface AsExpressionNode extends EstreeNode {
  expression: EstreeNode;
  typeAnnotation?: { type: string };
}

/** `f() as T`, including through parentheses and `??`/`||` wrappers. */
function wrapsCall(node?: EstreeNode): boolean {
  if (!node) return false;
  if (node.type === "CallExpression") return true;
  if (node.type === "LogicalExpression" || node.type === "ConditionalExpression") {
    return [node.left, node.right, node.consequent, node.alternate].some(wrapsCall);
  }
  if (node.type === "TSNonNullExpression" || node.type === "ChainExpression") {
    return wrapsCall(node.expression);
  }
  return false;
}

const noCallResultCast = {
  meta: {
    type: "suggestion",
    docs: { description: "disallow asserting the type of a call result at the call site" },
    schema: [],
    messages: {
      callCast:
        "Type assertion on a call result. Give the function a return type or a type parameter instead of asserting at the call site.",
    },
  },
  create(context: RuleContext) {
    return {
      TSAsExpression(node: AsExpressionNode) {
        if (node.typeAnnotation?.type === "TSTypeReference") {
          // `as const` is a literal-narrowing directive, not an assertion about a call.
          const name = (node.typeAnnotation as { typeName?: { name?: string } }).typeName?.name;
          if (name === "const") return;
        }
        if (!wrapsCall(node.expression)) return;

        context.report({ node, messageId: "callCast" });
      },
    };
  },
};

export default {
  meta: { name: "local" },
  rules: {
    "no-empty-ternary-branch": noEmptyTernaryBranch,
    "no-chained-nullish-coalescing": noChainedNullishCoalescing,
    "no-call-result-cast": noCallResultCast,
  },
};
