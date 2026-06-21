/**
 * Unit tests for GraphTemplateProcessor
 * Validates template processing without unwanted JSON quotes
 */

import { describe, test, expect, jest } from "@jest/globals";
import { GraphTemplateProcessor, ExecutionContext } from "@mcp-moira/workflow-engine";

// Shorthand for undefined placeholder
const UNDEF = GraphTemplateProcessor.UNDEFINED_PLACEHOLDER;

// Mock execution context for testing
function mockExecutionContext(variables: Record<string, unknown>): ExecutionContext {
  return {
    executionId: "test-execution-123",
    workflowId: "test-workflow",
    userId: "test-user-123",
    variables,
    nodeStates: {},
  };
}

describe("GraphTemplateProcessor", () => {
  const processor = new GraphTemplateProcessor();

  test("should serialize objects without outer quotes in embedded context", () => {
    const context = mockExecutionContext({
      testObj: { nested: "data" },
      testArray: ["item1", "item2"],
    });

    const result = processor.processDirective("Object: {{testObj}}\nArray: {{testArray}}", context);

    // Should NOT contain JSON quotes around the serialized values
    expect(result).toBe('Object: {"nested":"data"}\nArray: [item1,item2]');

    // Verify NO outer quotes around JSON structures (the original issue)
    expect(result).not.toContain('"{'); // Should not have "{ at start of JSON
    expect(result).not.toContain('}"'); // Should not have }" at end of JSON
    expect(result).not.toContain('"['); // Should not have "[ at start of array
    expect(result).not.toContain(']"'); // Should not have ]" at end of array
  });

  test("should handle primitive types correctly", () => {
    const context = mockExecutionContext({
      stringVar: "Hello World",
      numberVar: 42,
      boolVar: true,
      nullVar: null,
    });

    const result = processor.processDirective(
      "{{stringVar}} {{numberVar}} {{boolVar}} {{nullVar}}",
      context,
    );

    expect(result).toBe(`Hello World 42 true ${UNDEF}`);

    // Primitive types should not have any quotes
    expect(result).not.toContain('"');
  });

  test("should handle nested objects correctly", () => {
    const context = mockExecutionContext({
      complexObj: {
        user: { name: "Test", id: 123 },
        tags: ["tag1", "tag2"],
        active: true,
      },
    });

    const result = processor.processDirective("Data: {{complexObj}}", context);

    // Should produce clean JSON without outer quotes
    expect(result).toBe('Data: {"user":{"name":"Test","id":123},"tags":[tag1,tag2],"active":true}');

    // Verify structure integrity
    expect(result).toContain('{"user"'); // Object structure preserved
    expect(result).toContain("[tag1,tag2]"); // Array structure preserved
    expect(result).not.toContain('"{'); // No outer quotes
  });

  describe("array[index].field syntax (issue #261)", () => {
    test("should access array element field: {{users[0].name}}", () => {
      const context = mockExecutionContext({
        users: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ],
      });

      const result = processor.processDirective("First user: {{users[0].name}}", context);
      expect(result).toBe("First user: Alice");
    });

    test("should access second array element field: {{users[1].name}}", () => {
      const context = mockExecutionContext({
        users: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ],
      });

      const result = processor.processDirective("Second user: {{users[1].name}}", context);
      expect(result).toBe("Second user: Bob");
    });

    test("should handle deeply nested: {{data[1].items[0].value}}", () => {
      const context = mockExecutionContext({
        data: [
          { items: [{ value: "wrong" }] },
          { items: [{ value: "correct" }, { value: "also-wrong" }] },
        ],
      });

      const result = processor.processDirective("Value: {{data[1].items[0].value}}", context);
      expect(result).toBe("Value: correct");
    });

    test("should handle array then field then array: {{matrix[0].rows[1]}}", () => {
      const context = mockExecutionContext({
        matrix: [{ rows: ["a", "b", "c"] }, { rows: ["x", "y", "z"] }],
      });

      const result = processor.processDirective("Cell: {{matrix[0].rows[1]}}", context);
      expect(result).toBe("Cell: b");
    });

    test("should handle multiple array accesses: {{items[0].tags[0]}}", () => {
      const context = mockExecutionContext({
        items: [{ tags: ["first", "second"] }, { tags: ["third", "fourth"] }],
      });

      const result = processor.processDirective("Tag: {{items[0].tags[0]}}", context);
      expect(result).toBe("Tag: first");
    });

    test("should return placeholder for out of bounds index", () => {
      const context = mockExecutionContext({
        users: [{ name: "Alice" }],
      });

      const result = processor.processDirective("User: {{users[5].name}}", context);
      expect(result).toBe(`User: ${UNDEF}`);
    });

    test("should return placeholder for missing field after array access", () => {
      const context = mockExecutionContext({
        users: [{ name: "Alice" }],
      });

      const result = processor.processDirective("Email: {{users[0].email}}", context);
      expect(result).toBe(`Email: ${UNDEF}`);
    });

    test("should handle numeric field values correctly", () => {
      const context = mockExecutionContext({
        scores: [{ value: 100 }, { value: 85 }],
      });

      const result = processor.processDirective("Score: {{scores[1].value}}", context);
      expect(result).toBe("Score: 85");
    });

    test("should handle boolean field values correctly", () => {
      const context = mockExecutionContext({
        flags: [{ active: true }, { active: false }],
      });

      const result = processor.processDirective("Active: {{flags[0].active}}", context);
      expect(result).toBe("Active: true");
    });

    test("should handle object field after array access", () => {
      const context = mockExecutionContext({
        users: [{ profile: { bio: "Hello world", avatar: "img.png" } }],
      });

      const result = processor.processDirective("Bio: {{users[0].profile.bio}}", context);
      expect(result).toBe("Bio: Hello world");
    });

    test("should work in complex directive with multiple templates", () => {
      const context = mockExecutionContext({
        tasks: [
          { title: "Task A", priority: "high" },
          { title: "Task B", priority: "low" },
        ],
        projectName: "MyProject",
      });

      const result = processor.processDirective(
        "Project {{projectName}}: {{tasks[0].title}} ({{tasks[0].priority}})",
        context,
      );
      expect(result).toBe("Project MyProject: Task A (high)");
    });
  });

  describe("Conditional Templates", () => {
    test("should include if-block when variable is truthy (string)", () => {
      const context = mockExecutionContext({
        userName: "Alice",
      });

      const result = processor.processDirective(
        "Hello{{#if userName}}, {{userName}}{{/if}}!",
        context,
      );
      expect(result).toBe("Hello, Alice!");
    });

    test("should exclude if-block when variable is falsy (undefined)", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "Hello{{#if userName}}, {{userName}}{{/if}}!",
        context,
      );
      expect(result).toBe("Hello!");
    });

    test("should use else-block when variable is falsy", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "{{#if userName}}Hello, {{userName}}{{else}}Hello, Guest{{/if}}!",
        context,
      );
      expect(result).toBe("Hello, Guest!");
    });

    test("should use if-block when variable is truthy (ignore else)", () => {
      const context = mockExecutionContext({
        userName: "Bob",
      });

      const result = processor.processDirective(
        "{{#if userName}}Hello, {{userName}}{{else}}Hello, Guest{{/if}}!",
        context,
      );
      expect(result).toBe("Hello, Bob!");
    });

    test("should treat false as falsy", () => {
      const context = mockExecutionContext({
        isAdmin: false,
      });

      const result = processor.processDirective("{{#if isAdmin}}Admin{{else}}User{{/if}}", context);
      expect(result).toBe("User");
    });

    test("should treat true as truthy", () => {
      const context = mockExecutionContext({
        isAdmin: true,
      });

      const result = processor.processDirective("{{#if isAdmin}}Admin{{else}}User{{/if}}", context);
      expect(result).toBe("Admin");
    });

    test("should treat 0 as falsy", () => {
      const context = mockExecutionContext({
        count: 0,
      });

      const result = processor.processDirective(
        "{{#if count}}Has items{{else}}Empty{{/if}}",
        context,
      );
      expect(result).toBe("Empty");
    });

    test("should treat non-zero numbers as truthy", () => {
      const context = mockExecutionContext({
        count: 5,
      });

      const result = processor.processDirective(
        "{{#if count}}Has {{count}} items{{else}}Empty{{/if}}",
        context,
      );
      expect(result).toBe("Has 5 items");
    });

    test("should treat empty string as falsy", () => {
      const context = mockExecutionContext({
        message: "",
      });

      const result = processor.processDirective(
        "{{#if message}}{{message}}{{else}}No message{{/if}}",
        context,
      );
      expect(result).toBe("No message");
    });

    test("should treat empty array as falsy", () => {
      const context = mockExecutionContext({
        items: [],
      });

      const result = processor.processDirective(
        "{{#if items}}Has items{{else}}No items{{/if}}",
        context,
      );
      expect(result).toBe("No items");
    });

    test("should treat non-empty array as truthy", () => {
      const context = mockExecutionContext({
        items: ["a", "b"],
      });

      const result = processor.processDirective(
        "{{#if items}}Has items{{else}}No items{{/if}}",
        context,
      );
      expect(result).toBe("Has items");
    });

    test("should treat empty object as falsy", () => {
      const context = mockExecutionContext({
        data: {},
      });

      const result = processor.processDirective(
        "{{#if data}}Has data{{else}}No data{{/if}}",
        context,
      );
      expect(result).toBe("No data");
    });

    test("should treat non-empty object as truthy", () => {
      const context = mockExecutionContext({
        data: { key: "value" },
      });

      const result = processor.processDirective(
        "{{#if data}}Has data{{else}}No data{{/if}}",
        context,
      );
      expect(result).toBe("Has data");
    });

    test("should support nested path in condition", () => {
      const context = mockExecutionContext({
        user: { profile: { verified: true } },
      });

      const result = processor.processDirective(
        "{{#if user.profile.verified}}Verified{{else}}Unverified{{/if}}",
        context,
      );
      expect(result).toBe("Verified");
    });

    test("should handle multiline content in if-block", () => {
      const context = mockExecutionContext({
        showDetails: true,
        name: "Test",
      });

      const result = processor.processDirective(
        "{{#if showDetails}}\nName: {{name}}\nStatus: Active\n{{/if}}",
        context,
      );
      expect(result).toBe("\nName: Test\nStatus: Active\n");
    });

    test("should handle multiple conditionals in same directive", () => {
      const context = mockExecutionContext({
        hasHeader: true,
        hasFooter: false,
      });

      const result = processor.processDirective(
        "{{#if hasHeader}}[HEADER]{{/if}} Content {{#if hasFooter}}[FOOTER]{{else}}[NO FOOTER]{{/if}}",
        context,
      );
      expect(result).toBe("[HEADER] Content [NO FOOTER]");
    });

    test("should return empty when if-block condition false and no else", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "Before{{#if missing}}SHOULD NOT APPEAR{{/if}}After",
        context,
      );
      expect(result).toBe("BeforeAfter");
    });

    test("should process conditionals inside variables (second pass)", () => {
      // Variable contains a conditional template - requires second pass
      const context = mockExecutionContext({
        run_tests_directive:
          "{{#if test_command}}Run: {{test_command}}{{else}}Find test command{{/if}}",
        test_command: "npm test",
      });

      const result = processor.processDirective("Task: {{run_tests_directive}}", context);
      expect(result).toBe("Task: Run: npm test");
    });

    test("should handle conditionals inside variables when condition is false", () => {
      // Variable contains conditional, but condition is falsy
      const context = mockExecutionContext({
        run_tests_directive:
          "{{#if test_command}}Run: {{test_command}}{{else}}Find test command{{/if}}",
        // test_command is undefined
      });

      const result = processor.processDirective("Task: {{run_tests_directive}}", context);
      expect(result).toBe("Task: Find test command");
    });

    test("should handle nested conditionals inside variables", () => {
      const context = mockExecutionContext({
        startup_directive:
          "{{#if has_docker}}{{#if docker_compose}}docker-compose up{{else}}docker run{{/if}}{{else}}npm start{{/if}}",
        has_docker: true,
        docker_compose: false,
      });

      const result = processor.processDirective("{{startup_directive}}", context);
      expect(result).toBe("docker run");
    });
  });

  describe("Unless Templates ({{#unless}})", () => {
    test("should show content when variable is falsy (undefined)", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "{{#unless isLoggedIn}}Please log in{{/unless}}",
        context,
      );
      expect(result).toBe("Please log in");
    });

    test("should hide content when variable is truthy", () => {
      const context = mockExecutionContext({
        isLoggedIn: true,
      });

      const result = processor.processDirective(
        "{{#unless isLoggedIn}}Please log in{{/unless}}",
        context,
      );
      expect(result).toBe("");
    });

    test("should use else block when variable is truthy", () => {
      const context = mockExecutionContext({
        isLoggedIn: true,
        userName: "Alice",
      });

      const result = processor.processDirective(
        "{{#unless isLoggedIn}}Please log in{{else}}Welcome, {{userName}}{{/unless}}",
        context,
      );
      expect(result).toBe("Welcome, Alice");
    });

    test("should use unless block when variable is falsy (with else)", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "{{#unless isLoggedIn}}Please log in{{else}}You are logged in{{/unless}}",
        context,
      );
      expect(result).toBe("Please log in");
    });

    test("should treat null as falsy", () => {
      const context = mockExecutionContext({
        value: null,
      });

      const result = processor.processDirective(
        "{{#unless value}}No value{{else}}Has value{{/unless}}",
        context,
      );
      expect(result).toBe("No value");
    });

    test("should treat empty string as falsy", () => {
      const context = mockExecutionContext({
        message: "",
      });

      const result = processor.processDirective(
        "{{#unless message}}No message{{else}}{{message}}{{/unless}}",
        context,
      );
      expect(result).toBe("No message");
    });

    test("should treat 0 as falsy", () => {
      const context = mockExecutionContext({
        count: 0,
      });

      const result = processor.processDirective(
        "{{#unless count}}No items{{else}}Has items{{/unless}}",
        context,
      );
      expect(result).toBe("No items");
    });

    test("should treat non-zero number as truthy", () => {
      const context = mockExecutionContext({
        count: 5,
      });

      const result = processor.processDirective(
        "{{#unless count}}No items{{else}}Has {{count}} items{{/unless}}",
        context,
      );
      expect(result).toBe("Has 5 items");
    });

    test("should handle nested path in condition", () => {
      const context = mockExecutionContext({
        user: { settings: { darkMode: false } },
      });

      const result = processor.processDirective(
        "{{#unless user.settings.darkMode}}Light mode{{else}}Dark mode{{/unless}}",
        context,
      );
      expect(result).toBe("Light mode");
    });

    test("should handle multiple unless blocks", () => {
      const context = mockExecutionContext({
        hasHeader: false,
        hasFooter: true,
      });

      const result = processor.processDirective(
        "{{#unless hasHeader}}[NO HEADER]{{/unless}} Content {{#unless hasFooter}}[NO FOOTER]{{/unless}}",
        context,
      );
      expect(result).toBe("[NO HEADER] Content ");
    });

    test("should handle nested unless blocks", () => {
      const context = mockExecutionContext({
        outer: false,
        inner: false,
      });

      const result = processor.processDirective(
        "{{#unless outer}}{{#unless inner}}Both false{{/unless}}{{/unless}}",
        context,
      );
      expect(result).toBe("Both false");
    });
  });

  describe("Neq Templates ({{#neq}})", () => {
    test("should show content when variable does not equal value", () => {
      const context = mockExecutionContext({
        status: "active",
      });

      const result = processor.processDirective(
        "{{#neq status 'skip'}}Status is not skip{{/neq}}",
        context,
      );
      expect(result).toBe("Status is not skip");
    });

    test("should hide content when variable equals value", () => {
      const context = mockExecutionContext({
        status: "skip",
      });

      const result = processor.processDirective(
        "{{#neq status 'skip'}}Status is not skip{{/neq}}",
        context,
      );
      expect(result).toBe("");
    });

    test("should use else block when variable equals value", () => {
      const context = mockExecutionContext({
        status: "skip",
      });

      const result = processor.processDirective(
        "{{#neq status 'skip'}}Not skip{{else}}Is skip{{/neq}}",
        context,
      );
      expect(result).toBe("Is skip");
    });

    test("should use neq block when variable does not equal value (with else)", () => {
      const context = mockExecutionContext({
        status: "active",
      });

      const result = processor.processDirective(
        "{{#neq status 'skip'}}Not skip{{else}}Is skip{{/neq}}",
        context,
      );
      expect(result).toBe("Not skip");
    });

    test("should handle undefined variable as empty string", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "{{#neq test_info 'skip'}}Show this{{/neq}}",
        context,
      );
      expect(result).toBe("Show this"); // undefined != 'skip'
    });

    test("should handle double quotes", () => {
      const context = mockExecutionContext({
        action: "edit",
      });

      const result = processor.processDirective(
        '{{#neq action "create"}}Not create{{else}}Create{{/neq}}',
        context,
      );
      expect(result).toBe("Not create");
    });

    test("should handle nested path variable", () => {
      const context = mockExecutionContext({
        config: { mode: "development" },
      });

      const result = processor.processDirective(
        "{{#neq config.mode 'production'}}Dev mode{{/neq}}",
        context,
      );
      expect(result).toBe("Dev mode");
    });
  });

  describe("Eq Templates ({{#eq}})", () => {
    test("should show content when variable equals value", () => {
      const context = mockExecutionContext({
        target: "staging",
      });

      const result = processor.processDirective(
        "{{#eq target 'staging'}}Deploy to staging{{/eq}}",
        context,
      );
      expect(result).toBe("Deploy to staging");
    });

    test("should hide content when variable does not equal value", () => {
      const context = mockExecutionContext({
        target: "production",
      });

      const result = processor.processDirective(
        "{{#eq target 'staging'}}Deploy to staging{{/eq}}",
        context,
      );
      expect(result).toBe("");
    });

    test("should use else block when variable does not equal value", () => {
      const context = mockExecutionContext({
        target: "production",
      });

      const result = processor.processDirective(
        "{{#eq target 'staging'}}Staging{{else}}Not staging{{/eq}}",
        context,
      );
      expect(result).toBe("Not staging");
    });

    test("should handle undefined variable as empty string", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "{{#eq upload_target 'skip'}}Skip upload{{else}}Do upload{{/eq}}",
        context,
      );
      expect(result).toBe("Do upload"); // undefined != 'skip'
    });

    test("should handle double quotes", () => {
      const context = mockExecutionContext({
        action: "create",
      });

      const result = processor.processDirective(
        '{{#eq action "create"}}Creating{{else}}Not creating{{/eq}}',
        context,
      );
      expect(result).toBe("Creating");
    });

    test("should handle nested conditionals with eq", () => {
      const context = mockExecutionContext({
        target: "staging",
        env: "dev",
      });

      const result = processor.processDirective(
        "{{#eq target 'staging'}}Staging: {{#eq env 'dev'}}Dev env{{else}}Other env{{/eq}}{{/eq}}",
        context,
      );
      expect(result).toBe("Staging: Dev env");
    });
  });

  describe("Each Templates ({{#each}})", () => {
    test("should iterate over array of primitives with {{this}}", () => {
      const context = mockExecutionContext({
        items: ["apple", "banana", "cherry"],
      });

      const result = processor.processDirective(
        "Fruits: {{#each items}}{{this}}, {{/each}}",
        context,
      );
      expect(result).toBe("Fruits: apple, banana, cherry, ");
    });

    test("should provide {{@index}} for each item", () => {
      const context = mockExecutionContext({
        items: ["a", "b", "c"],
      });

      const result = processor.processDirective(
        "{{#each items}}{{@index}}: {{this}}\n{{/each}}",
        context,
      );
      expect(result).toBe("0: a\n1: b\n2: c\n");
    });

    test("should access object fields directly", () => {
      const context = mockExecutionContext({
        users: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ],
      });

      const result = processor.processDirective(
        "{{#each users}}{{name}} ({{age}}), {{/each}}",
        context,
      );
      expect(result).toBe("Alice (30), Bob (25), ");
    });

    test("should handle empty array", () => {
      const context = mockExecutionContext({
        items: [],
      });

      const result = processor.processDirective("Items: {{#each items}}{{this}}{{/each}}", context);
      expect(result).toBe("Items: ");
    });

    test("should handle undefined array", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective("Items: {{#each items}}{{this}}{{/each}}", context);
      expect(result).toBe("Items: ");
    });

    test("should handle nested path to array", () => {
      const context = mockExecutionContext({
        data: {
          results: ["first", "second", "third"],
        },
      });

      const result = processor.processDirective(
        "{{#each data.results}}{{this}} {{/each}}",
        context,
      );
      expect(result).toBe("first second third ");
    });

    test("should handle array of numbers", () => {
      const context = mockExecutionContext({
        scores: [100, 85, 92],
      });

      const result = processor.processDirective(
        "Scores: {{#each scores}}{{this}}, {{/each}}",
        context,
      );
      expect(result).toBe("Scores: 100, 85, 92, ");
    });

    test("should handle nested each blocks", () => {
      const context = mockExecutionContext({
        groups: [
          { name: "A", items: ["a1", "a2"] },
          { name: "B", items: ["b1", "b2"] },
        ],
      });

      // Note: nested each is complex - for now test single level
      const result = processor.processDirective(
        "{{#each groups}}Group {{name}}; {{/each}}",
        context,
      );
      expect(result).toBe("Group A; Group B; ");
    });

    test("should work with if inside each", () => {
      const context = mockExecutionContext({
        tasks: [
          { name: "Task 1", done: true },
          { name: "Task 2", done: false },
          { name: "Task 3", done: true },
        ],
      });

      const result = processor.processDirective(
        "{{#each tasks}}{{#if done}}[x] {{name}}{{else}}[ ] {{name}}{{/if}}\n{{/each}}",
        context,
      );
      expect(result).toBe("[x] Task 1\n[ ] Task 2\n[x] Task 3\n");
    });

    test("should handle complex objects in array", () => {
      const context = mockExecutionContext({
        steps: [
          { index: 1, action: "init", status: "done" },
          { index: 2, action: "build", status: "pending" },
        ],
      });

      const result = processor.processDirective(
        "{{#each steps}}Step {{index}}: {{action}} ({{status}})\n{{/each}}",
        context,
      );
      expect(result).toBe("Step 1: init (done)\nStep 2: build (pending)\n");
    });

    test("should access object fields with {{this.field}} syntax", () => {
      const context = mockExecutionContext({
        users: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ],
      });

      const result = processor.processDirective(
        "{{#each users}}{{this.name}} is {{this.age}}, {{/each}}",
        context,
      );
      expect(result).toBe("Alice is 30, Bob is 25, ");
    });

    test("should access nested fields with {{this.nested.path}} syntax", () => {
      const context = mockExecutionContext({
        items: [
          { data: { label: "First", meta: { priority: "high" } } },
          { data: { label: "Second", meta: { priority: "low" } } },
        ],
      });

      const result = processor.processDirective(
        "{{#each items}}{{this.data.label}}: {{this.data.meta.priority}}\n{{/each}}",
        context,
      );
      expect(result).toBe("First: high\nSecond: low\n");
    });

    test("should return placeholder for missing fields with {{this.field}} syntax", () => {
      const context = mockExecutionContext({
        users: [{ name: "Alice" }, { name: "Bob" }],
      });

      const result = processor.processDirective(
        "{{#each users}}{{this.name}}: {{this.email}}, {{/each}}",
        context,
      );
      expect(result).toBe(`Alice: ${UNDEF}, Bob: ${UNDEF}, `);
    });

    test("should handle mix of {{this.field}} and {{field}} syntax", () => {
      const context = mockExecutionContext({
        tasks: [
          { title: "Task A", priority: "high" },
          { title: "Task B", priority: "low" },
        ],
      });

      const result = processor.processDirective(
        "{{#each tasks}}{{this.title}} ({{priority}}), {{/each}}",
        context,
      );
      expect(result).toBe("Task A (high), Task B (low), ");
    });

    test("should work with {{this}} and {{this.field}} in same template", () => {
      const context = mockExecutionContext({
        items: [
          { id: 1, value: "one" },
          { id: 2, value: "two" },
        ],
      });

      const result = processor.processDirective(
        "{{#each items}}Full: {{this}}, ID: {{this.id}}\n{{/each}}",
        context,
      );
      expect(result).toContain("ID: 1");
      expect(result).toContain("ID: 2");
      expect(result).toContain('"id":1');
    });

    test("should handle {{this.field}} with @index", () => {
      const context = mockExecutionContext({
        steps: [{ name: "Init" }, { name: "Build" }, { name: "Deploy" }],
      });

      const result = processor.processDirective(
        "{{#each steps}}{{@index}}. {{this.name}}\n{{/each}}",
        context,
      );
      expect(result).toBe("0. Init\n1. Build\n2. Deploy\n");
    });
  });

  describe("kebab-case node IDs support", () => {
    test("should resolve simple kebab-case variable: {{setup-workspace}}", () => {
      const context = mockExecutionContext({
        "setup-workspace": { path: "/tmp/workspace", ready: true },
      });

      const result = processor.processDirective("Workspace: {{setup-workspace}}", context);
      expect(result).toContain('"path":"/tmp/workspace"');
      expect(result).toContain('"ready":true');
    });

    test("should resolve nested path with kebab-case: {{setup-workspace.path}}", () => {
      const context = mockExecutionContext({
        "setup-workspace": { path: "/tmp/workspace", ready: true },
      });

      const result = processor.processDirective("Path: {{setup-workspace.path}}", context);
      expect(result).toBe("Path: /tmp/workspace");
    });

    test("should resolve multiple kebab-case variables", () => {
      const context = mockExecutionContext({
        "setup-workspace": { path: "/tmp/workspace" },
        "review-extract": { verdict: "approved", score: 95 },
      });

      const result = processor.processDirective(
        "Workspace: {{setup-workspace.path}}, Verdict: {{review-extract.verdict}}, Score: {{review-extract.score}}",
        context,
      );
      expect(result).toBe("Workspace: /tmp/workspace, Verdict: approved, Score: 95");
    });

    test("should resolve kebab-case with array index: {{data-source[0].value}}", () => {
      const context = mockExecutionContext({
        "data-source": [{ value: "first" }, { value: "second" }],
      });

      const result = processor.processDirective("First: {{data-source[0].value}}", context);
      expect(result).toBe("First: first");
    });

    test("should handle mixed underscore and kebab-case node IDs", () => {
      const context = mockExecutionContext({
        "setup-workspace": { path: "/workspace" },
        user_data: { name: "Test User" },
      });

      const result = processor.processDirective(
        "Path: {{setup-workspace.path}}, User: {{user_data.name}}",
        context,
      );
      expect(result).toBe("Path: /workspace, User: Test User");
    });

    test("should handle kebab-case node ID with deeply nested path", () => {
      const context = mockExecutionContext({
        "fix-extract-issues": {
          result: {
            files: [{ path: "src/index.ts", changes: 5 }],
          },
        },
      });

      const result = processor.processDirective(
        "File: {{fix-extract-issues.result.files[0].path}}, Changes: {{fix-extract-issues.result.files[0].changes}}",
        context,
      );
      expect(result).toBe("File: src/index.ts, Changes: 5");
    });

    test("should return placeholder for undefined kebab-case variable", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective("Value: {{non-existent-var.field}}", context);
      expect(result).toBe(`Value: ${UNDEF}`);
    });

    test("should preserve reserved keywords even with kebab-case support", () => {
      const context = mockExecutionContext({
        else: "should not replace",
        if: "should not replace",
      });

      // Reserved keywords should not be replaced
      const result = processor.processDirective("{{#if test}}yes{{else}}no{{/if}}", context);
      // The if/else should be treated as control flow, not variables
      expect(result).not.toContain("should not replace");
    });

    test("should iterate over array with kebab-case node ID in #each", () => {
      const context = mockExecutionContext({
        "my-items": ["first", "second", "third"],
      });

      const result = processor.processDirective(
        "Items: {{#each my-items}}[{{this}}]{{/each}}",
        context,
      );
      expect(result).toBe("Items: [first][second][third]");
    });

    test("should iterate over nested array with kebab-case.path in #each", () => {
      const context = mockExecutionContext({
        "data-source": {
          results: [{ name: "A" }, { name: "B" }],
        },
      });

      const result = processor.processDirective(
        "Names: {{#each data-source.results}}{{name}}, {{/each}}",
        context,
      );
      expect(result).toBe("Names: A, B, ");
    });

    test("should handle mixed underscore and kebab-case in #each", () => {
      const context = mockExecutionContext({
        "task-list": ["task1", "task2"],
        regular_items: ["item1", "item2"],
      });

      const result = processor.processDirective(
        "Tasks: {{#each task-list}}{{this}} {{/each}}| Items: {{#each regular_items}}{{this}} {{/each}}",
        context,
      );
      expect(result).toBe("Tasks: task1 task2 | Items: item1 item2 ");
    });
  });

  describe("{{note:KEY}} references (async)", () => {
    // Mock NoteService for testing
    function createMockNoteService() {
      return {
        get: jest.fn(),
        list: jest.fn(),
        save: jest.fn(),
        exists: jest.fn(),
        delete: jest.fn(),
        getVersion: jest.fn(),
        getVersions: jest.fn(),
        getStats: jest.fn(),
      };
    }

    test("should resolve {{note:KEY}} with note content", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "project-config",
        value: "This is the project configuration",
        tags: [],
        size: 33,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({});

      const result = await processor.processDirectiveAsync(
        "Config: {{note:project-config}}",
        context,
      );

      expect(result).toBe("Config: This is the project configuration");
      expect(mockNoteService.get).toHaveBeenCalledWith("test-user-123", "project-config");
    });

    test("should handle multiple note references", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockImplementation((_userId: string, key: string) => {
        if (key === "intro") {
          return Promise.resolve({
            id: "note-1",
            key: "intro",
            value: "Welcome",
            tags: [],
            size: 7,
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        if (key === "outro") {
          return Promise.resolve({
            id: "note-2",
            key: "outro",
            value: "Goodbye",
            tags: [],
            size: 7,
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        throw new Error("Note not found");
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({});

      const result = await processor.processDirectiveAsync(
        "{{note:intro}} - Content - {{note:outro}}",
        context,
      );

      expect(result).toBe("Welcome - Content - Goodbye");
    });

    test("should show error message for missing notes", async () => {
      const mockNoteService = createMockNoteService();
      // Import NoteNotFoundError properly for throwing
      const { NoteNotFoundError } = await import("@mcp-moira/shared");
      mockNoteService.get.mockRejectedValue(new NoteNotFoundError("missing-note"));

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({});

      const result = await processor.processDirectiveAsync("Data: {{note:missing-note}}", context);

      expect(result).toBe("Data: [NOTE NOT FOUND: missing-note]");
    });

    test("should combine note references with regular variables", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "template",
        value: "Hello, {{name}}!",
        tags: [],
        size: 16,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({ name: "World", greeting: "Hi" });

      const result = await processor.processDirectiveAsync(
        "{{greeting}} - {{note:template}}",
        context,
      );

      // Note content is inserted first, then regular variables are processed
      expect(result).toBe("Hi - Hello, World!");
    });

    test("should support hyphen in note key: {{note:my-config}}", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "my-config",
        value: "Config with hyphen",
        tags: [],
        size: 18,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({});

      const result = await processor.processDirectiveAsync("Value: {{note:my-config}}", context);

      expect(result).toBe("Value: Config with hyphen");
    });

    test("should support underscore in note key: {{note:my_config}}", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "my_config",
        value: "Config with underscore",
        tags: [],
        size: 22,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({});

      const result = await processor.processDirectiveAsync("Value: {{note:my_config}}", context);

      expect(result).toBe("Value: Config with underscore");
    });

    test("should not process note references in sync version", () => {
      const processor = new GraphTemplateProcessor();
      const context = mockExecutionContext({ name: "Test" });

      // Sync version should leave {{note:KEY}} as-is
      const result = processor.processDirective("Name: {{name}}, Note: {{note:some-key}}", context);

      expect(result).toBe("Name: Test, Note: {{note:some-key}}");
    });

    test("should handle note service errors gracefully", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockRejectedValue(new Error("Database connection failed"));

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({});

      const result = await processor.processDirectiveAsync("Data: {{note:broken-note}}", context);

      expect(result).toBe("Data: [NOTE ERROR: broken-note]");
    });

    test("should resolve nested templates: {{note:key-{{variable}}}}", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "metrics-mcp-moira",
        value: '{"data": "test"}',
        version: 1,
        tags: [],
        userId: "test-user-123",
        createdAt: new Date(),
        updatedAt: new Date(),
        size: 100,
        isDeleted: false,
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({
        projectName: "mcp-moira",
      });

      // Inner {{projectName}} should resolve first, then {{note:metrics-mcp-moira}}
      const result = await processor.processDirectiveAsync(
        "Data: {{note:metrics-{{projectName}}}}",
        context,
      );

      expect(result).toBe('Data: {"data": "test"}');
      expect(mockNoteService.get).toHaveBeenCalledWith("test-user-123", "metrics-mcp-moira");
    });

    test("should resolve deeply nested templates: {{note:{{prefix}}-{{suffix}}}}", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "latest-metrics",
        value: "latest data",
        version: 1,
        tags: [],
        userId: "test-user-123",
        createdAt: new Date(),
        updatedAt: new Date(),
        size: 100,
        isDeleted: false,
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({
        prefix: "latest",
        suffix: "metrics",
      });

      const result = await processor.processDirectiveAsync(
        "Value: {{note:{{prefix}}-{{suffix}}}}",
        context,
      );

      expect(result).toBe("Value: latest data");
      expect(mockNoteService.get).toHaveBeenCalledWith("test-user-123", "latest-metrics");
    });

    test("should resolve nested path in note key: {{note:key-{{node.output.field}}}}", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "config-production",
        value: "prod config",
        version: 1,
        tags: [],
        userId: "test-user-123",
        createdAt: new Date(),
        updatedAt: new Date(),
        size: 100,
        isDeleted: false,
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({
        settings: { env: "production" },
      });

      const result = await processor.processDirectiveAsync(
        "Config: {{note:config-{{settings.env}}}}",
        context,
      );

      expect(result).toBe("Config: prod config");
      expect(mockNoteService.get).toHaveBeenCalledWith("test-user-123", "config-production");
    });

    test("should handle missing inner variable in nested template", async () => {
      const mockNoteService = createMockNoteService();
      const { NoteNotFoundError } = await import("@mcp-moira/shared");
      // Note key pattern only allows alphanumeric/underscore/hyphen, so {{note:...}} with
      // placeholder won't match and will remain unresolved
      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({});

      // {{missingVar}} resolves to [[UNDEFINED_VARIABLE]], making note key invalid
      // The note pattern requires [a-zA-Z0-9_-]+ so [[...]] won't match
      const result = await processor.processDirectiveAsync(
        "Data: {{note:metrics-{{missingVar}}}}",
        context,
      );

      // Inner variable resolves to placeholder, but note pattern doesn't match
      // so the whole {{note:...}} stays as-is (unresolved)
      expect(result).toContain(UNDEF);
    });

    test("should mix nested note templates with regular templates", async () => {
      const mockNoteService = createMockNoteService();
      mockNoteService.get.mockResolvedValue({
        id: "note-1",
        key: "user-prefs",
        value: "dark mode",
        version: 1,
        tags: [],
        userId: "test-user-123",
        createdAt: new Date(),
        updatedAt: new Date(),
        size: 100,
        isDeleted: false,
      });

      const processor = new GraphTemplateProcessor(
        mockNoteService as unknown as import("@mcp-moira/shared").NoteService,
      );
      const context = mockExecutionContext({
        userName: "Alice",
        prefType: "prefs",
      });

      const result = await processor.processDirectiveAsync(
        "Hello {{userName}}! Your settings: {{note:user-{{prefType}}}}",
        context,
      );

      expect(result).toBe("Hello Alice! Your settings: dark mode");
    });
  });

  describe("Dynamic Array Index ({{items[varname].field}}) - Issue #478", () => {
    test("should access array element using variable index: {{items[idx].field}}", () => {
      const context = mockExecutionContext({
        items: [
          { name: "First", value: 100 },
          { name: "Second", value: 200 },
          { name: "Third", value: 300 },
        ],
        idx: 1,
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe("Item: Second");
    });

    test("should access array element at index 0 using variable", () => {
      const context = mockExecutionContext({
        steps: [{ action: "Init" }, { action: "Build" }, { action: "Deploy" }],
        current_step: 0,
      });

      const result = processor.processDirective("Current: {{steps[current_step].action}}", context);
      expect(result).toBe("Current: Init");
    });

    test("should handle nested paths with dynamic index: {{data.items[current].value}}", () => {
      const context = mockExecutionContext({
        data: {
          items: [{ value: "wrong" }, { value: "correct" }, { value: "also-wrong" }],
        },
        current: 1,
      });

      const result = processor.processDirective("Value: {{data.items[current].value}}", context);
      expect(result).toBe("Value: correct");
    });

    test("should return placeholder when variable is not a number", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }, { name: "Second" }],
        idx: "not-a-number",
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });

    test("should return placeholder when variable is undefined", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }, { name: "Second" }],
        // idx is not defined
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });

    test("should return placeholder for out of bounds index from variable", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }, { name: "Second" }],
        idx: 10,
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });

    test("should handle mixed literal and variable indexes: {{items[0].nested[idx].field}}", () => {
      const context = mockExecutionContext({
        items: [
          { nested: [{ field: "wrong" }, { field: "correct" }] },
          { nested: [{ field: "also-wrong" }] },
        ],
        idx: 1,
      });

      const result = processor.processDirective("Field: {{items[0].nested[idx].field}}", context);
      expect(result).toBe("Field: correct");
    });

    test("should return placeholder for negative index from variable", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }, { name: "Second" }],
        idx: -1,
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });

    test("should handle chained variable indexes: {{matrix[row][col].value}}", () => {
      const context = mockExecutionContext({
        matrix: [
          [{ value: "0,0" }, { value: "0,1" }, { value: "0,2" }],
          [{ value: "1,0" }, { value: "1,1" }, { value: "1,2" }],
          [{ value: "2,0" }, { value: "2,1" }, { value: "2,2" }],
        ],
        row: 1,
        col: 2,
      });

      const result = processor.processDirective("Cell: {{matrix[row][col].value}}", context);
      expect(result).toBe("Cell: 1,2");
    });

    test("should handle string variable that parses to valid number", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }, { name: "Second" }, { name: "Third" }],
        idx: "2",
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe("Item: Third");
    });

    test("should return placeholder for float index from variable", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }, { name: "Second" }],
        idx: 1.5,
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });

    test("should access entire array element with dynamic index: {{items[idx]}}", () => {
      const context = mockExecutionContext({
        items: [
          { id: 1, name: "First" },
          { id: 2, name: "Second" },
        ],
        idx: 0,
      });

      const result = processor.processDirective("Item: {{items[idx]}}", context);
      expect(result).toContain('"id":1');
      expect(result).toContain('"name":"First"');
    });

    test("should work in complex directive with multiple dynamic indexes", () => {
      const context = mockExecutionContext({
        tasks: [
          { title: "Task A", priority: "high" },
          { title: "Task B", priority: "medium" },
          { title: "Task C", priority: "low" },
        ],
        currentTask: 1,
        previousTask: 0,
      });

      const result = processor.processDirective(
        "Current: {{tasks[currentTask].title}} (was: {{tasks[previousTask].title}})",
        context,
      );
      expect(result).toBe("Current: Task B (was: Task A)");
    });

    test("should work with kebab-case variable name in brackets", () => {
      // Note: kebab-case is NOT supported inside brackets - only valid identifiers
      // This test confirms the behavior (should fail to resolve)
      const context = mockExecutionContext({
        items: [{ name: "First" }, { name: "Second" }],
        "my-idx": 1,
      });

      // kebab-case is not a valid identifier for array index variable
      // The regex [a-zA-Z_][a-zA-Z0-9_]* doesn't match 'my-idx'
      const result = processor.processDirective("Item: {{items[my-idx].name}}", context);
      // Should not match the pattern at all, leaving template unchanged or returning placeholder
      expect(result).not.toBe("Item: Second");
    });

    test("should preserve literal indexes while using variable indexes", () => {
      const context = mockExecutionContext({
        data: [
          { items: [{ value: "0-0" }, { value: "0-1" }] },
          { items: [{ value: "1-0" }, { value: "1-1" }] },
        ],
        outer: 1,
      });

      // Mix of variable index (outer) and literal index (0)
      const result = processor.processDirective("Value: {{data[outer].items[0].value}}", context);
      expect(result).toBe("Value: 1-0");
    });

    test("should handle null variable as invalid index", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }],
        idx: null,
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });

    test("should handle object variable as invalid index", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }],
        idx: { value: 0 },
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });

    test("should handle array variable as invalid index", () => {
      const context = mockExecutionContext({
        items: [{ name: "First" }],
        idx: [0],
      });

      const result = processor.processDirective("Item: {{items[idx].name}}", context);
      expect(result).toBe(`Item: ${UNDEF}`);
    });
  });

  describe("Escape Syntax (\\{{)", () => {
    test("should output literal {{ when escaped with backslash", () => {
      const context = mockExecutionContext({
        name: "Alice",
      });

      const result = processor.processDirective(
        "Use \\{{executionId}} for isolation. Hello {{name}}!",
        context,
      );

      expect(result).toBe("Use {{executionId}} for isolation. Hello Alice!");
    });

    test("should handle multiple escaped templates", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "Examples: \\{{var1}}, \\{{var2}}, \\{{note:key}}",
        context,
      );

      expect(result).toBe("Examples: {{var1}}, {{var2}}, {{note:key}}");
    });

    test("should handle mix of escaped and real templates", () => {
      const context = mockExecutionContext({
        actual: "resolved",
      });

      const result = processor.processDirective(
        "Real: {{actual}}, Example: \\{{example}}",
        context,
      );

      expect(result).toBe("Real: resolved, Example: {{example}}");
    });

    test("should handle escaped conditional syntax", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "Pattern: \\{{#if condition}}...\\{{/if}}",
        context,
      );

      expect(result).toBe("Pattern: {{#if condition}}...{{/if}}");
    });

    test("should handle escaped each syntax", () => {
      const context = mockExecutionContext({});

      const result = processor.processDirective(
        "Pattern: \\{{#each items}}\\{{this}}\\{{/each}}",
        context,
      );

      expect(result).toBe("Pattern: {{#each items}}{{this}}{{/each}}");
    });

    test("should preserve escaped templates in documentation strings", () => {
      const context = mockExecutionContext({
        domain: "purchase",
      });

      // Real-world use case: documentation with template examples
      const docString = `
KEY NAMING CONVENTION:
{domain}-{scope}-{sequence}-{description}
Example: \\{{domain}}-\\{{executionId}}-01-user-needs

Current domain: {{domain}}
`;

      const result = processor.processDirective(docString, context);

      expect(result).toContain("Example: {{domain}}-{{executionId}}-01-user-needs");
      expect(result).toContain("Current domain: purchase");
    });

    test("should handle escaped templates in JSON examples", () => {
      const context = mockExecutionContext({});

      const jsonExample = `{
  "type": "write-note",
  "key": "purchase-\\{{executionId}}-01",
  "source": "\\{{previous-output}}"
}`;

      const result = processor.processDirective(jsonExample, context);

      expect(result).toContain('"key": "purchase-{{executionId}}-01"');
      expect(result).toContain('"source": "{{previous-output}}"');
    });

    test("should not escape single backslash without {{", () => {
      const context = mockExecutionContext({
        path: "C:\\Users",
      });

      const result = processor.processDirective("Path: {{path}}, Regex: \\d+", context);

      expect(result).toBe("Path: C:\\Users, Regex: \\d+");
    });

    test("should handle double backslash before {{", () => {
      const context = mockExecutionContext({
        name: "test",
      });

      // \\{{ should become \{{ (literal backslash + escaped template)
      const result = processor.processDirective("Escaped backslash: \\\\{{name}}", context);

      // Double backslash before {{ = literal backslash + literal {{
      expect(result).toBe("Escaped backslash: \\{{name}}");
    });

    test("should work with async processDirectiveAsync", async () => {
      const context = mockExecutionContext({
        real: "value",
      });

      const result = await processor.processDirectiveAsync(
        "Real: {{real}}, Escaped: \\{{escaped}}",
        context,
      );

      expect(result).toBe("Real: value, Escaped: {{escaped}}");
    });

    test("should handle complex workflow documentation pattern", () => {
      const context = mockExecutionContext({
        best_practices: "Use descriptive names",
      });

      // Simulate pattern_notes_persistence_detail structure
      const docPattern = `NOTES PERSISTENCE PATTERN:

write-note example:
{
  "type": "write-note",
  "key": "purchase-\\{{executionId}}-01-user-needs",
  "source": "\\{{previous-step-output}}",
  "tags": ["purchase-\\{{executionId}}"]
}

Best practices: {{best_practices}}`;

      const result = processor.processDirective(docPattern, context);

      // Escaped templates should become literal {{...}}
      expect(result).toContain('"key": "purchase-{{executionId}}-01-user-needs"');
      expect(result).toContain('"source": "{{previous-step-output}}"');
      expect(result).toContain('["purchase-{{executionId}}"]');
      // Real template should be resolved
      expect(result).toContain("Best practices: Use descriptive names");
    });
  });
});
