/* Fixed SDK daemon lifecycle with held kernel identities; no credential API or caller commands. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <bsm/libbsm.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <sys/sysctl.h>
typedef struct { audit_token_t token; pid_t child; } owner;
#elif defined(__linux__)
#include <sys/syscall.h>
#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif
typedef struct { int pidfd; pid_t child; pid_t pid; } owner;
#else
#error Unsupported process ownership platform
#endif

static long long milliseconds(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) exit(2);
  return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int capture(owner *out, const char *root, const char *exe, const char *path, int vm) {
  out->child = 0;
  char canonical[PATH_MAX], actual[PATH_MAX];
  struct stat st;
  if (!realpath(path, canonical)) return errno == ENOENT ? -2 : -1;
  if (strncmp(canonical, root, strlen(root)) ||
      canonical[strlen(root)] != '/' || lstat(canonical, &st) ||
      !S_ISSOCK(st.st_mode) || st.st_uid != geteuid()) return -1;
  struct sockaddr_un addr = { .sun_family = AF_UNIX };
  /* Validate the resolved endpoint above, but use the fixed short SDK alias:
     its owned target may exceed the kernel's sockaddr_un pathname capacity. */
  if (strlen(path) >= sizeof(addr.sun_path)) return -1;
  strcpy(addr.sun_path, path);
  int fd = socket(AF_UNIX, vm ? SOCK_DGRAM : SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (fcntl(fd, F_SETFL, O_NONBLOCK)) { close(fd); return -1; }
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr))) {
    if (errno != EINPROGRESS) { int absent = errno == ECONNREFUSED || errno == ENOENT; close(fd); return absent ? -2 : -1; }
    struct pollfd connecting = { .fd = fd, .events = POLLOUT };
    int error = 0;
    socklen_t error_size = sizeof(error);
    if (poll(&connecting, 1, 1000) != 1 ||
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &error_size) || error) {
      close(fd); return -1;
    }
  }
#ifdef __APPLE__
  socklen_t size = sizeof(out->token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &out->token, &size) ||
      size != sizeof(out->token) || audit_token_to_euid(out->token) != geteuid() ||
      proc_pidpath_audittoken(&out->token, actual, sizeof(actual)) <= 0) {
    close(fd); return -1;
  }
#else
  struct ucred cred;
  socklen_t size = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &size) || cred.uid != geteuid()) {
    close(fd); return -1;
  }
  size = sizeof(out->pidfd);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, &out->pidfd, &size)) {
    close(fd); return -1;
  }
  out->pid = cred.pid;
  char proc[64];
  snprintf(proc, sizeof(proc), "/proc/%d/exe", cred.pid);
  ssize_t n = readlink(proc, actual, sizeof(actual) - 1);
  if (n <= 0) { close(out->pidfd); close(fd); return -1; }
  actual[n] = 0;
  struct pollfd p = { .fd = out->pidfd, .events = POLLIN };
  if (poll(&p, 1, 0) != 0) { close(out->pidfd); close(fd); return -1; }
#endif
  close(fd);
  if (!realpath(actual, canonical) || strcmp(canonical, exe)) return -1;
  return 0;
}

static int exited(owner *o) {
  if (o->child == -1) return 1;
  if (o->child) {
    int status;
    if (waitpid(o->child, &status, WNOHANG) == o->child) {
      o->child = -1;
      return 1;
    }
    return 0;
  }
#ifdef __APPLE__
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath_audittoken(&o->token, path, sizeof(path)) > 0) return 0;
  return errno == ESRCH;
#else
  struct pollfd p = { .fd = o->pidfd, .events = POLLIN };
  return poll(&p, 1, 0) == 1 && (p.revents & POLLIN);
#endif
}

#ifdef __APPLE__
static int child_token(owner *o) {
  mach_port_t name = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), o->child, &name) != KERN_SUCCESS) return -1;
  mach_msg_type_number_t size = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t result = task_info(name, TASK_AUDIT_TOKEN, (task_info_t)&o->token, &size);
  mach_port_deallocate(mach_task_self(), name);
  return result == KERN_SUCCESS && audit_token_to_pid(o->token) == o->child &&
    audit_token_to_euid(o->token) == geteuid() ? 0 : -1;
}
#endif

