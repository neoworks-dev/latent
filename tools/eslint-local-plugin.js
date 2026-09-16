/**
 * Local ESLint rules for Svelte markup. oxlint only parses `<script>` blocks, so anything
 * that inspects the template has to live here.
 */

/** Matches `svelte/prefer-class-directive`'s default scope, which already covers these. */
function isEmptyString(node) {
  if (node.type === "Literal") return node.value === "";
  if (node.type === "TemplateLiteral") {
    return node.expressions.length === 0 && node.quasis.every((quasi) => quasi.value.raw === "");
  }
  return false;
}

function findConditional(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "ConditionalExpression") return node;
  for (const key of ["expression", "left", "right", "argument", "object", "callee"]) {
    const found = findConditional(node[key]);
    if (found) return found;
  }
  return null;
}

const noClassTernary = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "disallow ternaries in class attributes that prefer-class-directive cannot rewrite",
    },
    schema: [],
    messages: {
      classTernary:
        "Ternary in a class attribute. Use a `class:` directive, or lift the branches into a named variable.",
    },
  },
  create(context) {
    return {
      SvelteAttribute(node) {
        if (node.key?.name !== "class") return;

        for (const value of node.value ?? []) {
          if (value.type !== "SvelteMustacheTag") continue;

          const conditional = findConditional(value.expression);
          if (!conditional) continue;

          // `prefer-class-directive` reports and autofixes the empty-branch shape already.
          if (isEmptyString(conditional.consequent) || isEmptyString(conditional.alternate)) {
            continue;
          }

          context.report({ node: conditional, messageId: "classTernary" });
        }
      },
    };
  },
};

export default {
  meta: { name: "local" },
  rules: { "no-class-ternary": noClassTernary },
};
