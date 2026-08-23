/**
 * Safe Expression Parser - Limited arithmetic expression evaluator
 *
 * SECURITY: This is NOT JavaScript eval(). It's a custom, sandboxed parser
 * that only supports a limited set of safe operations:
 * - Basic arithmetic: +, -, *, /
 * - Variable assignment: a = b + c
 * - Context variable access
 * - Literal numbers, strings, booleans, empty arrays, and empty objects
 *
 * Architecture:
 * - Tokenizer converts expression string to tokens
 * - Parser builds AST from tokens
 * - Evaluator executes AST against context
 * - Interpreter interface allows swapping implementation in future
 */

// Token types for lexer
export type TokenType =
  | "NUMBER" // 123, 45.67
  | "STRING" // "hello", 'world'
  | "BOOLEAN" // true, false
  | "EMPTY_ARRAY" // []
  | "EMPTY_OBJECT" // {}
  | "IDENTIFIER" // variable names
  | "OPERATOR" // +, -, *, /
  | "ASSIGN" // =
  | "LPAREN" // (
  | "RPAREN" // )
  | "EOF";

export interface Token {
  type: TokenType;
  value: string | number | boolean;
  position: number;
}

// AST Node types
export type ASTNode =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | EmptyArrayLiteral
  | EmptyObjectLiteral
  | Identifier
  | BinaryExpression
  | AssignmentExpression;

export interface NumberLiteral {
  type: "NumberLiteral";
  value: number;
}

export interface StringLiteral {
  type: "StringLiteral";
  value: string;
}

export interface BooleanLiteral {
  type: "BooleanLiteral";
  value: boolean;
}

export interface EmptyArrayLiteral {
  type: "EmptyArrayLiteral";
}

export interface EmptyObjectLiteral {
  type: "EmptyObjectLiteral";
}

export interface Identifier {
  type: "Identifier";
  name: string;
}

export interface BinaryExpression {
  type: "BinaryExpression";
  operator: "+" | "-" | "*" | "/";
  left: ASTNode;
  right: ASTNode;
}

export interface AssignmentExpression {
  type: "AssignmentExpression";
  target: string; // Variable name to assign to
  value: ASTNode; // Expression to evaluate
}

/**
 * Tokenizer - converts expression string to tokens
 */
export class Tokenizer {
  private input: string;
  private position: number = 0;

  constructor(input: string) {
    this.input = input.trim();
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.position < this.input.length) {
      const char = this.input[this.position];

      // Skip whitespace
      if (/\s/.test(char)) {
        this.position++;
        continue;
      }

      // Numbers (including decimals)
      if (/\d/.test(char)) {
        tokens.push(this.readNumber());
        continue;
      }

      // String literals (double or single quotes)
      if (char === '"' || char === "'") {
        tokens.push(this.readString());
        continue;
      }

      // Identifiers (variable names)
      if (/[a-zA-Z_]/.test(char)) {
        tokens.push(this.readIdentifier());
        continue;
      }

      // Empty collection literals are intentionally the only supported
      // collection syntax. They cover deterministic reset operations without
      // turning the safe arithmetic language into a general object parser.
      if (this.input.startsWith("[]", this.position)) {
        tokens.push({ type: "EMPTY_ARRAY", value: "[]", position: this.position });
        this.position += 2;
        continue;
      }

      if (this.input.startsWith("{}", this.position)) {
        tokens.push({ type: "EMPTY_OBJECT", value: "{}", position: this.position });
        this.position += 2;
        continue;
      }

      // Operators
      if (["+", "-", "*", "/"].includes(char)) {
        tokens.push({
          type: "OPERATOR",
          value: char,
          position: this.position,
        });
        this.position++;
        continue;
      }

      // Assignment
      if (char === "=") {
        tokens.push({
          type: "ASSIGN",
          value: "=",
          position: this.position,
        });
        this.position++;
        continue;
      }

      // Parentheses
      if (char === "(") {
        tokens.push({
          type: "LPAREN",
          value: "(",
          position: this.position,
        });
        this.position++;
        continue;
      }

      if (char === ")") {
        tokens.push({
          type: "RPAREN",
          value: ")",
          position: this.position,
        });
        this.position++;
        continue;
      }

      throw new ExpressionError(
        `Unexpected character '${char}' at position ${this.position}`,
        this.position,
      );
    }

