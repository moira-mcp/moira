/** Executable routing and authority contract for the bundled Agentic Screencast Video. */
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

const workflow = (): WorkflowGraph => catalogGraph("agentic-screencast-video");
const progress = {
  progress_goal: "Проверенный скринкаст продукта",
  progress_setup_outcome: "Среда и полномочия подтверждены",
  progress_facts_outcome: "Факты приняты",
  progress_story_outcome: "Сценарий принят",
  progress_material_outcome: "Черновик принят",
  progress_voice_outcome: "Звук принят",
  progress_final_outcome: "MP4 принят",
  progress_delivery_outcome: "Результат локально доступен",
};
const { progress_goal: _goal, ...downstreamProgress } = progress;

const intake = (overrides: Record<string, unknown> = {}) => ({
  operating_mode: "autonomous",
  workspace_path: "./moira-ws/agentic-screencast-test/",
  product_source: "local-product",
  product_ref: "fixed-revision",
  film_goal: "Показать реальную функцию продукта",
  audience: "Пользователи",
  delivery_context: "Локальный просмотр",
  target_duration_seconds: 80,
  film_language: "ru",
  voice_mode: "silent",
  voice_engine: "stub",
  voice_name: "silent",
  allow_paid_synthesis: false,
  allow_commit: false,
  allow_external_delivery: false,
  capture_access_authorized: false,
  review_mode: "self",
  synthesis_cost: "paid_or_unknown",
  ...progress,
  ...overrides,
});

const ordinaryInputs = (): Record<string, MockInput> => ({
  intake: intake(),
  environment: {
    environment_outcome: "ready",
    progress_setup_outcome: progress.progress_setup_outcome,
  },
  "facts-produce": { progress_facts_outcome: progress.progress_facts_outcome },
  "facts-review": { review_outcome: "pass" },
  "facts-repair": {
    repair_outcome: "changed",
    progress_facts_outcome: progress.progress_facts_outcome,
  },
  "reassess-contract": downstreamProgress,
  "story-produce": {
    progress_story_outcome: progress.progress_story_outcome,
    progress_material_outcome: progress.progress_material_outcome,
    progress_voice_outcome: progress.progress_voice_outcome,
    progress_final_outcome: progress.progress_final_outcome,
    progress_delivery_outcome: progress.progress_delivery_outcome,
  },
  "story-review": { review_outcome: "pass" },
  "story-repair": {
    repair_outcome: "changed",
    progress_story_outcome: progress.progress_story_outcome,
    progress_material_outcome: progress.progress_material_outcome,
    progress_voice_outcome: progress.progress_voice_outcome,
    progress_final_outcome: progress.progress_final_outcome,
    progress_delivery_outcome: progress.progress_delivery_outcome,
  },
  "material-produce": {
    material_route: "pass",
    progress_material_outcome: progress.progress_material_outcome,
  },
  "material-produce-public": {
    material_route: "pass",
    progress_material_outcome: progress.progress_material_outcome,
  },
  "material-repair": {
    repair_outcome: "changed",
    progress_material_outcome: progress.progress_material_outcome,
    progress_final_outcome: progress.progress_final_outcome,
    progress_delivery_outcome: progress.progress_delivery_outcome,
  },
  "stub-build": {
    stub_route: "pass",
    progress_material_outcome: progress.progress_material_outcome,
  },
  "synth-prepare": {
    synthesis_cost: "local",
    progress_voice_outcome: progress.progress_voice_outcome,
  },
  synthesize: {
    synthesis_outcome: "ready",
    progress_voice_outcome: progress.progress_voice_outcome,
  },
  "human-record": { progress_voice_outcome: progress.progress_voice_outcome },
  "silent-accept": { progress_voice_outcome: progress.progress_voice_outcome },
  "voice-review": { review_outcome: "pass" },
  "voice-repair": {
    repair_outcome: "changed",
    progress_voice_outcome: progress.progress_voice_outcome,
    progress_final_outcome: progress.progress_final_outcome,
    progress_delivery_outcome: progress.progress_delivery_outcome,
  },
  "final-build": {
    progress_final_outcome: progress.progress_final_outcome,
    progress_delivery_outcome: progress.progress_delivery_outcome,
  },
  "final-review": { review_outcome: "pass" },
  "build-repair": {
    repair_outcome: "changed",
    progress_final_outcome: progress.progress_final_outcome,
    progress_delivery_outcome: progress.progress_delivery_outcome,
  },
  "optional-commit": {
    commit_outcome: "committed",
    progress_delivery_outcome: "Локальный commit выполнен",
  },
  deliver: {
    delivery_outcome: "delivered",
    progress_delivery_outcome: "Разрешённая передача выполнена",
  },
  "final-report": { progress_delivery_outcome: progress.progress_delivery_outcome },
  "report-setup-blocked": { progress_setup_outcome: "Обязательная среда недоступна" },
  "report-material-blocked": { progress_material_outcome: "Материал недоступен" },
  "report-voice-blocked": { progress_voice_outcome: "Голос недоступен" },
  "teleport-revise-film-contract": downstreamProgress,
});

