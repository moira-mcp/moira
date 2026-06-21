/**
 * Unit Tests for Expression Parser
 * Tests the safe arithmetic expression evaluator
 */

import { describe, test, expect } from "@jest/globals";
import {
  Tokenizer,
  Parser,
  Evaluator,
  SafeExpressionInterpreter,
  ExpressionError,
} from "@mcp-moira/workflow-engine";

describe("Expression Parser", () => {
  describe("Tokenizer", () => {
    test("should tokenize simple number", () => {
      const tokenizer = new Tokenizer("42");
      const tokens = tokenizer.tokenize();

      expect(tokens).toHaveLength(2); // NUMBER + EOF
      expect(tokens[0]).toEqual({ type: "NUMBER", value: 42, position: 0 });
      expect(tokens[1].type).toBe("EOF");
    });

    test("should tokenize decimal number", () => {
      const tokenizer = new Tokenizer("3.14");
      const tokens = tokenizer.tokenize();

      expect(tokens[0]).toEqual({ type: "NUMBER", value: 3.14, position: 0 });
    });

    test("should tokenize identifier", () => {
      const tokenizer = new Tokenizer("myVar");
      const tokens = tokenizer.tokenize();

      expect(tokens[0]).toEqual({ type: "IDENTIFIER", value: "myVar", position: 0 });
    });

    test("should tokenize identifier with underscore and numbers", () => {
      const tokenizer = new Tokenizer("my_var_2");
      const tokens = tokenizer.tokenize();

      expect(tokens[0]).toEqual({ type: "IDENTIFIER", value: "my_var_2", position: 0 });
    });

    test("should tokenize operators", () => {
      const tokenizer = new Tokenizer("+ - * /");
      const tokens = tokenizer.tokenize();

      expect(tokens[0]).toEqual({ type: "OPERATOR", value: "+", position: 0 });
      expect(tokens[1]).toEqual({ type: "OPERATOR", value: "-", position: 2 });
      expect(tokens[2]).toEqual({ type: "OPERATOR", value: "*", position: 4 });
      expect(tokens[3]).toEqual({ type: "OPERATOR", value: "/", position: 6 });
    });

    test("should tokenize assignment", () => {
      const tokenizer = new Tokenizer("x = 5");
      const tokens = tokenizer.tokenize();

      expect(tokens[0]).toEqual({ type: "IDENTIFIER", value: "x", position: 0 });
      expect(tokens[1]).toEqual({ type: "ASSIGN", value: "=", position: 2 });
      expect(tokens[2]).toEqual({ type: "NUMBER", value: 5, position: 4 });
    });

    test("should tokenize parentheses", () => {
      const tokenizer = new Tokenizer("(a + b)");
      const tokens = tokenizer.tokenize();

      expect(tokens[0]).toEqual({ type: "LPAREN", value: "(", position: 0 });
      expect(tokens[1]).toEqual({ type: "IDENTIFIER", value: "a", position: 1 });
      expect(tokens[2]).toEqual({ type: "OPERATOR", value: "+", position: 3 });
      expect(tokens[3]).toEqual({ type: "IDENTIFIER", value: "b", position: 5 });
      expect(tokens[4]).toEqual({ type: "RPAREN", value: ")", position: 6 });
    });

    test("should throw on unexpected character", () => {
      const tokenizer = new Tokenizer("a @ b");

      expect(() => tokenizer.tokenize()).toThrow(ExpressionError);
      expect(() => tokenizer.tokenize()).toThrow("Unexpected character '@'");
    });

    test("should handle whitespace", () => {
      const tokenizer = new Tokenizer("  x  +  y  ");
      const tokens = tokenizer.tokenize();

      expect(tokens).toHaveLength(4); // IDENTIFIER + OPERATOR + IDENTIFIER + EOF
      expect(tokens[0].type).toBe("IDENTIFIER");
      expect(tokens[1].type).toBe("OPERATOR");
      expect(tokens[2].type).toBe("IDENTIFIER");
    });
  });

  describe("Parser", () => {
    test("should parse simple number", () => {
      const tokenizer = new Tokenizer("42");
      const parser = new Parser(tokenizer.tokenize());
      const ast = parser.parse();

      expect(ast).toEqual({ type: "NumberLiteral", value: 42 });
    });

    test("should parse identifier", () => {
      const tokenizer = new Tokenizer("myVar");
      const parser = new Parser(tokenizer.tokenize());
      const ast = parser.parse();

      expect(ast).toEqual({ type: "Identifier", name: "myVar" });
    });

    test("should parse addition", () => {
      const tokenizer = new Tokenizer("1 + 2");
      const parser = new Parser(tokenizer.tokenize());
      const ast = parser.parse();

      expect(ast).toEqual({
        type: "BinaryExpression",
        operator: "+",
        left: { type: "NumberLiteral", value: 1 },
        right: { type: "NumberLiteral", value: 2 },
      });
    });

    test("should parse multiplication with correct precedence", () => {
      const tokenizer = new Tokenizer("1 + 2 * 3");
      const parser = new Parser(tokenizer.tokenize());
      const ast = parser.parse();

      // Should be: 1 + (2 * 3), not (1 + 2) * 3
      expect(ast).toEqual({
        type: "BinaryExpression",
        operator: "+",
        left: { type: "NumberLiteral", value: 1 },
        right: {
          type: "BinaryExpression",
          operator: "*",
          left: { type: "NumberLiteral", value: 2 },
          right: { type: "NumberLiteral", value: 3 },
        },
      });
    });

    test("should parse parentheses overriding precedence", () => {
      const tokenizer = new Tokenizer("(1 + 2) * 3");
      const parser = new Parser(tokenizer.tokenize());
      const ast = parser.parse();

      // Should be: (1 + 2) * 3
      expect(ast).toEqual({
        type: "BinaryExpression",
        operator: "*",
        left: {
          type: "BinaryExpression",
          operator: "+",
          left: { type: "NumberLiteral", value: 1 },
          right: { type: "NumberLiteral", value: 2 },
        },
        right: { type: "NumberLiteral", value: 3 },
      });
    });

    test("should parse assignment", () => {
      const tokenizer = new Tokenizer("x = 5");
      const parser = new Parser(tokenizer.tokenize());
      const ast = parser.parse();

      expect(ast).toEqual({
        type: "AssignmentExpression",
        target: "x",
        value: { type: "NumberLiteral", value: 5 },
      });
    });

    test("should parse assignment with expression", () => {
      const tokenizer = new Tokenizer("result = a + b * 2");
      const parser = new Parser(tokenizer.tokenize());
      const ast = parser.parse();

      expect(ast.type).toBe("AssignmentExpression");
      expect((ast as any).target).toBe("result");
      expect((ast as any).value.type).toBe("BinaryExpression");
    });

    test("should throw on unexpected token at end", () => {
      const tokenizer = new Tokenizer("1 + 2 @");

      expect(() => {
        const parser = new Parser(tokenizer.tokenize());
        parser.parse();
      }).toThrow();
    });
  });

  describe("Evaluator", () => {
    test("should evaluate number literal", () => {
      const tokenizer = new Tokenizer("42");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(42);
      expect(result.assignments).toEqual({});
    });

    test("should evaluate addition", () => {
      const tokenizer = new Tokenizer("10 + 5");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(15);
    });

    test("should evaluate subtraction", () => {
      const tokenizer = new Tokenizer("10 - 3");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(7);
    });

    test("should evaluate multiplication", () => {
      const tokenizer = new Tokenizer("6 * 7");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(42);
    });

    test("should evaluate division", () => {
      const tokenizer = new Tokenizer("20 / 4");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(5);
    });

    test("should throw on division by zero", () => {
      const tokenizer = new Tokenizer("10 / 0");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});

      expect(() => evaluator.evaluate(parser.parse())).toThrow("Division by zero");
    });

    test("should resolve context variable", () => {
      const tokenizer = new Tokenizer("x + 10");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({ x: 5 });
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(15);
    });

    test("should resolve nested context variable", () => {
      const tokenizer = new Tokenizer("step.index + 1");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({ step: { index: 3 } });
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(4);
    });

    test("should throw on undefined variable", () => {
      const tokenizer = new Tokenizer("undefined_var + 1");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});

      expect(() => evaluator.evaluate(parser.parse())).toThrow(
        "Variable 'undefined_var' is not defined",
      );
    });

    test("should throw on non-numeric variable in binary expression", () => {
      const tokenizer = new Tokenizer("name + 1");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({ name: "John" });

      expect(() => evaluator.evaluate(parser.parse())).toThrow(
        "Binary operations require numeric operands",
      );
    });

    test("should evaluate assignment and track it", () => {
      const tokenizer = new Tokenizer("x = 42");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(42);
      expect(result.assignments).toEqual({ x: 42 });
    });

    test("should evaluate assignment with expression", () => {
      const tokenizer = new Tokenizer("total = a + b");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({ a: 10, b: 20 });
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(30);
      expect(result.assignments).toEqual({ total: 30 });
    });

    test("should respect operator precedence", () => {
      const tokenizer = new Tokenizer("2 + 3 * 4");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(14); // 2 + (3 * 4) = 14
    });

    test("should handle parentheses", () => {
      const tokenizer = new Tokenizer("(2 + 3) * 4");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({});
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(20); // (2 + 3) * 4 = 20
    });

    test("should handle complex expression", () => {
      const tokenizer = new Tokenizer("(a + b) * c / 2");
      const parser = new Parser(tokenizer.tokenize());
      const evaluator = new Evaluator({ a: 10, b: 20, c: 3 });
      const result = evaluator.evaluate(parser.parse());

      expect(result.value).toBe(45); // (10 + 20) * 3 / 2 = 45
    });
  });

  describe("SafeExpressionInterpreter", () => {
    const interpreter = new SafeExpressionInterpreter();

    test("should evaluate simple expression", () => {
      const result = interpreter.evaluate("1 + 2", {});

      expect(result.value).toBe(3);
      expect(result.error).toBeUndefined();
    });

    test("should evaluate with context", () => {
      const result = interpreter.evaluate("x * 2", { x: 5 });

      expect(result.value).toBe(10);
      expect(result.error).toBeUndefined();
    });

    test("should return assignment result", () => {
      const result = interpreter.evaluate("counter = current + 1", { current: 5 });

      expect(result.value).toBe(6);
      expect(result.assignments).toEqual({ counter: 6 });
      expect(result.error).toBeUndefined();
    });

    test("should handle nested context paths", () => {
      const result = interpreter.evaluate("next_step = plan.current_step + 1", {
        plan: { current_step: 3 },
      });

      expect(result.value).toBe(4);
      expect(result.assignments).toEqual({ next_step: 4 });
    });

    test("should return error for undefined variable", () => {
      const result = interpreter.evaluate("unknown + 1", {});

      expect(result.value).toBe(0);
      expect(result.error).toContain("Variable 'unknown' is not defined");
    });

    test("should return error for invalid syntax", () => {
      const result = interpreter.evaluate("1 + + 2", {});

      expect(result.value).toBe(0);
      expect(result.error).toBeDefined();
    });

    test("should return error for division by zero", () => {
      const result = interpreter.evaluate("10 / 0", {});

      expect(result.value).toBe(0);
      expect(result.error).toContain("Division by zero");
    });

    test("should handle increment pattern", () => {
      const result = interpreter.evaluate("iteration = iteration + 1", { iteration: 0 });

      expect(result.value).toBe(1);
      expect(result.assignments).toEqual({ iteration: 1 });
    });

    test("should handle reset pattern", () => {
      const result = interpreter.evaluate("iteration = 1", {});

      expect(result.value).toBe(1);
      expect(result.assignments).toEqual({ iteration: 1 });
    });

    test("should handle decimal arithmetic", () => {
      const result = interpreter.evaluate("price * 1.1", { price: 100 });

      expect(result.value).toBeCloseTo(110);
    });
  });
});