    tokens.push({ type: "EOF", value: "", position: this.position });
    return tokens;
  }

  private readNumber(): Token {
    const start = this.position;
    let hasDecimal = false;

    while (this.position < this.input.length) {
      const char = this.input[this.position];

      if (char === "." && !hasDecimal) {
        hasDecimal = true;
        this.position++;
        continue;
      }

      if (!/\d/.test(char)) break;
      this.position++;
    }

    const value = parseFloat(this.input.slice(start, this.position));
    return { type: "NUMBER", value, position: start };
  }

  private readIdentifier(): Token {
    const start = this.position;

    while (this.position < this.input.length) {
      const char = this.input[this.position];
      // Member reads remain one lexical token. The parser/evaluator validates the
      // complete path and assignment targets separately.
      if (!/[a-zA-Z_0-9.[\]]/.test(char)) break;
      this.position++;
    }

    // Remove trailing dot if present (invalid identifier)
    let value = this.input.slice(start, this.position);
    if (value.endsWith(".")) {
      this.position--;
      value = value.slice(0, -1);
    }

    // Check for boolean keywords
    if (value === "true" || value === "false") {
      return {
        type: "BOOLEAN",
        value: value === "true",
        position: start,
      };
    }

    return {
      type: "IDENTIFIER",
      value,
      position: start,
    };
  }

  private readString(): Token {
    const start = this.position;
    const quote = this.input[this.position];
    this.position++; // skip opening quote

    let value = "";
    while (this.position < this.input.length) {
      const char = this.input[this.position];
      if (char === quote) {
        this.position++; // skip closing quote
        return { type: "STRING", value, position: start };
      }
      value += char;
      this.position++;
    }

    throw new ExpressionError(`Unterminated string literal starting at position ${start}`, start);
  }
}

/**
 * Parser - builds AST from tokens
 * Grammar:
 *   expression = assignment | additive
 *   assignment = IDENTIFIER "=" expression
 *   additive   = multiplicative (("+"|"-") multiplicative)*
 *   multiplicative = primary (("*"|"/") primary)*
 *   primary    = NUMBER | IDENTIFIER | "(" expression ")"
 */
export class Parser {
  private tokens: Token[];
  private position: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ASTNode {
    const result = this.parseExpression();

    if (this.currentToken().type !== "EOF") {
      throw new ExpressionError(
        `Unexpected token '${this.currentToken().value}' at end of expression`,
        this.currentToken().position,
      );
    }

    return result;
  }

  private currentToken(): Token {
    return this.tokens[this.position] || { type: "EOF", value: "", position: -1 };
  }

  private consume(expectedType?: TokenType): Token {
    const token = this.currentToken();

    if (expectedType && token.type !== expectedType) {
      throw new ExpressionError(`Expected ${expectedType} but got ${token.type}`, token.position);
    }

    this.position++;
    return token;
  }

  private parseExpression(): ASTNode {
    // Check for assignment: IDENTIFIER = expression
    if (this.currentToken().type === "IDENTIFIER") {
      const next = this.tokens[this.position + 1];

      if (next && next.type === "ASSIGN") {
        const identifier = this.consume("IDENTIFIER");
        const target = identifier.value as string;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || isForbiddenMember(target)) {
          throw new ExpressionError(
            `Assignment target '${target}' must be a safe bare variable name`,
            identifier.position,
          );
        }
        this.consume("ASSIGN");
        const value = this.parseExpression();

        return {
          type: "AssignmentExpression",
          target,
          value,
        };
      }
    }