function scenario(
  name: string,
  overrides: Record<string, MockInput>,
  reaches: string[],
  options: Pick<TestScenario, "teleportAfter"> = {},
): TestScenario {
  return {
    name,
    mockInputs: { ...ordinaryInputs(), ...overrides },
    expect: { status: "completed", reaches, maxSteps: 260 },
    ...options,
  };
}

function route(
  name: string,
  producer: string,
  field: string,
  first: string,
  next: string,
  reaches: string[],
  extras: Record<string, MockInput> = {},
): TestScenario {
  const base = ordinaryInputs()[producer] as Record<string, unknown>;
  return scenario(
    name,
    {
      ...extras,
      [producer]: [
        { ...base, [field]: first },
        { ...base, [field]: next },
      ],
    },
    [producer, ...reaches, "end"],
  );
}

const scenarios: TestScenario[] = [
  scenario("public capture and explicitly silent local completion", {}, [
    "material-produce-public",
    "silent-accept",
    "final-report",
    "end",
  ]),
  scenario(
    "authorized capture uses protected producer",
    { intake: intake({ capture_access_authorized: true }) },
    ["material-produce", "end"],
  ),
  scenario(
    "setup prerequisite blocker stops before facts",
    {
      environment: {
        environment_outcome: "blocked",
        progress_setup_outcome: "Среда заблокирована",
      },
    },
    ["report-setup-blocked", "end-blocked"],
  ),
  route(
    "facts-owned repair returns to independent review",
    "facts-review",
    "review_outcome",
    "repair",
    "pass",
    ["facts-repair", "facts-review"],
  ),
  route(
    "facts upstream replan returns through intake",
    "facts-review",
    "review_outcome",
    "replan",
    "pass",
    ["reassess-contract", "intake", "facts-review"],
  ),
  route(
    "facts repair reassesses instead of falsely passing",
    "facts-repair",
    "repair_outcome",
    "reassess",
    "changed",
    ["reassess-contract", "intake"],
    {
      "facts-review": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
    },
  ),
  route(
    "story-owned repair repeats independent review",
    "story-review",
    "review_outcome",
    "repair",
    "pass",
    ["story-repair", "story-review"],
  ),
  route(
    "story review replan returns to contract",
    "story-review",
    "review_outcome",
    "replan",
    "pass",
    ["reassess-contract", "intake"],
  ),
  route(
    "story repair reassessment does not certify a script",
    "story-repair",
    "repair_outcome",
    "reassess",
    "changed",
    ["reassess-contract", "intake"],
    {
      "story-review": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
    },
  ),
  ...(["material-produce", "material-produce-public"] as const).flatMap((producer) => {
    const access = {
      intake: intake({ capture_access_authorized: producer === "material-produce" }),
    };
    return [
      route(
        `${producer}: local material repair`,
        producer,
        "material_route",
        "repair",
        "pass",
        ["material-repair", producer],
        access,
      ),
      route(
        `${producer}: script owns material defect`,
        producer,
        "material_route",
        "story_repair",
        "pass",
        ["story-repair", "story-review", producer],
        access,
      ),
      route(
        `${producer}: contract owns material defect`,
        producer,
        "material_route",
        "reassess",
        "pass",
        ["reassess-contract", "intake", producer],
        access,
      ),
      scenario(
        `${producer}: unavailable material stops safely`,
        {
          ...access,
          [producer]: {
            material_route: "blocked",
            progress_material_outcome: "Материал заблокирован",
          },
        },
        [producer, "report-material-blocked", "end-blocked"],
      ),
    ];
  }),
  route(
    "material repair reassessment returns to contract instead of recapturing",
    "material-repair",
    "repair_outcome",
    "reassess",
    "changed",
    ["reassess-contract", "intake"],
    {
      "material-produce-public": [
        { material_route: "repair", progress_material_outcome: "Материал требует исправления" },
        { material_route: "pass", progress_material_outcome: progress.progress_material_outcome },
      ],
    },
  ),
  route(
    "stub exposes material defect before narration",
    "stub-build",
    "stub_route",
    "material_repair",
    "pass",
    ["material-repair", "stub-build"],
  ),
  route(
    "stub exposes story defect before narration",
    "stub-build",
    "stub_route",
    "story_repair",
    "pass",
    ["story-repair", "stub-build"],
  ),
  route("stub exposes contract defect", "stub-build", "stub_route", "reassess", "pass", [
    "reassess-contract",
    "intake",
  ]),
  scenario(
    "stub unavailable stops without voice side effects",
    {
      "stub-build": { stub_route: "blocked", progress_material_outcome: "Сборка недоступна" },
    },
    ["stub-build", "report-material-blocked", "end-blocked"],
  ),
  scenario(
    "human recording is reviewed before final build",
    { intake: intake({ voice_mode: "human" }) },
    ["human-record", "voice-review", "final-build"],
  ),
  scenario(
    "local synthetic narration uses no paid permission",
    { intake: intake({ voice_mode: "synth" }) },
    ["route-local-synthesis", "synthesize", "voice-review", "end"],
  ),
  scenario(
    "authorized paid narration may synthesize",
    {
      intake: intake({ voice_mode: "synth", allow_paid_synthesis: true }),
      "synth-prepare": {
        synthesis_cost: "paid_or_unknown",
        progress_voice_outcome: "Платный объём согласован",
      },
    },
    ["route-paid-synthesis", "synthesize", "voice-review", "end"],
  ),
  scenario(
    "unknown cost without consent blocks before synthesis",
    {
      intake: intake({ voice_mode: "synth" }),
      "synth-prepare": {
        synthesis_cost: "paid_or_unknown",
        progress_voice_outcome: "Стоимость неизвестна",
      },
    },
    ["route-paid-synthesis", "report-voice-blocked", "end-blocked"],
  ),
  scenario(
    "synthesis failure cannot become approved audio",
    {
      intake: intake({ voice_mode: "synth" }),
      synthesize: { synthesis_outcome: "blocked", progress_voice_outcome: "Синтез не завершён" },
    },
    ["synthesize", "report-voice-blocked", "end-blocked"],
  ),
  route(
    "voice repair repeats review without buying narration",
    "voice-review",
    "review_outcome",
    "repair",
    "pass",
    ["voice-repair", "voice-review"],
    {
      intake: intake({ voice_mode: "human" }),
    },
  ),
  route(
    "voice review sends semantic defect to script owner",
    "voice-review",
    "review_outcome",
    "story_repair",
    "pass",
    ["story-repair", "story-review"],
    {
      intake: intake({ voice_mode: "human" }),
    },
  ),
  route(
    "voice review sends upstream defect to contract",
    "voice-review",
    "review_outcome",
    "replan",
    "pass",
    ["reassess-contract", "intake"],
    {
      intake: intake({ voice_mode: "human" }),
    },
  ),
  route(
    "voice repair changing words returns to story",
    "voice-repair",
    "repair_outcome",
    "story_changed",
    "changed",
    ["story-repair", "story-review"],
    {
      intake: intake({ voice_mode: "human" }),
      "voice-review": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
    },
  ),
  route(
    "voice repair reassessment returns to contract",
    "voice-repair",
    "repair_outcome",
    "reassess",
    "changed",
    ["reassess-contract", "intake"],
    {
      intake: intake({ voice_mode: "human" }),
      "voice-review": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
    },
  ),
  route(
    "changed synthetic repair passes through cost permission again",
    "voice-review",
    "review_outcome",
    "repair",
    "pass",
    ["voice-repair", "route-voice-repair-paid", "synth-prepare"],
    {
      intake: intake({ voice_mode: "synth" }),
    },
  ),
  ...(["build_repair", "voice_repair", "material_repair", "story_repair", "replan"] as const).map(
    (outcome) =>
      route(
        `final reviewer delegates ${outcome} to exact owner`,
        "final-review",
        "review_outcome",
        outcome,
        "pass",
        [outcome === "replan" ? "reassess-contract" : outcome.replace("_", "-")],
        {
          intake: intake({ voice_mode: "human" }),
        },
      ),
  ),
  route(
    "build repair reassessment returns to contract",
    "build-repair",
    "repair_outcome",
    "reassess",
    "changed",
    ["reassess-contract", "intake"],
    {
      "final-review": [{ review_outcome: "build_repair" }, { review_outcome: "pass" }],
    },
  ),
  scenario(
    "commit authority does not imply external handoff",
    {
      intake: intake({ allow_commit: true }),
    },
    ["optional-commit", "route-delivery-permission", "final-report", "end"],
  ),
  scenario(
    "external handoff does not imply commit authority",
    {
      intake: intake({ allow_external_delivery: true }),
    },
    ["route-commit-permission", "deliver", "final-report", "end"],
  ),
  scenario(
    "teleport re-entry reruns intake and review",
    {},
    ["teleport-revise-film-contract", "intake", "facts-review", "end"],
    {
      teleportAfter: { afterNode: "story-produce", teleportTo: "teleport-revise-film-contract" },
    },
  ),
];

