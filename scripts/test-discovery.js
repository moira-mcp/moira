#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Автоматический скрипт для сканирования всех тестов в проекте
 * Находит все .test.ts/.test.js файлы и извлекает метаданные
 */

class TestDiscovery {
  constructor() {
    this.projectRoot = path.resolve(__dirname, "..");
    this.testFiles = [];
    this.testStats = {
      totalFiles: 0,
      totalTests: 0,
      totalDescribeBlocks: 0,
      categories: {
        unit: 0,
        integration: 0,
        e2e: 0,
        functional: 0,
      },
    };
  }

  /**
   * Рекурсивное сканирование директорий для поиска тестов
   */
  scanDirectory(dir, relativePath = "") {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativeFilePath = path.join(relativePath, entry.name);

        if (entry.isDirectory()) {
          // Пропускаем node_modules и .git
          if (entry.name === "node_modules" || entry.name === ".git") {
            continue;
          }
          this.scanDirectory(fullPath, relativeFilePath);
        } else if (entry.isFile() && this.isTestFile(entry.name)) {
          this.analyzeTestFile(fullPath, relativeFilePath);
        }
      }
    } catch (error) {
      console.warn(`Warning: Cannot scan directory ${dir}: ${error.message}`);
    }
  }

  /**
   * Проверяет является ли файл тестовым
   */
  isTestFile(filename) {
    return (
      filename.endsWith(".test.ts") ||
      filename.endsWith(".test.js") ||
      filename.endsWith(".spec.ts") ||
      filename.endsWith(".spec.js")
    );
  }

  /**
   * Анализирует тестовый файл и извлекает метаданные
   */
  analyzeTestFile(filePath, relativePath) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const testInfo = this.extractTestInfo(content, relativePath);

      this.testFiles.push(testInfo);
      this.testStats.totalFiles++;
      this.testStats.totalTests += testInfo.testCount;
      this.testStats.totalDescribeBlocks += testInfo.describeBlocks.length;

      // Определяем категорию теста
      const category = this.categorizeTest(relativePath, content);
      this.testStats.categories[category]++;
    } catch (error) {
      console.warn(`Warning: Cannot analyze test file ${relativePath}: ${error.message}`);
    }
  }

  /**
   * Извлекает информацию о тестах из содержимого файла
   */
  extractTestInfo(content, relativePath) {
    const describeBlocks = [];
    const testCases = [];

    // Поиск describe блоков
    const describeRegex = /describe\s*\(\s*['"](.*?)['"][\s\S]*?\{/g;
    let match;
    while ((match = describeRegex.exec(content)) !== null) {
      describeBlocks.push({
        name: match[1],
        line: this.getLineNumber(content, match.index),
      });
    }

    // Поиск it/test блоков
    const testRegex = /(?:it|test)\s*\(\s*['"](.*?)['"][\s\S]*?\{/g;
    while ((match = testRegex.exec(content)) !== null) {
      testCases.push({
        name: match[1],
        line: this.getLineNumber(content, match.index),
      });
    }

    // Поиск импортов для определения зависимостей
    const imports = this.extractImports(content);

    return {
      filePath: relativePath,
      fileName: path.basename(relativePath),
      directory: path.dirname(relativePath),
      describeBlocks,
      testCases,
      testCount: testCases.length,
      imports,
      fileSize: content.length,
      lineCount: content.split("\n").length,
    };
  }

  /**
   * Определяет номер строки для заданной позиции в тексте
   */
  getLineNumber(content, position) {
    return content.substring(0, position).split("\n").length;
  }

  /**
   * Извлекает импорты из файла
   */
  extractImports(content) {
    const imports = [];
    const importRegex = /import\s+.*?\s+from\s+['"](.*?)['"]/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  /**
   * Категоризирует тест по пути и содержимому
   */
  categorizeTest(relativePath, content) {
    const pathLower = relativePath.toLowerCase();
    const contentLower = content.toLowerCase();

    if (
      pathLower.includes("/e2e/") ||
      pathLower.includes("e2e-") ||
      contentLower.includes("playwright") ||
      contentLower.includes("browser")
    ) {
      return "e2e";
    }

    if (
      pathLower.includes("/integration/") ||
      pathLower.includes("integration-") ||
      contentLower.includes("mcpengine") ||
      contentLower.includes("docker") ||
      contentLower.includes("server") ||
      contentLower.includes("database")
    ) {
      return "integration";
    }

    if (
      pathLower.includes("/functional/") ||
      pathLower.includes("functional-") ||
      contentLower.includes("workflow") ||
      contentLower.includes("telegram")
    ) {
      return "functional";
    }

    return "unit";
  }

  /**
   * Запускает сканирование и генерирует отчет
   */
  async discover() {
    console.log("🔍 Starting test discovery...");
    console.log(`📁 Scanning project root: ${this.projectRoot}`);

    this.scanDirectory(this.projectRoot);

    // Сортируем файлы по пути
    this.testFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));

    const report = {
      generatedAt: new Date().toISOString(),
      projectRoot: this.projectRoot,
      statistics: this.testStats,
      testFiles: this.testFiles,
    };

    // Сохраняем результат
    const outputPath = path.join(this.projectRoot, "tests", "DISCOVERED-TESTS.json");

    // Создаем директорию tests если не существует
    const testsDir = path.dirname(outputPath);
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

    console.log("\n✅ Test discovery completed!");
    console.log(`📊 Statistics:`);
    console.log(`   📁 Total test files: ${this.testStats.totalFiles}`);
    console.log(`   🧪 Total test cases: ${this.testStats.totalTests}`);
    console.log(`   📋 Total describe blocks: ${this.testStats.totalDescribeBlocks}`);
    console.log(`   📂 Categories:`);
    console.log(`      🔬 Unit tests: ${this.testStats.categories.unit}`);
    console.log(`      🔗 Integration tests: ${this.testStats.categories.integration}`);
    console.log(`      🎭 E2E tests: ${this.testStats.categories.e2e}`);
    console.log(`      ⚙️ Functional tests: ${this.testStats.categories.functional}`);
    console.log(`📄 Report saved to: ${outputPath}`);

    return report;
  }
}

// Запуск скрипта если вызван напрямую
if (import.meta.url === `file://${process.argv[1]}`) {
  const discovery = new TestDiscovery();
  discovery.discover().catch(console.error);
}

export default TestDiscovery;
