# Screenshot Validation Guide

Screenshot validation captures UI state via Playwright scripts during development workflow steps. An HTML report embeds captured screenshots so the user can approve or reject changes without visiting a running instance.

## Workflow Variable

The development workflow stores the path to this file in:

```
screenshot_guide_path = "docs/SCREENSHOT-VALIDATION-GUIDE.md"
```

When `screenshot_validation_enabled = "yes"`, the agent reads this guide and follows its process on every implementation step.

## Directory Structure

Each step stores screenshots inside the workspace:

```
moira-ws/<workspace>/
├── screenshots/               # Playwright capture scripts (accumulative)
│   ├── capture-step-1.ts
│   ├── capture-step-2.ts
│   └── ...
├── step-1/
│   ├── iteration-1/
│   │   └── screenshots/       # Captured PNG files
│   │       ├── 01-dashboard.png
│   │       └── 02-detail.png
│   ├── step-report.html       # HTML report with embedded screenshots
│   └── screenshot-report.html # Screenshot-only HTML report (optional)
├── step-2/
│   └── ...
└── development-plan.md
```

## Authentication Helpers

Playwright scripts must authenticate before capturing. Use existing E2E helpers:

```typescript
import { loginAsAdmin } from "../../tests/e2e/helpers/auth-helper.js";
import { getTestBaseUrl } from "../../tests/utils/test-config.js";

const BASE_URL = getTestBaseUrl();
```

### Login Pattern

```typescript
import { chromium } from "playwright";
import { loginAsAdmin } from "../../tests/e2e/helpers/auth-helper.js";
import { getTestBaseUrl } from "../../tests/utils/test-config.js";

const BASE_URL = getTestBaseUrl();

async function capture() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(BASE_URL);
  await loginAsAdmin(page);

  // Navigate and capture...

  await browser.close();
}
```

### Available Auth Functions

| Function                       | Import Path                        | Purpose                          |
| ------------------------------ | ---------------------------------- | -------------------------------- |
| `loginAsAdmin(page)`           | `tests/e2e/helpers/auth-helper.js` | Admin login via cookie injection |
| `login(page, email, password)` | `tests/e2e/helpers/auth-helper.js` | Login specific user              |
| `createTestUser(page, opts)`   | `tests/e2e/helpers/auth-helper.js` | Create and login test user       |
| `acceptBetaAgreement(page)`    | `tests/e2e/helpers/auth-helper.js` | Dismiss beta modal               |
| `getTestBaseUrl()`             | `tests/utils/test-config.js`       | Docker-aware base URL            |
| `getTestFetchUrl()`            | `tests/utils/test-config.js`       | URL for Node.js HTTP calls       |

## Writing Capture Scripts

Each script captures screenshots for one step. Scripts are **accumulative** — each step adds new captures without removing previous scripts.

### Script Template

```typescript
// screenshots/capture-step-N.ts
import { chromium } from "playwright";
import { loginAsAdmin } from "../../tests/e2e/helpers/auth-helper.js";
import { getTestBaseUrl } from "../../tests/utils/test-config.js";
import * as path from "path";
import * as fs from "fs";

const BASE_URL = getTestBaseUrl();
const STEP = N;
const OUTPUT_DIR = path.resolve(`moira-ws/<workspace>/step-${STEP}/iteration-1/screenshots`);

async function capture() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(BASE_URL);
  await loginAsAdmin(page);

  // --- Capture 1: Full page ---
  await page.goto(`${BASE_URL}/app/target-page`);
  await page.waitForSelector("[data-testid='target-element']");
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "01-full-page.png"),
    fullPage: true,
  });

  // --- Capture 2: Specific section ---
  const section = page.locator("[data-testid='section-name']");
  await section.screenshot({
    path: path.join(OUTPUT_DIR, "02-section.png"),
  });

  await browser.close();
  console.log(`Captured ${fs.readdirSync(OUTPUT_DIR).length} screenshots to ${OUTPUT_DIR}`);
}

capture().catch(console.error);
```

### Selector Strategy

Use `data-testid` attributes first. Fallback order:

1. `[data-testid="exact-id"]` — stable, preferred
2. `role` selectors — `page.getByRole('heading', { name: 'Title' })`
3. Text selectors — `page.locator('text=Exact Text')`
4. CSS selectors — last resort, fragile

