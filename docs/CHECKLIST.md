# Quality Checklist

Pre-commit checklist for all code changes. Run through it BEFORE committing to confirm
everything is OK and it is safe to commit and move on.

## Code Quality

- [ ] `npm run fix` passes (ESLint + Prettier)
- [ ] No TypeScript errors (`tsc` via Docker build)
- [ ] No `any` types without explicit justification
- [ ] No `console.log` left in production code (use `logger`)
- [ ] Error handling follows `AppError` / `DomainError` patterns
- [ ] No hardcoded secrets, URLs, or credentials

## Testing

- [ ] Unit tests for new utility functions (`npm run test:unit`)
- [ ] Integration tests for new DB operations (`npm run test:integration`)
- [ ] API tests for new/changed endpoints (`npm run test:api`)
- [ ] MCP tool tests for new/changed tools (`npm run test:mcp-tools`)
- [ ] E2E tests for new UI features (`npm run test:e2e`)
- [ ] Existing tests still pass (`npm test`)
- [ ] Tests use fixtures and helpers (not raw Playwright/Jest imports)
- [ ] No test antipatterns (see `tests/TESTING-GUIDE.md`)

## Database

- [ ] Schema changes use Drizzle ORM definitions
- [ ] Indexes added for frequently queried columns
- [ ] Foreign keys with appropriate ON DELETE behavior
- [ ] Text timestamps in ISO 8601 format (project convention)

## API Endpoints

- [ ] Auth middleware applied (`requireVerifiedAuth` or `requireAdmin`)
- [ ] Input validation on all user-provided data
- [ ] Error responses follow existing patterns (status codes, error codes)
- [ ] Rate limiting applied where appropriate

## Documentation

- [ ] `tests/COVERAGE-MAP.md` updated if tests added/removed/moved
- [ ] Internal docs (`docs/`) updated for architectural changes
- [ ] Public docs (`packages/landing-page/`) updated for user-facing changes
- [ ] Style guides followed (see `docs/DOCUMENTATION-STYLE-GUIDE.md`)

## Security

- [ ] No secrets in source code or logs
- [ ] User input sanitized before use
- [ ] Authorization checks on all protected endpoints
- [ ] Sensitive data not exposed in API responses

## Review Criteria

- [ ] Changes are minimal and surgical
- [ ] No unrelated changes mixed in
- [ ] Feature branch (not master) used for development
