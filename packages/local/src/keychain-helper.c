#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

static void jsonString(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static OSStatus keychainPath(SecKeychainRef keychain, char *path) {
  UInt32 length = 4095;
  OSStatus result = SecKeychainGetPath(keychain, &length, path);
  if (result == 0) path[length] = 0;
  return result;
}

/* Fixed local operations only. Password bytes arrive on stdin, never argv or env. */
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (strcmp(argv[1], "metadata") && (argc != 3 || (strcmp(argv[1], "create") && strcmp(argv[1], "unlock") && strcmp(argv[1], "unlock-machine") && strcmp(argv[1], "probe") && strcmp(argv[1], "select")))) return 2;
  OSStatus interaction = SecKeychainSetUserInteractionAllowed(false);
  if (interaction != errSecSuccess) { printf("{\"status\":%d}\n", (int)interaction); return 1; }
  if (!strcmp(argv[1], "metadata")) {
    if (argc != 2) return 2;
    SecKeychainRef current = NULL;
    CFArrayRef search = NULL;
    char path[4096] = {0};
    OSStatus currentStatus = SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &current);
    if (currentStatus == 0) currentStatus = keychainPath(current, path);
    OSStatus searchStatus = SecKeychainCopyDomainSearchList(kSecPreferencesDomainUser, &search);
    printf("{\"defaultStatus\":%d,\"defaultPath\":", (int)currentStatus);
    if (currentStatus == 0) jsonString(path); else printf("null");
    printf(",\"searchPaths\":[");
    if (searchStatus == 0 && search) {
      CFIndex count = CFArrayGetCount(search);
      if (count > 128) searchStatus = errSecParam;
      for (CFIndex i = 0; searchStatus == 0 && i < count; i++) {
        searchStatus = keychainPath((SecKeychainRef)CFArrayGetValueAtIndex(search,i),path);
        if (searchStatus == 0) { if (i) putchar(','); jsonString(path); }
      }
    }
    printf("],\"searchStatus\":%d}\n", (int)searchStatus);
    if (current) CFRelease(current);
    if (search) CFRelease(search);
    return (currentStatus == 0 || currentStatus == errSecNoDefaultKeychain) && searchStatus == 0 ? 0 : 1;
  }
  if (!strcmp(argv[1], "select")) {
    SecKeychainRef own = NULL;
    OSStatus status = SecKeychainOpen(argv[2], &own);
    if (status == 0) {
      const void *value = own;
      CFArrayRef search = CFArrayCreate(NULL, &value, 1, &kCFTypeArrayCallBacks);
      status = search ? SecKeychainSetDomainSearchList(kSecPreferencesDomainUser, search) : errSecAllocate;
      if (status == 0) status = SecKeychainSetDomainDefault(kSecPreferencesDomainUser, own);
      if (search) CFRelease(search);
    }
    if (own) CFRelease(own);
    printf("{\"status\":%d}\n", (int)status);
    return status == 0 ? 0 : 1;
  }
  if (!strcmp(argv[1], "probe")) {
    SecKeychainRef own = NULL;
    OSStatus opened = SecKeychainOpen(argv[2], &own);
    SecKeychainStatus flags = 0;
    SecKeychainSettings settings = {SEC_KEYCHAIN_SETTINGS_VERS1, false, false, 0};
    OSStatus state = opened == errSecSuccess ? SecKeychainGetStatus(own, &flags) : opened;
    OSStatus copied = opened == errSecSuccess ? SecKeychainCopySettings(own, &settings) : opened;
    printf("{\"status\":%d,\"settingsStatus\":%d,\"unlocked\":%s,\"lockOnSleep\":%s,\"useLockInterval\":%s,\"lockInterval\":%u}\n", (int)state, (int)copied, (flags & kSecUnlockStateStatus) ? "true" : "false", settings.lockOnSleep ? "true" : "false", settings.useLockInterval ? "true" : "false", (unsigned)settings.lockInterval);
    if (own) CFRelease(own);
    return state == errSecSuccess && copied == errSecSuccess ? 0 : 1;
  }
  unsigned char password[65] = {0};
  size_t size = fread(password, 1, sizeof(password), stdin);
  int valid = size == 64 && feof(stdin);
  for (size_t i = 0; i < size; i++) {
    if (!((password[i] >= '0' && password[i] <= '9') ||
          (password[i] >= 'a' && password[i] <= 'f'))) valid = 0;
  }
  SecKeychainRef keychain = NULL;
  OSStatus status;
  if (!valid) {
    status = errSecParam;
  } else if (!strcmp(argv[1], "create")) {
    umask(0077);
    status = SecKeychainCreate(argv[2], (UInt32)size, password, false, NULL, &keychain);
  } else {
    status = SecKeychainOpen(argv[2], &keychain);
    if (status == errSecSuccess) status = SecKeychainUnlock(keychain, (UInt32)size, password, true);
  }
  if (status == errSecSuccess && (!strcmp(argv[1], "create") || !strcmp(argv[1], "unlock-machine"))) {
    SecKeychainSettings settings = {SEC_KEYCHAIN_SETTINGS_VERS1, false, false, 0};
    status = SecKeychainCopySettings(keychain, &settings);
    if (status == 0 && !strcmp(argv[1], "create")) {
      // New SDK machine stores stay available to their background process after sleep.
      // Existing or personal Keychain policies are never rewritten.
      settings.lockOnSleep = false;
      settings.useLockInterval = false;
      status = SecKeychainSetSettings(keychain, &settings);
      if (status == 0) status = SecKeychainCopySettings(keychain, &settings);
    }
    if (status == 0 && (settings.lockOnSleep || settings.useLockInterval)) status = errSecParam;
  }
  volatile unsigned char *clear = password;
  for (size_t i = 0; i < sizeof(password); i++) clear[i] = 0;
  if (keychain) CFRelease(keychain);
  printf("{\"status\":%d}\n", (int)status);
  return status == errSecSuccess ? 0 : 1;
}
