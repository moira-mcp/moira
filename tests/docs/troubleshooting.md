# Test Troubleshooting

## Docker Issues

```bash
# Check running containers
docker ps | grep moira

# Restart Docker
npm run docker:restart

# Test health endpoint
curl http://localhost:${DOCKER_PORT}/health
```

---

## Database Issues

```bash
# Check file exists
ls -la ./data/moira.db

# Analyze tables
sqlite3 ./data/moira.db ".tables"

# Query data
sqlite3 ./data/moira.db "SELECT * FROM user;"
sqlite3 ./data/test-integration.db "SELECT * FROM workflow;"
```

---

## Environment Issues

```bash
# Check Docker port config
cat .env.local | grep DOCKER_PORT

# Check admin credentials
cat .env.local | grep ADMIN
```

---

## Common Errors

### Tests fail to run (0 tests)

- Read `.log` file for syntax/compilation errors
- Check if test file path is correct

### Docker not running

```
Error: connect ECONNREFUSED 127.0.0.1:${DOCKER_PORT}
```

**Solution:** `npm run docker:restart`

### Database locked

```
Error: SQLITE_BUSY: database is locked
```

**Solution:** Close other connections, restart Docker

### Auth failures in E2E

```
[Browser Console Error] [Login Error] Email not verified
```

**Solution:** Use `createVerifiedTestUser()` helper instead of manual registration

### Timeout errors

```
Timeout - Async callback was not invoked within 5000ms
```

**Solutions:**

- Check if Docker is running
- Check network connectivity
- Profile slow operations (don't just increase timeout)

### MCP tool not found

```
Error: Unknown tool: new_tool_name
```

**Possible causes:**

1. Tool not registered in `server.ts`
2. Tool registered but Claude Code needs MCP reconnection (cached tools list)

---

## Debugging Steps

### 1. Read failure reports first

```bash
cat test-results/artifacts/failures/e2e/01-test-name.md
cat test-results/artifacts/failures/unit/01-test-name.md
```

Individual Markdown files contain:

- Error messages (clean, no color codes)
- Stack traces
- Test output
- Browser console (E2E)
- Network logs (E2E)
- Screenshots/videos (E2E)

### 2. Check log files if tests crash

```bash
cat test-results/artifacts/unit.log
cat test-results/artifacts/e2e.log
```

**CRITICAL:** If tests fail to start or crash, error is ONLY in `.log` file.

### 3. Analyze database state

```bash
# For integration tests
sqlite3 ./data/test-integration.db "SELECT * FROM workflow;"

# For API/E2E tests
sqlite3 ./data/moira.db "SELECT * FROM user;"
```

### 4. Run specific test

```bash
npm run test:unit specific-test.test.ts
npm run test:e2e specific-test.spec.ts
```

---

## Performance Targets

- Unit: < 100ms
- Integration: < 5s
- API: < 10s
- MCP: < 10s
- E2E: < 30s

**If slow:** Profile and optimize (don't increase timeout).

---

## DO NOT Re-run Immediately

All logs already saved. Read files first:

1. `.md` failure reports - clean error messages
2. `.log` files - full output including crashes
3. Database - check data state

Only re-run after understanding the failure cause.