describe("agentic-screencast-video owner routing", () => {
  test("current graph is valid and protected authority gates remain independent", async () => {
    const graph = workflow();
    const validation = await new GraphValidator().validateUnified(graph);
    expect(validation.valid).toBe(true);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(graph.metadata.version).toBe("1.2.0");
    expect(graph.nodes).toHaveLength(40);
    expect(
      graph.nodes
        .filter((node) => node.type === "condition")
        .map((node) => node.id)
        .sort(),
    ).toEqual([
      "route-capture-access",
      "route-commit-permission",
      "route-delivery-permission",
      "route-local-synthesis",
      "route-paid-synthesis",
      "route-voice-human",
      "route-voice-repair-paid",
      "route-voice-synth",
    ]);
    expect(graph.nodes.find((node) => node.id === "route-commit-permission")?.connections).toEqual({
      true: "optional-commit",
      default: "route-delivery-permission",
    });
    expect(
      graph.nodes.find((node) => node.id === "route-delivery-permission")?.connections,
    ).toEqual({
      true: "deliver",
      default: "final-report",
    });
  });

  test("all representative owner and permission routes are executable", async () => {
    const graph = workflow();
    const results = [];
    for (const route of scenarios) {
      const result = await runScenario(graph, route);
      expect({ name: route.name, error: result.error, failed: result.failedExpectations }).toEqual({
        name: route.name,
        error: undefined,
        failed: undefined,
      });
      results.push(result);
    }
    const coverage = calculateCoverage(graph, results);
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
