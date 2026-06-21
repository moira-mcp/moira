#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Анализатор дублирующихся тестов на основе созданного registry
 * Находит потенциальные дубли и предлагает консолидацию
 */

class TestDuplicationAnalyzer {
  constructor() {
    this.projectRoot = path.resolve(__dirname, "..");
    this.discoveryData = null;
    this.duplicates = [];
    this.consolidationPlan = [];
  }

  /**
   * Загружает данные discovery из Stage 21
   */
  loadDiscoveryData() {
    const discoveryPath = path.join(this.projectRoot, "tests", "DISCOVERED-TESTS.json");
    try {
      const content = fs.readFileSync(discoveryPath, "utf8");
      this.discoveryData = JSON.parse(content);
      console.log(`📊 Loaded discovery data: ${this.discoveryData.testFiles.length} test files`);
    } catch (error) {
      throw new Error(`Failed to load discovery data: ${error.message}`);
    }
  }

  /**
   * Анализирует потенциальные дубли по названиям и функциональности
   */
  analyzeDuplicates() {
    console.log("🔍 Analyzing test duplicates...");

    const groups = {};

    // Группируем тесты по ключевым словам
    this.discoveryData.testFiles.forEach((testFile) => {
      const keywords = this.extractKeywords(testFile);

      keywords.forEach((keyword) => {
        if (!groups[keyword]) {
          groups[keyword] = [];
        }
        groups[keyword].push(testFile);
      });
    });

    // Находим группы с множественными файлами (потенциальные дубли)
    Object.entries(groups).forEach(([keyword, files]) => {
      if (files.length > 1) {
        this.duplicates.push({
          keyword,
          files,
          duplicationType: this.analyzeDuplicationType(files),
          consolidationRecommendation: this.generateConsolidationRecommendation(keyword, files),
        });
      }
    });

    console.log(`🎯 Found ${this.duplicates.length} potential duplication groups`);
  }

  /**
   * Извлекает ключевые слова из теста для группировки
   */
  extractKeywords(testFile) {
    const keywords = [];
    const fileName = testFile.fileName.toLowerCase();
    const directory = testFile.directory.toLowerCase();

    // Ключевые слова из названий файлов
    const fileKeywords = fileName.replace(".test.ts", "").replace(".test.js", "").split("-");
    keywords.push(...fileKeywords);

    // Ключевые слова из describe блоков
    testFile.describeBlocks.forEach((block) => {
      const blockKeywords = block.name.toLowerCase().split(" ");
      keywords.push(...blockKeywords.filter((w) => w.length > 3));
    });

    // Специальные паттерны
    if (fileName.includes("subgraph")) keywords.push("subgraph-testing");
    if (fileName.includes("validation")) keywords.push("validation-testing");
    if (fileName.includes("input")) keywords.push("input-processing");
    if (fileName.includes("telegram")) keywords.push("telegram-integration");
    if (directory.includes("integration")) keywords.push("integration-layer");
    if (directory.includes("unit")) keywords.push("unit-layer");

    return [...new Set(keywords)]; // Удаляем дубли
  }

  /**
   * Анализирует тип дублирования
   */
  analyzeDuplicationType(files) {
    if (
      files.some((f) => f.directory.includes("unit")) &&
      files.some((f) => f.directory.includes("integration"))
    ) {
      return "cross-layer"; // Unit и integration тесты одной функциональности
    }

    if (files.every((f) => f.directory.includes("integration"))) {
      return "integration-overlap"; // Несколько integration тестов
    }

    if (files.every((f) => f.directory.includes("unit"))) {
      return "unit-overlap"; // Несколько unit тестов
    }

    return "mixed-overlap";
  }

  /**
   * Генерирует рекомендации по консолидации
   */
  generateConsolidationRecommendation(keyword, files) {
    const recommendation = {
      action: "consolidate",
      targetFile: null,
      filesToRemove: [],
      reasoning: "",
    };

    // Находим наиболее полный тест для сохранения
    const sortedBySize = files.sort((a, b) => b.testCount - a.testCount);
    const mostComplete = sortedBySize[0];

    recommendation.targetFile = mostComplete.filePath;
    recommendation.filesToRemove = files.slice(1).map((f) => f.filePath);

    if (files.length === 2) {
      recommendation.reasoning = `${keyword}: Keep most complete test (${mostComplete.testCount} tests), consolidate smaller (${files[1].testCount} tests)`;
    } else {
      recommendation.reasoning = `${keyword}: Multiple tests found, consolidate into ${mostComplete.filePath}`;
    }

    return recommendation;
  }

  /**
   * Создает план консолидации
   */
  createConsolidationPlan() {
    console.log("📋 Creating consolidation plan...");

    this.consolidationPlan = this.duplicates.map((duplicate) => ({
      group: duplicate.keyword,
      type: duplicate.duplicationType,
      files: duplicate.files.map((f) => ({
        path: f.filePath,
        testCount: f.testCount,
        size: f.fileSize,
      })),
      recommendation: duplicate.consolidationRecommendation,
    }));

    // Сохраняем план
    const planPath = path.join(this.projectRoot, "tests", "DUPLICATION-ANALYSIS.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          analysisDate: new Date().toISOString(),
          totalDuplicationGroups: this.duplicates.length,
          consolidationPlan: this.consolidationPlan,
        },
        null,
        2,
      ),
    );

    console.log(`📄 Consolidation plan saved to: ${planPath}`);
  }

  /**
   * Запускает полный анализ
   */
  async analyze() {
    console.log("🔍 Starting test duplication analysis...");

    this.loadDiscoveryData();
    this.analyzeDuplicates();
    this.createConsolidationPlan();

    console.log("\n✅ Duplication analysis completed!");
    console.log(`📊 Analysis Results:`);
    console.log(`   🔍 Duplication groups found: ${this.duplicates.length}`);
    console.log(`   📁 Files analyzed: ${this.discoveryData.testFiles.length}`);

    if (this.duplicates.length > 0) {
      console.log(`\n🎯 Top duplication groups:`);
      this.duplicates.slice(0, 5).forEach((dup) => {
        console.log(`   ${dup.keyword}: ${dup.files.length} files`);
      });
    } else {
      console.log(`   ✅ No significant duplication found`);
    }

    return {
      totalGroups: this.duplicates.length,
      consolidationPlan: this.consolidationPlan,
    };
  }
}

// Запуск если вызван напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  const analyzer = new TestDuplicationAnalyzer();
  analyzer.analyze().catch(console.error);
}

export default TestDuplicationAnalyzer;