### Capture Checklist

For each step, capture:

- Full page screenshot of the main view
- Each new UI section or component
- Interactive states (expanded/collapsed, selected tabs, hover states)
- Data-populated states (tables with rows, charts with data, cards with values)
- Empty states if relevant

## Running Scripts

```bash
# Run via npx (scripts use project's Playwright):
npx tsx moira-ws/<workspace>/screenshots/capture-step-N.ts

# Docker must be running for auth to work:
npm run docker:restart  # if not already running
```

## HTML Report Generation

After capturing, generate a self-contained HTML report. The report embeds screenshots as base64 so users can open it locally without a running server.

### Report Requirements

1. **Self-contained** — single `.html` file with embedded CSS and base64 images
2. **All screenshots visible** — each screenshot displayed at readable size
3. **Labeled** — filename or description next to each image
4. **Click-to-expand** — thumbnails with click to show full resolution
5. **Step context** — title includes step number and description
6. **Decision-ready** — user must be able to approve/reject the step based solely on the report

### Report Structure

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Step N — Screenshot Validation Report</title>
    <style>
      /* Embedded CSS for layout, thumbnail grid, lightbox */
    </style>
  </head>
  <body>
    <h1>Step N: [Step Description]</h1>
    <p>Captured: [count] screenshots | Date: [timestamp]</p>

    <div class="screenshot-grid">
      <!-- For each screenshot: -->
      <div class="screenshot-card">
        <h3>01-full-page.png</h3>
        <img src="data:image/png;base64,..." alt="Full page" />
      </div>
      <!-- ... -->
    </div>
  </body>
</html>
```

### Embedding Screenshots as Base64

```typescript
import * as fs from "fs";
import * as path from "path";

function embedScreenshot(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function generateReport(screenshotDir: string, stepIndex: number, description: string): string {
  const files = fs
    .readdirSync(screenshotDir)
    .filter((f) => f.endsWith(".png"))
    .sort();

  const cards = files
    .map((file) => {
      const src = embedScreenshot(path.join(screenshotDir, file));
      return `
      <div class="screenshot-card">
        <h3>${file}</h3>
        <img src="${src}" alt="${file}" onclick="this.classList.toggle('expanded')" />
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Step ${stepIndex} — Screenshot Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 10px; }
    .screenshot-grid { display: grid; grid-template-columns: 1fr; gap: 24px; }
    .screenshot-card { background: white; border-radius: 8px; padding: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .screenshot-card h3 { margin: 0 0 12px 0; font-size: 14px; color: #666; }
    .screenshot-card img { max-width: 100%; cursor: pointer; border: 1px solid #eee; border-radius: 4px; }
    .screenshot-card img.expanded { max-width: none; width: 100%; }
  </style>
</head>
<body>
  <h1>Step ${stepIndex}: ${description}</h1>
  <p>Screenshots: ${files.length} | Generated: ${new Date().toISOString()}</p>
  <div class="screenshot-grid">${cards}</div>
</body>
</html>`;
}
```

### Saving the Report

```typescript
const html = generateReport(
  `moira-ws/<workspace>/step-${STEP}/iteration-1/screenshots`,
  STEP,
  "Step description here",
);

fs.writeFileSync(`moira-ws/<workspace>/step-${STEP}/screenshot-report.html`, html);
```

## Validation Criteria

When validating screenshots, check:

| Check          | Pass                                | Fail                                 |
| -------------- | ----------------------------------- | ------------------------------------ |
| UI loads       | Content visible, no blank screens   | White/empty page, loading spinner    |
| Layout         | Elements positioned correctly       | Overlapping, misaligned, cut off     |
| Data           | Charts/tables populated with values | Empty states when data expected      |
| Responsiveness | Full viewport used                  | Horizontal scroll, squished elements |
| Errors         | No error banners or console errors  | Red error messages, broken images    |
| i18n           | Text in expected language           | Mixed languages, untranslated keys   |

## Integration with Step Report

The `step-report.html` (comprehensive gate review report) should reference or include screenshots. Two approaches:

1. **Separate files**: `screenshot-report.html` for screenshots, `step-report.html` for gate review summary. User reviews both.
2. **Combined**: `step-report.html` includes a "Screenshot Validation" section with embedded screenshots.

Either approach works. The key: user can approve the step from the reports alone.
