// Static check behind T-app-006 (CAP-21): finds user-visible raw string literals in screens and components —
// text children of h(), user-facing attributes in h() props, component (PascalCase) arguments, and assignments
// to textContent & co.
import ts from 'typescript';

const TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'innerHTML', 'placeholder', 'title', 'ariaLabel', 'alt']);
const TEXT_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'value']);

export interface Violation {
  readonly line: number;
  readonly text: string;
}

function isTextLiteral(
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return /\S/.test(node.text);
  if (ts.isTemplateExpression(node)) {
    return /\S/.test(node.head.text) || node.templateSpans.some((s) => /\S/.test(s.literal.text));
  }
  return false;
}

/** Literals reachable as values through `a && 'x'`, `c ? 'x' : y`, `(…)`. */
function textLiterals(node: ts.Node): ts.Node[] {
  if (ts.isParenthesizedExpression(node)) return textLiterals(node.expression);
  if (ts.isConditionalExpression(node)) return [...textLiterals(node.whenTrue), ...textLiterals(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
      node.operatorToken.kind,
    )
  ) {
    return [...textLiterals(node.left), ...textLiterals(node.right)];
  }
  return isTextLiteral(node) ? [node] : [];
}

function propName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

export function findRawStrings(source: string, fileName = 'screen.ts'): Violation[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const report = (node: ts.Node) =>
    violations.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText() });

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'h') {
      node.arguments.slice(2).forEach((arg) => textLiterals(arg).forEach(report));
      const props = node.arguments[1];
      const attrs =
        props && ts.isObjectLiteralExpression(props)
          ? props.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === 'attrs')
          : undefined;
      if (attrs && ts.isPropertyAssignment(attrs) && ts.isObjectLiteralExpression(attrs.initializer)) {
        for (const p of attrs.initializer.properties) {
          const name = ts.isPropertyAssignment(p) ? propName(p.name) : null;
          if (ts.isPropertyAssignment(p) && name && TEXT_ATTRIBUTES.has(name))
            textLiterals(p.initializer).forEach(report);
        }
      }
    }
    // Components (PascalCase) take display text as arguments: ScreenHeader('Title') is as raw as h('h1', {}, 'Title').
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^[A-Z]/.test(node.expression.text)) {
      node.arguments.forEach((arg) => textLiterals(arg).forEach(report));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      TEXT_PROPERTIES.has(node.left.name.text)
    ) {
      textLiterals(node.right).forEach(report);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['setAttribute', 'append', 'prepend', 'replaceChildren'].includes(node.expression.name.text)
    ) {
      const args = node.expression.name.text === 'setAttribute' ? node.arguments.slice(1) : node.arguments;
      const attr = node.arguments[0];
      const isTextAttr =
        node.expression.name.text !== 'setAttribute' ||
        (attr && ts.isStringLiteral(attr) && TEXT_ATTRIBUTES.has(attr.text));
      if (isTextAttr) args.forEach((arg) => textLiterals(arg).forEach(report));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}