    return this.parseAdditive();
  }

  private parseAdditive(): ASTNode {
    let left = this.parseMultiplicative();

    while (
      this.currentToken().type === "OPERATOR" &&
      ["+", "-"].includes(this.currentToken().value as string)
    ) {
      const operator = this.consume("OPERATOR").value as "+" | "-";
      const right = this.parseMultiplicative();

      left = {
        type: "BinaryExpression",
        operator,
        left,
        right,
      };
    }

    return left;
  }

  private parseMultiplicative(): ASTNode {
    let left = this.parsePrimary();

    while (
      this.currentToken().type === "OPERATOR" &&
      ["*", "/"].includes(this.currentToken().value as string)
    ) {
      const operator = this.consume("OPERATOR").value as "*" | "/";
      const right = this.parsePrimary();

      left = {
        type: "BinaryExpression",
        operator,
        left,
        right,
      };
    }

    return left;
  }

  private parsePrimary(): ASTNode {
    const token = this.currentToken();

    // Number literal
    if (token.type === "NUMBER") {
      this.consume("NUMBER");
      return { type: "NumberLiteral", value: token.value as number };
    }

    // String literal
    if (token.type === "STRING") {
      this.consume("STRING");
      return { type: "StringLiteral", value: token.value as string };
    }

    // Boolean literal
    if (token.type === "BOOLEAN") {
      this.consume("BOOLEAN");
      return { type: "BooleanLiteral", value: token.value as boolean };
    }

    if (token.type === "EMPTY_ARRAY") {
      this.consume("EMPTY_ARRAY");
      return { type: "EmptyArrayLiteral" };
    }

    if (token.type === "EMPTY_OBJECT") {
      this.consume("EMPTY_OBJECT");
      return { type: "EmptyObjectLiteral" };
    }

    // Identifier (variable reference)
    if (token.type === "IDENTIFIER") {
      this.consume("IDENTIFIER");
      return { type: "Identifier", name: token.value as string };
    }

    // Parenthesized expression
    if (token.type === "LPAREN") {
      this.consume("LPAREN");
      const expr = this.parseExpression();
      this.consume("RPAREN");
      return expr;
    }

    throw new ExpressionError(
      `Unexpected token '${token.value}' (type: ${token.type})`,
      token.position,
    );
  }
}

/**
 * Evaluator - executes AST against context
 */
export class Evaluator {
  private context: Record<string, unknown>;
  private assignments: Record<string, unknown> = {};

  constructor(context: Record<string, unknown>) {
    this.context = context;
  }

  evaluate(ast: ASTNode): {
    value: unknown;
    assignments: Record<string, unknown>;
  } {
    const value = this.evaluateNode(ast);
    return { value, assignments: this.assignments };
  }

  private evaluateNode(node: ASTNode): unknown {
    switch (node.type) {
      case "NumberLiteral":
        return node.value;

      case "StringLiteral":
        return node.value;

      case "BooleanLiteral":
        return node.value;

      case "EmptyArrayLiteral":
        return [];

      case "EmptyObjectLiteral":
        return {};

      case "Identifier":
        return this.resolveVariable(node.name);

      case "BinaryExpression":
        return this.evaluateBinary(node);

      case "AssignmentExpression":
        return this.evaluateAssignment(node);

      default:
        throw new ExpressionError(`Unknown AST node type: ${(node as ASTNode).type}`, -1);
    }
  }

  private resolveVariable(name: string): number | string | boolean {
    // First check assignments made in this expression, then context.
    const value = Object.prototype.hasOwnProperty.call(this.assignments, name)
      ? this.assignments[name]
      : /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
        ? Object.prototype.hasOwnProperty.call(this.context, name)
          ? this.context[name]
          : undefined
        : this.getNestedValue(this.context, name);

    if (value === undefined || value === null) {
      throw new ExpressionError(`Variable '${name}' is not defined or is null`, -1);
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "object") {
      throw new ExpressionError(`Variable '${name}' resolves to an object`, -1);
    }

    const num = Number(value);
    if (isNaN(num)) {
      throw new ExpressionError(
        `Variable '${name}' is not a number, string, or boolean (value: ${value})`,
        -1,
      );
    }

    return num;
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path);
    if (
      !root ||
      isForbiddenMember(root[0]) ||
      !Object.prototype.hasOwnProperty.call(obj, root[0])
    ) {
      throw new ExpressionError(`Invalid or unresolved member path '${path}'`, -1);
    }

    let current: unknown = obj[root[0]];
    let position = root[0].length;
    while (position < path.length) {
      if (path[position] === ".") {
        const member = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path.slice(position + 1));
        if (!member || isForbiddenMember(member[0])) {
          throw new ExpressionError(`Invalid member path '${path}'`, position);
        }
        if (
          current === null ||
          typeof current !== "object" ||
          !Object.prototype.hasOwnProperty.call(current, member[0])
        ) {
          throw new ExpressionError(`Member '${member[0]}' is not an own property`, position);
        }
        current = (current as Record<string, unknown>)[member[0]];
        position += member[0].length + 1;
        continue;
      }