static int launch(owner *o, const char *exe, int initialize) {
  pid_t child = fork();
  if (child < 0) return -1;
  if (!child) {
    int empty = open("/dev/null", O_RDWR);
    if (empty < 0) _exit(2);
    for (int i = 0; i < 3; i++) if (dup2(empty, i) < 0) _exit(2);
    if (empty > 2) close(empty);
    if (initialize) execl(exe, exe, "daemon", "start", "--policy", "deny-all", (char *)NULL);
    else execl(exe, exe, "daemon", "start", (char *)NULL);
    _exit(2);
  }
  o->child = child;
#ifndef __APPLE__
  o->pid = child;
  o->pidfd = syscall(SYS_pidfd_open, child, 0);
  if (o->pidfd < 0) return -1;
#endif
  /* The unreaped direct child cannot be recycled while acquiring its kernel identity. */
  long long deadline = milliseconds() + 2000;
  for (;;) {
    if (exited(o)) return -1;
    char actual[PATH_MAX], canonical[PATH_MAX];
#ifdef __APPLE__
    if (child_token(o) == 0 && proc_pidpath_audittoken(&o->token, actual, sizeof(actual)) > 0 &&
        realpath(actual, canonical) && !strcmp(canonical, exe)) return 0;
#else
    char proc[64];
    snprintf(proc, sizeof(proc), "/proc/%d/exe", child);
    ssize_t n = readlink(proc, actual, sizeof(actual) - 1);
    if (n > 0) {
      actual[n] = 0;
      if (realpath(actual, canonical) && !strcmp(canonical, exe)) return 0;
    }
#endif
    if (milliseconds() >= deadline) return -1;
    struct timespec delay = { .tv_nsec = 1000000 };
    nanosleep(&delay, NULL);
  }
}

static int send_signal(owner *o, int sig) {
  if (exited(o)) return 0;
#ifdef __APPLE__
  if (o->child && !exited(o) && child_token(o)) return -1;
  int result = proc_signal_with_audittoken(&o->token, sig);
#else
  int result = syscall(SYS_pidfd_send_signal, o->pidfd, sig, NULL, 0);
#endif
  return result == 0 || errno == ESRCH ? 0 : -1;
}

static int held(owner *o, const char *exe) {
  if (exited(o)) return 0;
  char actual[PATH_MAX], canonical[PATH_MAX];
#ifdef __APPLE__
  if (proc_pidpath_audittoken(&o->token, actual, sizeof(actual)) <= 0) return 0;
#else
  char proc[64];
  snprintf(proc, sizeof(proc), "/proc/%d/exe", o->pid);
  ssize_t n = readlink(proc, actual, sizeof(actual) - 1);
  if (n <= 0) return 0;
  actual[n] = 0;
#endif
  return realpath(actual, canonical) && !strcmp(canonical, exe) && !exited(o);
}

#ifdef __APPLE__
/* Read only argc argv from the held incarnation; never serialize PID, argv or environment. */
static int container_id(owner *o, const char *exe, char output[65]) {
  if (!held(o, exe)) return -1;
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, audit_token_to_pid(o->token) };
  const size_t capacity = 262144;
  size_t size = capacity;
  char *bytes = calloc(size, 1);
  if (!bytes) return -1;
  int result = -1, argc = 0, namespaces = 0, ids = 0, namespace_flags = 0, id_flags = 0;
  if (sysctl(mib, 3, bytes, &size, NULL, 0) || size > capacity || size < sizeof(argc)) goto done;
  memcpy(&argc, bytes, sizeof(argc));
  if (argc < 1 || argc > 128) goto done;
  size_t cursor = sizeof(argc);
  /* KERN_PROCARGS2 prefixes the executable path and zero padding before argv[0]. */
  while (cursor < size && bytes[cursor]) cursor++;
  while (cursor < size && !bytes[cursor]) cursor++;
  const char *previous = NULL;
  for (int index = 0; index < argc; index++) {
    if (cursor >= size) goto done;
    const char *argument = bytes + cursor;
    size_t remaining = size - cursor, length = strnlen(argument, remaining);
    if (length == remaining) goto done;
    if (!strcmp(argument, "-namespace") && ++namespace_flags != 1) goto done;
    if (!strcmp(argument, "-id") && ++id_flags != 1) goto done;
    if (previous && !strcmp(previous, "-namespace")) {
      if (strcmp(argument, "docker") || ++namespaces != 1) goto done;
    }
    if (previous && !strcmp(previous, "-id")) {
      if (length != 64 || strspn(argument, "0123456789abcdef") != 64 || ++ids != 1) goto done;
      memcpy(output, argument, 64); output[64] = 0;
    }
    previous = argument;
    cursor += length + 1;
  }
  if (namespaces == 1 && ids == 1 && namespace_flags == 1 && id_flags == 1 && held(o, exe)) result = 0;
