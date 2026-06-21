/**
 * Test configuration for auth e2e tests
 */

import { getTestBaseUrl } from "../../utils/test-config.js";

export const TEST_CONFIG = {
  BASE_URL: getTestBaseUrl(),
  TEST_USER: {
    email: "test@example.com",
    password: "password123",
  },
};