      if (path[position] === "[") {
        const end = path.indexOf("]", position + 1);
        if (end === -1) throw new ExpressionError(`Unclosed array index in '${path}'`, position);
        const token = path.slice(position + 1, end);
        if (!/^\d+$/.test(token) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
          throw new ExpressionError(`Invalid array index '${token}'`, position);
        }
        const rawIndex = /^\d+$/.test(token) ? Number(token) : this.resolveIndex(token);
        if (!Number.isInteger(rawIndex) || rawIndex < 0) {
          throw new ExpressionError(
            `Array index '${token}' must resolve to a non-negative integer`,
            position,
          );
        }
        if (!Array.isArray(current) || rawIndex >= current.length) {
          throw new ExpressionError(`Array index ${rawIndex} is out of bounds`, position);
        }
        current = current[rawIndex];
        position = end + 1;
        continue;
      }

      throw new ExpressionError(`Malformed member path '${path}'`, position);
    }
    return current;
  }

  private resolveIndex(name: string): number {
    if (isForbiddenMember(name)) throw new ExpressionError(`Forbidden array index '${name}'`, -1);
    const value = Object.prototype.hasOwnProperty.call(this.assignments, name)
      ? this.assignments[name]
      : Object.prototype.hasOwnProperty.call(this.context, name)
        ? this.context[name]
        : undefined;
    if (typeof value !== "number") {
      throw new ExpressionError(`Array index '${name}' is not a number`, -1);
    }
    return value;
  }

  private evaluateBinary(node: BinaryExpression): number {
    const left = this.evaluateNode(node.left);
    const right = this.evaluateNode(node.right);

    if (typeof left !== "number" || typeof right !== "number") {
      throw new ExpressionError("Binary operations require numeric operands", -1);
    }

    switch (node.operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        if (right === 0) {
          throw new ExpressionError("Division by zero", -1);
        }
        return left / right;
      default:
        throw new ExpressionError(`Unknown operator: ${node.operator}`, -1);
    }
  }

  private evaluateAssignment(node: AssignmentExpression): unknown {
    const value = this.evaluateNode(node.value);
    this.assignments[node.target] = value;
    return value;
  }
}

const FORBIDDEN_MEMBERS = new Set(["__proto__", "prototype", "constructor"]);

function isForbiddenMember(name: string): boolean {
  return FORBIDDEN_MEMBERS.has(name);
}

/**
 * Expression Error - custom error with position info
 */
export class ExpressionError extends Error {
  position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "ExpressionError";
    this.position = position;
  }
}

/**
 * Expression Interpreter Interface - allows swapping implementations
 */
export interface IExpressionInterpreter {
  /**
   * Parse and evaluate an expression
   * @param expression Expression string (e.g., "a = b + 1")
   * @param context Current execution context variables
   * @returns Computed value and any variable assignments
   */
  evaluate(expression: string, context: Record<string, unknown>): ExpressionResult;
}

export interface ExpressionResult {
  value: unknown;
  assignments: Record<string, unknown>;
  error?: string;
}

/**
 * Default Expression Interpreter - uses our safe parser
 */
export class SafeExpressionInterpreter implements IExpressionInterpreter {
  evaluate(expression: string, context: Record<string, unknown>): ExpressionResult {
    try {
      const tokenizer = new Tokenizer(expression);
      const tokens = tokenizer.tokenize();

      const parser = new Parser(tokens);
      const ast = parser.parse();

      const evaluator = new Evaluator(context);
      return evaluator.evaluate(ast);
    } catch (error) {
      if (error instanceof ExpressionError) {
        return { value: 0, assignments: {}, error: error.message };
      }
      return {
        value: 0,
        assignments: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function parseExpressionAst(expression: string): ASTNode {
  return new Parser(new Tokenizer(expression).tokenize()).parse();
}

// Default singleton for convenience
export const defaultInterpreter = new SafeExpressionInterpreter();