done:
  memset(bytes, 0, capacity);
  free(bytes);
  return result;
}
#endif

static int await_exit(owner *owners, int count, int grace) {
  long long deadline = milliseconds() + grace;
  for (;;) {
    int remaining = 0;
    for (int i = 0; i < count; i++) remaining += !exited(&owners[i]);
    if (!remaining) return 0;
    if (milliseconds() >= deadline) return -1;
    struct timespec delay = { .tv_nsec = 10000000 };
    nanosleep(&delay, NULL);
  }
}

/* Refusal cleanup only: this unreaped child was forked here and cannot be a reused PID. */
static int refuse_child(owner *o) {
  if (o->child <= 0) return 0;
  if (kill(o->child, SIGTERM) && errno != ESRCH) return -1;
  if (!await_exit(o, 1, 3000)) return 0;
  if (kill(o->child, SIGKILL) && errno != ESRCH) return -1;
  return await_exit(o, 1, 3000);
}

/* Persistent gate inode: kernel ownership dies with this child, never unlink the gate. */
static int state_lock(const char *path) {
  char root[PATH_MAX];
  struct stat directory, entry, opened;
  if (!realpath(path, root) || strcmp(root, path) || lstat(root, &directory) ||
      !S_ISDIR(directory.st_mode) || directory.st_uid != geteuid() || (directory.st_mode & 077)) return 2;
  int dir = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (dir < 0) return 2;
  int fd = openat(dir, "runner-gate.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (fd < 0) { close(dir); return 2; }
  if (fstat(fd, &opened) || !S_ISREG(opened.st_mode) || opened.st_nlink != 1 ||
      opened.st_uid != geteuid() || (opened.st_mode & 077) || opened.st_size != 0 ||
      fstatat(dir, "runner-gate.lock", &entry, AT_SYMLINK_NOFOLLOW) ||
      entry.st_dev != opened.st_dev || entry.st_ino != opened.st_ino) {
    close(fd); close(dir); return 2;
  }
  if (flock(fd, LOCK_EX | LOCK_NB)) {
    int busy = errno == EWOULDBLOCK || errno == EAGAIN;
    close(fd); close(dir); return busy ? 5 : 2;
  }
  puts("{\"ready\":true}"); fflush(stdout);
  char command[6] = {0}; size_t size = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, command + size, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { close(fd); close(dir); return 2; }
    if (!count) break; /* Parent death closes the existing input pipe. */
    size++;
    if (size == 5 && !memcmp(command, "stop\n", 5)) break;
    if (size == sizeof(command)) { close(fd); close(dir); return 2; }
  }
  int valid = !size || (size == 5 && !memcmp(command, "stop\n", 5));
  close(fd); close(dir);
  if (!valid) return 2;
  puts("{\"settled\":true}");
  return 0;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc == 3 && !strcmp(argv[1], "--state-lock")) return state_lock(argv[2]);
  int starting = argc == 4 && (!strcmp(argv[1], "--launch") || !strcmp(argv[1], "--initialize"));
  int vm = argc >= 5 && !strcmp(argv[1], "--vm");
  if (vm && argc != 5) return 2;
#ifndef __APPLE__
  /* The pinned Linux worker transport has no observed strong peer-pidfd contract. */
  if (vm) return 2;
#endif
  int base = starting || vm ? 2 : 1;
  if (argc < (vm ? 5 : 4) || argc > (vm ? 36 : 35)) return 2;
  char root[PATH_MAX], exe[PATH_MAX];
  struct stat st;
  if (!realpath(argv[base], root) || strcmp(root, argv[base]) || lstat(root, &st) || !S_ISDIR(st.st_mode) ||
      st.st_uid != geteuid() || (st.st_mode & 077) || !realpath(argv[base + 1], exe) ||
      strcmp(exe, argv[base + 1]) || lstat(exe, &st) || !S_ISREG(st.st_mode) || (st.st_mode & 022)) return 2;
  if (vm) {
    const char suffix[] = "/Contents/MacOS/sbx";
    size_t length = strlen(exe), suffix_length = sizeof(suffix) - 1;
    if (length <= suffix_length || strcmp(exe + length - suffix_length, suffix) || (st.st_uid != geteuid() && st.st_uid != 0)) return 2;
    char worker[PATH_MAX];
    int written = snprintf(worker, sizeof(worker), "%.*s/Contents/Helpers/containerd-shim-nerdbox-v1", (int)(length - suffix_length), exe);
    if (written < 0 || (size_t)written >= sizeof(worker) || !realpath(worker, exe) || strcmp(worker, exe) ||
        lstat(exe, &st) || !S_ISREG(st.st_mode) || (st.st_uid != geteuid() && st.st_uid != 0) || (st.st_mode & 022)) return 2;
  }
  if (starting) {
    const char *home = getenv("HOME"), *namespace = getenv("DOCKER_SANDBOXES_APP_NAME");
    if (!home || strcmp(home, root) || !namespace || strlen(namespace) != 20 ||
        strncmp(namespace, "moira-", 6) || strspn(namespace + 6, "0123456789abcdef") != 14) return 2;
  }
  owner owners[32];
  memset(owners, 0, sizeof(owners));
  int count = starting ? 1 : argc - (vm ? 4 : 3);
  for (int i = 0; vm && i < count; i++) {
    const char *name = strrchr(argv[i + 4], '/');
    if (!name || strlen(++name) != 20 || strspn(name, "0123456789abcdef") != 12 || strcmp(name + 12, "-vm.sock")) return 2;
  }
  if (starting && launch(&owners[0], exe, !strcmp(argv[1], "--initialize"))) {
    if (refuse_child(&owners[0])) return 3;
    return 2;
  }
  for (int i = 0; !starting && i < count; i++) {
    const char *path = argv[i + (vm ? 4 : 3)];
    int result = capture(&owners[i], root, exe, path, vm);
    if (result) {
      for (int known = 0; known < i; known++) if (send_signal(&owners[known], SIGTERM)) return 3;
      if (await_exit(owners, i, 3000)) {
        for (int known = 0; known < i; known++) if (send_signal(&owners[known], SIGKILL)) return 3;
        if (await_exit(owners, i, 3000)) return 3;
      }
      return result == -2 ? 4 : 2;
    }
  }
  char container[65] = {0};
#ifdef __APPLE__
  if (vm && (count != 1 || container_id(&owners[0], exe, container))) {
    if (send_signal(&owners[0], SIGTERM) || await_exit(owners, count, 3000)) {
      if (send_signal(&owners[0], SIGKILL) || await_exit(owners, count, 3000)) return 3;
    }
    return 2;
  }
#endif
  if (vm) printf("{\"ready\":true,\"containerId\":\"%s\"}\n", container);
  else puts("{\"ready\":true}");
  fflush(stdout);
  /* A dead parent closes this pipe. Only fixed check/stop words are admitted. */
  char command[6] = {0};
  size_t n = 0;
  for (;;) {
    int retired = 0;
    for (int i = 0; i < count; i++) retired |= !held(&owners[i], exe);
    if (retired) {
      puts("{\"retired\":true}");
      fflush(stdout);
      n = 0;
      break;
    }
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
    int available = poll(&input, 1, 100);
    if (available < 0 && errno == EINTR) continue;
    if (available < 0) return 3;
    if (!available) continue;
    ssize_t bytes = read(STDIN_FILENO, command + n, 1);
    if (bytes < 0 && errno == EINTR) continue;
    if (bytes <= 0) break;
    n += (size_t)bytes;
    if (command[n - 1] == '\n') {
      if (n == 6 && !memcmp(command, "check\n", 6)) {
        int valid = 1;
        for (int i = 0; i < count; i++) valid &= held(&owners[i], exe);
#ifdef __APPLE__
        if (vm) { char current[65]; valid &= !container_id(&owners[0], exe, current) && !strcmp(current, container); }
#endif
        if (!valid) { puts("{\"retired\":true}"); fflush(stdout); n = 0; break; }
        puts("{\"held\":true}"); fflush(stdout);
        n = 0;
        continue;
      }
      break;
    }
    if (n == sizeof(command)) break;
  }
  int valid = !n || (n == 5 && !memcmp(command, "stop\n", 5));
  for (int i = 0; i < count; i++) if (send_signal(&owners[i], SIGTERM)) return 3;
  if (await_exit(owners, count, 3000)) {
    for (int i = 0; i < count; i++) if (send_signal(&owners[i], SIGKILL)) return 3;
    if (await_exit(owners, count, 3000)) return 3;
  }
  if (valid) puts("{\"settled\":true}");
  return valid ? 0 : 2;
}
